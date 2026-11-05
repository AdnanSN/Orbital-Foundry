import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStationMap,
  type StationEvent,
  type StationEventOf,
  stationEventSchema,
} from "@orbital/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { buildApp } from "../src/http/app";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";

const map = getStationMap();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "station.db");
}

function openServer(file: string, seed = 7): { sim: SimServer; close: () => void } {
  const db = openDb(file);
  const sim = new SimServer({ map, store: new SimStore(db), seed });
  return {
    sim,
    close: () => {
      sim.stop();
      db.close();
    },
  };
}

function run(sim: SimServer, ms: number): StationEvent[] {
  const out: StationEvent[] = [];
  for (let t = 0; t < ms; t += 250) out.push(...sim.tick(250));
  return out;
}

describe("SimServer persistence", () => {
  it("resumes the exact station after a restart", () => {
    const file = tempDb();
    const first = openServer(file);
    expect(first.sim.restored).toBe(false);
    run(first.sim, 90_000);
    first.sim.hire({ name: "Nova", role: "operator", room: "factory-1" });
    run(first.sim, 5_000);
    const before = first.sim.snapshot() as StationEventOf<"snapshot">;
    first.close();

    const second = openServer(file, 123);
    cleanups.push(second.close);
    expect(second.sim.restored).toBe(true);
    const after = second.sim.snapshot() as StationEventOf<"snapshot">;
    expect(after.t).toBe(before.t);
    expect(after.seq).toBe(before.seq);
    expect(after.agents).toEqual(before.agents);
    expect(after.crew).toEqual(before.crew);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.crew.some((c) => c.name === "Nova")).toBe(true);

    // It keeps going with fresh sequence numbers.
    const next = run(second.sim, 10_000);
    expect(next.length).toBeGreaterThan(0);
    expect(next[0]?.seq).toBeGreaterThan(before.seq);
  });

  it("logs every event and keeps tasks and the crew roster in their tables", () => {
    const file = tempDb();
    const { sim, close } = openServer(file);
    cleanups.push(close);
    const events = run(sim, 120_000);
    sim.save();
    const reader = openDb(file);
    cleanups.push(() => {
      reader.close();
    });
    const store = new SimStore(reader);
    expect(store.lastSeq()).toBe(events.at(-1)?.seq);
    expect(store.eventsSince(0, 10).length).toBe(10);
    expect(store.tasks().length).toBeGreaterThan(0);
    expect(store.crew().map((c) => c.id)).toContain("warden");
  });

  it("pauses and changes speed", () => {
    const { sim, close } = openServer(tempDb());
    cleanups.push(close);
    sim.setSim({ paused: true });
    const t = sim.sim.now;
    run(sim, 5_000);
    expect(sim.sim.now).toBe(t);
    sim.setSim({ paused: false, speed: 4 });
    sim.tick(1_000);
    expect(sim.sim.now).toBe(t + 4_000);
    expect(() => sim.setSim({ speed: 100 })).toThrow(/Speed/);
  });
});

class Client {
  readonly events: StationEvent[] = [];
  private waiters: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      const raw = JSON.parse(String(m.data)) as unknown;
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        this.events.push(stationEventSchema.parse(item));
      }
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    return client;
  }

  async waitFor(pred: (e: StationEvent) => boolean, ms = 3_000): Promise<StationEvent> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error("timed out waiting for an event");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
}

async function serve(): Promise<{ app: FastifyInstance; sim: SimServer; base: string }> {
  const { sim, close } = openServer(tempDb());
  const app = await buildApp(sim);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  cleanups.push(async () => {
    await app.close();
    close();
  });
  return { app, sim, base: `127.0.0.1:${port}` };
}

describe("station HTTP and WebSocket API", () => {
  it("sends a snapshot on connect and keeps two clients in sync", async () => {
    const { sim, base } = await serve();
    const a = await Client.connect(`ws://${base}/ws`);
    const b = await Client.connect(`ws://${base}/ws`);
    cleanups.push(
      () => a.ws.close(),
      () => b.ws.close(),
    );
    await a.waitFor((e) => e.type === "snapshot");
    await b.waitFor((e) => e.type === "snapshot");
    const produced = run(sim, 30_000);
    const last = produced.at(-1);
    expect(last).toBeDefined();
    await a.waitFor((e) => e.seq === last?.seq);
    await b.waitFor((e) => e.seq === last?.seq);
    const strip = (c: Client) => c.events.filter((e) => e.type !== "snapshot");
    expect(strip(a)).toEqual(strip(b));
    expect(strip(a)).toEqual(produced);
  });

  it("hires a crew member end to end: REST call, spawn at the airlock, walk to the room", async () => {
    const { sim, base } = await serve();
    const a = await Client.connect(`ws://${base}/ws`);
    cleanups.push(() => a.ws.close());
    await a.waitFor((e) => e.type === "snapshot");
    const res = await fetch(`http://${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nova", role: "forger", room: "factory-3" }),
    });
    expect(res.status).toBe(201);
    const crew = (await res.json()) as { id: string; room: string; workstations: string[] };
    expect(crew.room).toBe("factory-3");
    expect(crew.workstations.length).toBeGreaterThan(0);
    const spawned = (await a.waitFor(
      (e) => e.type === "agent.spawned",
    )) as StationEventOf<"agent.spawned">;
    expect(map.roomAt(spawned.agent.tile.x, spawned.agent.tile.y)?.id).toBe("airlock");
    run(sim, 60_000);
    await a.waitFor((e) => e.type === "agent.moved" && e.id === crew.id);
    const tile = sim.sim.agentState(crew.id).tile;
    expect(["factory-3", "qa-bay", "cafe", undefined]).toContain(map.roomAt(tile.x, tile.y)?.id);
  });

  it("reassigns, pauses, and rejects bad requests with readable errors", async () => {
    const { base } = await serve();
    const a = await Client.connect(`ws://${base}/ws`);
    cleanups.push(() => a.ws.close());
    const patch = await fetch(`http://${base}/api/agents/gift`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: "factory-2" }),
    });
    expect(patch.status).toBe(200);
    await a.waitFor((e) => e.type === "crew.updated" && e.crew.room === "factory-2");

    const pause = await fetch(`http://${base}/api/sim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(pause.status).toBe(200);
    await a.waitFor((e) => e.type === "sim.status" && e.status.paused);

    const bad = await fetch(`http://${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x y z!", role: "operator", room: "factory-1" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Names/);

    const overseer = await fetch(`http://${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Boss", role: "overseer", room: "bridge" }),
    });
    expect(overseer.status).toBe(400);

    const health = (await (await fetch(`http://${base}/api/health`)).json()) as {
      ok: boolean;
      crew: number;
    };
    expect(health).toMatchObject({ ok: true, crew: 9 });
  });
});
