import { describe, expect, it } from "vitest";
import {
  type CrewMember,
  getStationMap,
  STARTING_CREW,
  type StationEvent,
  type StationEventOf,
  StationSim,
  sameTile,
  stationEventSchema,
} from "../src";

const map = getStationMap();
const MINUTE = 60_000;

function runFor(sim: StationSim, ms: number, step = 250): StationEvent[] {
  const out: StationEvent[] = [];
  const end = sim.now + ms;
  for (let t = sim.now + step; t <= end; t += step) out.push(...sim.advanceTo(t));
  return out;
}

const hire: CrewMember = {
  id: "nova",
  name: "Nova",
  role: "operator",
  title: "Store operator",
  room: "factory-1",
  job: "Runs a fourth store",
  tiers: ["creative", "image"],
  workstations: [],
  look: {
    skin: "#c68a5e",
    hair: "#2b1d3a",
    hairStyle: "bun",
    suit: "#3fb6a8",
    accent: "#ffd166",
    accessory: "none",
  },
};

describe("StationSim snapshot", () => {
  it("includes the crew definitions and the sim status", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 1 });
    const snap = sim.snapshot() as StationEventOf<"snapshot">;
    expect(snap.crew.map((c) => c.id)).toEqual(STARTING_CREW.map((c) => c.id));
    expect(snap.sim).toEqual({ paused: false, speed: 1 });
    expect(() => stationEventSchema.parse(snap)).not.toThrow();
  });
});

describe("StationSim save and restore", () => {
  it("resumes the exact station state", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 5 });
    runFor(sim, 3 * MINUTE);
    const save = JSON.parse(JSON.stringify(sim.save()));
    const restored = StationSim.restore(map, save, { seed: 99 });
    const a = sim.snapshot() as StationEventOf<"snapshot">;
    const b = restored.snapshot() as StationEventOf<"snapshot">;
    expect(b.t).toBe(a.t);
    expect(b.seq).toBe(a.seq);
    expect(b.agents).toEqual(a.agents);
    expect(b.tasks).toEqual(a.tasks);
    expect(b.providers).toEqual(a.providers);
    expect(b.crew).toEqual(a.crew);
  });

  it("keeps going after a restore, with valid events and fresh sequence numbers", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 6 });
    runFor(sim, 2 * MINUTE);
    const save = sim.save();
    const restored = StationSim.restore(map, save, { minSeq: save.seq + 50 });
    const events = runFor(restored, 2 * MINUTE);
    expect(events.length).toBeGreaterThan(20);
    expect(events[0]?.seq).toBe(save.seq + 51);
    for (const e of events) expect(() => stationEventSchema.parse(e)).not.toThrow();
    // Walks start where the restored crew stand.
    const at = new Map(save.agents.map((x) => [x.id, x.tile]));
    for (const e of events) {
      if (e.type !== "agent.moved") continue;
      const from = at.get(e.id);
      if (from) expect(sameTile(e.from, from), e.id).toBe(true);
      at.set(e.id, e.to);
    }
  });
});

describe("StationSim hiring", () => {
  it("spawns a hire at the airlock, who then walks to their room and works", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 2 });
    runFor(sim, 5_000);
    sim.hire(hire);
    const spawned = sim.drain().find((e) => e.type === "agent.spawned");
    expect(spawned?.type).toBe("agent.spawned");
    if (spawned?.type !== "agent.spawned") return;
    expect(spawned.crew.workstations.length).toBeGreaterThan(0);
    expect(map.roomAt(spawned.agent.tile.x, spawned.agent.tile.y)?.id).toBe("airlock");
    const events = runFor(sim, 2 * MINUTE);
    const room = sim.agentState("nova");
    const moves = events.filter((e) => e.type === "agent.moved" && e.id === "nova");
    expect(moves.length).toBeGreaterThan(0);
    const worked = events.some(
      (e) => e.type === "agent.activity" && e.id === "nova" && e.activity === "work" && e.facing,
    );
    expect(worked).toBe(true);
    expect(sim.crew.map((c) => c.id)).toContain("nova");
    expect(room).toBeDefined();
  });

  it("rejects duplicate ids and rooms without workstations", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 2 });
    expect(() => sim.hire({ ...hire, id: "wick" })).toThrow(/already exists/);
    expect(() => sim.hire({ ...hire, room: "cafe" })).toThrow(/no workstations/);
  });
});

describe("StationSim reassign", () => {
  it("moves a crew member to another room and updates their definition", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 3 });
    runFor(sim, 10_000);
    const crew = sim.reassign("gift", "factory-3");
    expect(crew.room).toBe("factory-3");
    const updated = sim.drain().find((e) => e.type === "crew.updated");
    expect(updated?.type === "crew.updated" && updated.crew.room).toBe("factory-3");
    runFor(sim, 90_000);
    const tile = sim.agentState("gift").tile;
    const stillWorking = map.roomAt(tile.x, tile.y)?.id;
    // Gift is in Factory 3, or out on an errand (QA delivery, café) from it.
    expect(["factory-3", "qa-bay", "cafe", undefined]).toContain(stillWorking);
  });
});

describe("StationSim control and commands", () => {
  it("lets the runtime drive a crew member: work, deliver, break, back to autopilot", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 4, mockProviders: false });
    runFor(sim, 5_000);
    sim.control("scout", true);
    sim.command("scout", { kind: "work", status: "Researching niches", taskId: "T-9001" });
    let events = runFor(sim, 20_000);
    const scout = () => sim.agentState("scout");
    expect(scout().activity).toBe("work");
    expect(scout().status).toBe("Researching niches");
    expect(events.some((e) => e.type === "agent.activity" && e.id === "scout" && e.facing)).toBe(
      true,
    );
    // Controlled crew get no new mock tasks; their dropped autopilot task goes back to "assigned".
    const scoutTasks = events.filter(
      (e) => e.type === "task.updated" && e.task.assignee === "scout",
    ) as StationEventOf<"task.updated">[];
    expect(scoutTasks.every((e) => e.task.status === "assigned")).toBe(true);

    sim.command("scout", { kind: "deliver", to: "bridge", item: "datapad", status: "Report" });
    events = runFor(sim, 30_000);
    expect(map.roomAt(scout().tile.x, scout().tile.y)?.id).toBe("bridge");

    sim.command("scout", { kind: "break", status: "Back-off", until: sim.now + 10_000 });
    events = runFor(sim, 40_000);
    expect(map.roomAt(scout().tile.x, scout().tile.y)?.id).toBe("cafe");

    sim.control("scout", false);
    events = runFor(sim, 60_000);
    expect(events.some((e) => e.type === "task.updated" && e.task.assignee === "scout")).toBe(true);
  });

  it("refuses commands for crew on autopilot", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 4 });
    expect(() => sim.command("wick", { kind: "idle" })).toThrow(/autopilot/);
  });

  it("publishes runtime tasks and provider status as events", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 4, mockProviders: false });
    sim.upsertTask({
      id: "T-9002",
      title: "Rank winter niches",
      room: "research",
      assignee: "scout",
      status: "in_progress",
      reworks: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    sim.setProviderStatus("nvidia", "limited", 30_000, "HTTP 429");
    sim.setProviderStatus("nvidia", "limited", 30_000, "HTTP 429"); // no duplicate event
    const events = sim.drain();
    expect(events.map((e) => e.type)).toEqual(["task.updated", "provider.status"]);
    // With mock providers off, the sim invents no rate limits of its own.
    const later = runFor(sim, 10 * MINUTE);
    const invented = later.filter((e) => e.type === "provider.status" && e.status.state !== "ok");
    expect(invented).toEqual([]);
  });
});

describe("finished task history", () => {
  it("keeps real finished tasks while ambient work churns past the ambient cap", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 4, mockProviders: false });
    const base = { room: "factory-1", assignee: "wick", reworks: 0, createdAt: 0, updatedAt: 0 };
    sim.upsertTask({ ...base, id: "P-0001", title: "A listing", status: "done", pipeline: "pod" });
    for (let i = 0; i < 400; i++) {
      sim.upsertTask({ ...base, id: `T-${i}`, title: "Ambient", status: "done", mock: true });
    }
    expect(sim.task("P-0001")?.status).toBe("done");
    expect(sim.task("T-0")).toBeUndefined();
    expect(sim.task("T-399")?.status).toBe("done");
  });
});
