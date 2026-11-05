import {
  type AgentState,
  findPath,
  getStationMap,
  pathDurationMs,
  STARTING_CREW,
  type StationEvent,
  StationSim,
  type Tile,
} from "@orbital/shared";
import { describe, expect, it } from "vitest";

import { World } from "../src/sim/world";

const map = getStationMap();

function agent(id: string, tile: Tile): AgentState {
  return {
    id,
    tile,
    facing: "down",
    activity: "idle",
    carrying: null,
    anchor: null,
    taskId: null,
    status: null,
    since: 0,
  };
}

const snapshot = (seq = 0): StationEvent => ({
  seq,
  t: 0,
  type: "snapshot",
  crew: STARTING_CREW.filter((c) => c.id === "wick"),
  agents: [agent("wick", { x: 3, y: 17 })],
  tasks: [],
  providers: [{ provider: "nvidia", state: "ok", until: null, note: null }],
  sim: { paused: false, speed: 1 },
});

describe("World", () => {
  it("builds its state from a snapshot", () => {
    const w = new World(map);
    w.apply(snapshot());
    expect(w.agents.get("wick")?.state.tile).toEqual({ x: 3, y: 17 });
    expect(w.pose("wick", 0)).toEqual({ x: 3, y: 17, facing: "down", moving: false });
    expect(w.providers.get("nvidia")?.state).toBe("ok");
  });

  it("animates a move along the shared A* path, then faces the way it arrived", () => {
    const w = new World(map);
    w.apply(snapshot());
    const from = { x: 3, y: 17 };
    const to = { x: 9, y: 20 };
    w.apply({ seq: 1, t: 1_000, type: "agent.moved", id: "wick", from, to, t0: 1_000 });
    const path = findPath(map, from, to) as Tile[];
    const end = 1_000 + pathDurationMs(path);
    const mid = w.pose("wick", (1_000 + end) / 2);
    expect(mid?.moving).toBe(true);
    // Mid-walk positions stay on walkable tiles.
    expect(map.isWalkable(Math.round(mid?.x ?? -1), Math.round(mid?.y ?? -1))).toBe(true);
    const done = w.pose("wick", end + 1);
    expect(done).toMatchObject({ x: 9, y: 20, moving: false });
    const last = path[path.length - 1] as Tile;
    const before = path[path.length - 2] as Tile;
    const arrived =
      last.x > before.x ? "right" : last.x < before.x ? "left" : last.y > before.y ? "down" : "up";
    expect(done?.facing).toBe(arrived);

    // An activity with a facing after arrival wins.
    w.apply({
      seq: 2,
      t: end + 10,
      type: "agent.activity",
      id: "wick",
      activity: "work",
      facing: "up",
    });
    expect(w.pose("wick", end + 20)?.facing).toBe("up");
  });

  it("ignores duplicate and stale events, and resets on a new snapshot", () => {
    const w = new World(map);
    w.apply(snapshot(5));
    w.apply({ seq: 4, t: 1, type: "agent.say", id: "wick", text: "old", ttl: 1_000 });
    expect(w.agents.get("wick")?.bubble).toBeNull();
    w.apply({ seq: 6, t: 2, type: "agent.say", id: "wick", text: "new", ttl: 1_000 });
    w.apply({ seq: 6, t: 3, type: "agent.say", id: "wick", text: "again", ttl: 1_000 });
    expect(w.agents.get("wick")?.bubble?.text).toBe("new");
    w.apply(snapshot(10));
    expect(w.agents.get("wick")?.bubble).toBeNull();
  });

  it("counts deliverables waiting on the QA intake, minus the one Lens holds", () => {
    const w = new World(map);
    w.apply(snapshot());
    const task = (id: string, seq: number): StationEvent => ({
      seq,
      t: seq,
      type: "task.updated",
      task: {
        id,
        title: id,
        room: "factory-1",
        assignee: "wick",
        status: "review",
        reworks: 0,
        createdAt: 0,
        updatedAt: seq,
      },
    });
    w.apply(task("T-1", 1));
    w.apply(task("T-2", 2));
    expect(w.intakeCount()).toBe(2);
    w.apply({
      seq: 3,
      t: 3,
      type: "agent.activity",
      id: "wick",
      activity: "review",
      taskId: "T-1",
    });
    expect(w.intakeCount()).toBe(1);
  });

  it("notifies subscribers once per committed batch", () => {
    const w = new World(map);
    let calls = 0;
    w.subscribe(() => {
      calls += 1;
    });
    w.apply(snapshot());
    w.apply({ seq: 1, t: 1, type: "agent.say", id: "wick", text: "hi", ttl: 500 });
    w.commit();
    w.commit();
    expect(calls).toBe(1);
  });

  it("keeps every crew member on walkable ground through a mock run", () => {
    const w = new World(map);
    const d = new StationSim(map, STARTING_CREW, { seed: 3 });
    w.apply(d.snapshot());
    for (let t = 100; t <= 5 * 60_000; t += 100) {
      for (const e of d.advanceTo(t)) w.apply(e);
      if (t % 1_000 !== 0) continue;
      for (const c of STARTING_CREW) {
        const p = w.pose(c.id, t);
        expect(p, c.id).toBeDefined();
        const tile = { x: Math.round(p?.x ?? -1), y: Math.round(p?.y ?? -1) };
        expect(map.isWalkable(tile.x, tile.y), `${c.id} at ${tile.x},${tile.y} t=${t}`).toBe(true);
      }
    }
  });
});
