import {
  findPath,
  getStationMap,
  OVERSEER_ID,
  pathDurationMs,
  STARTING_CREW,
  type StationEvent,
  type StationEventOf,
  sameTile,
  stationEventSchema,
  type Tile,
} from "@orbital/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING, MockDirector } from "../src/mock/director";

const map = getStationMap();
const MINUTE = 60_000;

function run(seed: number, minutes: number, stepMs = 250): StationEvent[] {
  const d = new MockDirector(map, STARTING_CREW, { seed });
  const events: StationEvent[] = [d.snapshot()];
  for (let t = stepMs; t <= minutes * MINUTE; t += stepMs) events.push(...d.advanceTo(t));
  return events;
}

const of = <T extends StationEvent["type"]>(events: StationEvent[], type: T) =>
  events.filter((e): e is StationEventOf<T> => e.type === type);

describe("MockDirector", () => {
  const events = run(7, 20);

  it("opens with a snapshot of all nine crew at their home workstations", () => {
    const snap = events[0];
    if (snap?.type !== "snapshot") throw new Error("first event is not a snapshot");
    expect(snap.agents.map((a) => a.id)).toEqual(STARTING_CREW.map((c) => c.id));
    for (const c of STARTING_CREW) {
      const home = map.anchor(c.workstations[0] as string);
      const agent = snap.agents.find((a) => a.id === c.id);
      expect(agent?.tile).toEqual({ x: home.x, y: home.y });
    }
  });

  it("emits valid station events in time and sequence order", () => {
    let lastSeq = -1;
    let lastT = Number.NEGATIVE_INFINITY;
    for (const e of events) {
      expect(() => stationEventSchema.parse(e)).not.toThrow();
      if (e.type !== "snapshot") expect(e.seq).toBe(lastSeq + 1);
      lastSeq = e.seq;
      expect(e.t).toBeGreaterThanOrEqual(lastT);
      lastT = e.t;
    }
  });

  it("is deterministic for a seed", () => {
    expect(run(7, 3)).toEqual(run(7, 3));
    expect(run(8, 3)).not.toEqual(run(7, 3));
  });

  it("does not depend on how often it is advanced", () => {
    const coarse = run(11, 4, 1_000);
    const fine = run(11, 4, 50);
    expect(coarse.filter((e) => e.t <= 3.9 * MINUTE)).toEqual(
      fine.filter((e) => e.t <= 3.9 * MINUTE),
    );
  });

  it("only walks routes that exist, from where the agent stands, one walk at a time", () => {
    const snap = events[0] as StationEventOf<"snapshot">;
    const at = new Map(snap.agents.map((a) => [a.id, a.tile]));
    const busyUntil = new Map<string, number>();
    for (const e of of(events, "agent.moved")) {
      expect(sameTile(e.from, at.get(e.id) as Tile), `${e.id} at ${e.t}`).toBe(true);
      expect(e.t0).toBeGreaterThanOrEqual(busyUntil.get(e.id) ?? 0);
      const path = findPath(map, e.from, e.to);
      expect(path, `${e.id} ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`).not.toBeNull();
      at.set(e.id, e.to);
      busyUntil.set(e.id, e.t0 + pathDurationMs(path as Tile[]));
    }
  });

  it("never parks two crew members on the same tile", () => {
    const snap = events[0] as StationEventOf<"snapshot">;
    const tile = new Map(snap.agents.map((a) => [a.id, a.tile]));
    const arrive = new Map<string, number>(snap.agents.map((a) => [a.id, 0]));
    for (const e of of(events, "agent.moved")) {
      const path = findPath(map, e.from, e.to) as Tile[];
      tile.set(e.id, e.to);
      arrive.set(e.id, e.t0 + pathDurationMs(path));
      // Everyone whose destination is this tile must be the mover itself.
      for (const [id, t] of tile) {
        if (id !== e.id) expect(sameTile(t, e.to), `${e.id} and ${id} at ${e.t}`).toBe(false);
      }
    }
  });

  it("works at consoles: crew walk to their workstations and type there", () => {
    const work = of(events, "agent.activity").filter((e) => e.activity === "work" && e.facing);
    for (const c of STARTING_CREW) {
      expect(
        work.some((e) => e.id === c.id),
        c.id,
      ).toBe(true);
    }
    const tasks = of(events, "task.updated");
    expect(tasks.some((e) => e.task.status === "in_progress")).toBe(true);
  });

  it("delivers to the QA Bay, where Lens reviews and passes or sends back work", () => {
    const drops = new Set(map.anchorsFor("deliver", "qa-bay").map((a) => `${a.x},${a.y}`));
    const toQa = of(events, "agent.moved").filter((e) => drops.has(`${e.to.x},${e.to.y}`));
    expect(toQa.some((e) => e.id !== "lens")).toBe(true);
    const carried = of(events, "agent.activity").filter(
      (e) => e.activity === "deliver" && e.carrying === "crate",
    );
    expect(carried.length).toBeGreaterThan(3);

    const statuses = of(events, "task.updated").map((e) => e.task.status);
    expect(statuses).toContain("review");
    expect(statuses).toContain("done");
    const reviews = of(events, "agent.activity").filter(
      (e) => e.id === "lens" && e.activity === "review",
    );
    expect(reviews.length).toBeGreaterThan(0);

    // Rework is capped at two rounds (ROADMAP §6).
    for (const e of of(events, "task.updated")) expect(e.task.reworks).toBeLessThanOrEqual(2);
  });

  it("keeps the QA intake from piling up", () => {
    const waiting = new Set<string>();
    let peak = 0;
    for (const e of of(events, "task.updated")) {
      if (e.task.status === "review") waiting.add(e.task.id);
      else waiting.delete(e.task.id);
      peak = Math.max(peak, waiting.size);
    }
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("sends rate-limited crew to the café for coffee, then back to work", () => {
    const limited = of(events, "provider.status").filter((e) => e.status.state === "limited");
    expect(limited.length).toBeGreaterThan(0);
    const cafe = new Set(map.anchors.filter((a) => a.room === "cafe").map((a) => `${a.x},${a.y}`));
    const coffee = of(events, "agent.activity").filter((e) => e.activity === "coffee");
    expect(coffee.some((e) => e.carrying === "cup")).toBe(true);
    const walkers = new Set(coffee.map((e) => e.id));
    const intoCafe = of(events, "agent.moved").filter(
      (e) => walkers.has(e.id) && cafe.has(`${e.to.x},${e.to.y}`),
    );
    expect(intoCafe.length).toBeGreaterThan(0);

    // Someone who took a break is later back at work.
    const someone = intoCafe[0] as StationEventOf<"agent.moved">;
    const later = of(events, "agent.activity").filter(
      (e) => e.id === someone.id && e.t > someone.t && e.activity === "work",
    );
    expect(later.length).toBeGreaterThan(0);

    // Limits clear again.
    const recovered = of(events, "provider.status").filter((e) => e.status.state === "ok");
    expect(recovered.length).toBeGreaterThan(0);
  });

  it("has WARDEN patrol the station and nudge idle crew back to work", () => {
    const patrolPoints = new Set(map.anchorsFor("patrol").map((a) => a.room));
    const visited = new Set<string>();
    for (const e of of(events, "agent.moved")) {
      if (e.id !== OVERSEER_ID) continue;
      const room = map.roomAt(e.to.x, e.to.y);
      if (room && patrolPoints.has(room.id)) visited.add(room.id);
    }
    expect(visited.size).toBeGreaterThanOrEqual(5);

    const nudges = of(events, "agent.activity").filter(
      (e) => e.id === OVERSEER_ID && e.activity === "nudge",
    );
    expect(nudges.length).toBeGreaterThan(0);
    const said = of(events, "agent.say").filter((e) => e.id === OVERSEER_ID);
    expect(said.some((e) => /back to work|new task|got a job/i.test(e.text))).toBe(true);

    // The nudged crew member answers and gets going within a few seconds.
    const nudge = nudges[0] as StationEventOf<"agent.activity">;
    const target = STARTING_CREW.find((c) => nudge.status?.includes(c.name));
    expect(target).toBeDefined();
    const resumed = of(events, "agent.activity").find(
      (e) => e.id === target?.id && e.t > nudge.t && e.activity === "work",
    );
    expect(resumed).toBeDefined();
    expect((resumed?.t ?? Number.POSITIVE_INFINITY) - nudge.t).toBeLessThan(10_000);
  });

  it("keeps idle crew waiting no longer than the idle limit", () => {
    // Count from arrival at the idle spot: the idle event that sets a facing.
    const settled = new Map<string, number>();
    let checked = 0;
    for (const e of of(events, "agent.activity")) {
      if (e.activity === "idle") {
        if (e.facing && !settled.has(e.id)) settled.set(e.id, e.t);
      } else {
        const start = settled.get(e.id);
        if (start !== undefined) {
          expect(e.t - start, e.id).toBeLessThan(DEFAULT_TIMING.idleMaxMs + 5_000);
          settled.delete(e.id);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
