import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Approval, getStationMap } from "@orbital/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { type Fixture, FixtureTransport } from "../src/llm/fixtures";
import { loadBusinesses, loadEtsyRules, loadProducts, type Product } from "../src/pod/config";
import { priceFor } from "../src/pod/listing";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import { Economy, SimulationOffError } from "../src/vault/economy";
import { KpiService, loadVaultConfig, vaultConfigSchema } from "../src/vault/kpis";
import { Ledger } from "../src/vault/ledger";
import { WorkStore } from "../src/work/store";
import { makeRouter, provider, tiersWith } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const businesses = loadBusinesses();

const PLAN = {
  summary:
    "Store C converted best; candles were slow. Shift listings to wall art and test lower candle prices.",
  lessons: ["Wall art converts about twice as well as candles.", "Candles over $30 rarely sell."],
  storeChanges: [
    { store: "store-c", listingsPerDay: 9, reason: "Best conversion." },
    { store: "store-a", listingsPerDay: 0, reason: "Slow sales." },
    { store: "store-z", listingsPerDay: 2, reason: "Not a store." },
  ],
  experiments: [
    { store: "store-a", kind: "price", change: "1.5", hypothesis: "Cheaper candles sell more." },
    {
      store: "store-b",
      kind: "title",
      change: "Lead with the recipient: 'Gift for Dog Moms'",
      hypothesis: "Recipient-first titles get more clicks.",
    },
    { store: "store-a", kind: "price", change: "0.9", hypothesis: "Contradicts the first test." },
    {
      store: "store-b",
      kind: "niche",
      change: "Personalized pet name mugs",
      hypothesis: "Names sell.",
    },
  ],
  crewMoves: [
    { crew: "wick", toRoom: "factory-3", reason: "Help the forge." },
    { crew: "lens", toRoom: "factory-2", reason: "Reviewers stay put." },
  ],
};

function setup(
  fx: Fixture[] = [
    {
      when: { system: "You are WARDEN, the Overseer. Write this week" },
      reply: { content: JSON.stringify(PLAN) },
    },
  ],
  opts: { simulation?: boolean } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-vault-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new WorkStore(db);
  const world = new SimServer({
    map: getStationMap(),
    store: new SimStore(db),
    seed: 6,
    mockProviders: false,
  });
  const ledger = new Ledger(db);
  const kpis = new KpiService(db, store, ledger, loadVaultConfig());
  const { router } = makeRouter({
    providers: { fake: provider("fake", ["sandbox"]) },
    tiers: tiersWith({ reasoning: { sandbox: ["fake:big"] } }),
    transport: new FixtureTransport(fx),
  });
  const settings = new Map<string, { listingsPerDay: number; paused: boolean }>();
  const desk: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  const pod = {
    businesses,
    settings: (id: string) => settings.get(id) ?? { listingsPerDay: 1, paused: false },
    updateSettings: (id: string, patch: Partial<{ listingsPerDay: number; paused: boolean }>) => {
      const next = { listingsPerDay: 1, paused: false, ...settings.get(id), ...patch };
      settings.set(id, next);
      return next;
    },
    packages: () => store.findArtifacts({ kind: "listing-package", limit: 100 }),
  };
  const economy = new Economy({
    router,
    store,
    world,
    ledger,
    kpis,
    director: {
      fileDeskItem: (f) => {
        desk.push(f);
        return {
          ...f,
          id: `A-${desk.length}`,
          status: "pending",
          createdAt: 0,
          decidedAt: null,
          note: null,
        };
      },
      onDecision: (hook) => {
        hooks.push(hook);
      },
    },
    pod,
    lane: "sandbox",
    ...(opts.simulation === false ? { simulation: false } : {}),
    clock: () => new Date(2026, 10, 8, 19, 0),
  });
  return { db, store, world, ledger, kpis, economy, desk, hooks, settings };
}

/** A listing package as Factory 1 records it. */
function addPackage(
  s: ReturnType<typeof setup>,
  id: string,
  business: string,
  price: number,
  qa: number,
) {
  s.store.saveArtifact(
    {
      id,
      kind: "listing-package",
      title: id,
      mime: "text/markdown",
      taskId: null,
      objectiveId: null,
      createdBy: "wick",
      createdAt: 0,
      size: 1,
      review: "approved",
      info: { business, price, profit: price * 0.4, qa },
    },
    "x",
  );
}

describe("the Vault's numbers", () => {
  it("keeps real and simulated money apart, per business", () => {
    const s = setup();
    s.ledger.add({
      business: "store-a",
      source: "printify",
      kind: "sale",
      amount: 31.95,
      ref: "o1",
    });
    s.ledger.add({ business: "store-a", source: "printify", kind: "cost", amount: -17, ref: "o1" });
    s.ledger.add({ business: "store-a", source: "etsy", kind: "fee", amount: -3.29, ref: "o1" });
    s.ledger.add({
      business: "store-a",
      source: "simulation",
      kind: "sale",
      amount: 500,
      ref: "s1",
      simulated: true,
    });
    const k = s.kpis.snapshot({ simNow: 0 });
    const a = k.real.find((b) => b.id === "store-a");
    expect(a).toMatchObject({
      sales: 31.95,
      costs: -17,
      fees: -3.29,
      net: 11.66,
      orders: 1,
      room: "factory-1",
    });
    expect(k.simulated.find((b) => b.id === "store-a")?.sales).toBe(500);
    expect(k.month.net).toBe(11.66);
    expect(k.joke.logProgress).toBeGreaterThan(0);
    expect(k.joke.logProgress).toBeLessThan(0.1);
  });

  it("counts throughput, rework and QA per room, and the shadow cost of model calls", () => {
    const s = setup();
    const insert = s.db.prepare(
      "INSERT INTO tasks (id, title, room, assignee, status, reworks, created_at, updated_at, mock) VALUES (?, 't', ?, ?, ?, ?, 0, 100, ?)",
    );
    insert.run("W-1", "factory-1", "wick", "done", 0, 0);
    insert.run("W-2", "factory-1", "wick", "done", 1, 0);
    insert.run("W-3", "factory-1", "gift", "failed", 0, 0);
    insert.run("T-9", "factory-1", "gift", "done", 0, 1); // ambient work is not counted
    s.db
      .prepare(
        "INSERT INTO llm_calls (ts, lane, tier, provider, model, kind, ok, outcome, latency_ms, input_tokens, output_tokens, purpose) VALUES (?, 'sandbox', ?, ?, 'm', ?, 1, 'ok', 10, ?, ?, 'p')",
      )
      .run(new Date().toISOString(), "reasoning", "nvidia", "chat", 1_000_000, 500_000);
    s.db
      .prepare(
        "INSERT INTO llm_calls (ts, lane, tier, provider, model, kind, ok, outcome, latency_ms, purpose) VALUES (?, 'sandbox', NULL, 'cloudflare', 'flux', 'image', 1, 'ok', 10, 'img')",
      )
      .run(new Date().toISOString());
    const k = s.kpis.snapshot({ simNow: 1_000 });
    expect(k.rooms.find((r) => r.room === "factory-1")).toMatchObject({
      done: 2,
      failed: 1,
      reworkRate: 0.333,
    });
    expect(k.crew.find((c) => c.id === "wick")).toMatchObject({ done: 2, reworks: 1 });
    // 1M input at $1 + 0.5M output at $4, plus one image at $0.004.
    expect(k.shadowCost).toBeCloseTo(3.004, 3);
  });

  it("reads the vault config", () => {
    const c = loadVaultConfig();
    expect(c.monthlyGoal).toBeGreaterThan(0);
    expect(c.businesses["store-c"]?.room).toBe("factory-1");
    expect(vaultConfigSchema.parse({}).jokeGoal).toBe(1e12);
  });
});

describe("the learning loop", () => {
  it("simulates a repeatable week of sales, flagged as simulated", () => {
    const a = setup();
    addPackage(a, "F-1", "store-c", 30.99, 10);
    addPackage(a, "F-2", "store-a", 31.95, 9);
    const first = a.economy.simulateWeek(42);
    const b = setup();
    addPackage(b, "F-1", "store-c", 30.99, 10);
    addPackage(b, "F-2", "store-a", 31.95, 9);
    expect(b.economy.simulateWeek(42)).toEqual(first);
    expect(first.sales).toBeGreaterThan(0);
    expect(a.ledger.totals({ simulated: false }).net).toBe(0);
    expect(a.ledger.totals({ simulated: true }).sale).toBeCloseTo(first.revenue, 2);
  });

  it("turns a week into a bounded plan that applies only when the owner accepts it", async () => {
    const s = setup();
    addPackage(s, "F-1", "store-c", 30.99, 10);
    s.economy.simulateWeek(7);
    const { plan, artifact } = await s.economy.retro({ simulated: true });
    // Clamped: at most 5 a day, no unknown stores, price tests within ±20%, reviewers stay.
    expect(plan.storeChanges).toEqual([
      { store: "store-c", listingsPerDay: 5, reason: "Best conversion." },
      { store: "store-a", listingsPerDay: 0, reason: "Slow sales." },
    ]);
    expect(plan.experiments[0]?.change).toBe("1.2");
    // One test per store and kind; nothing the stores cannot deliver (personalization).
    expect(plan.experiments.map((e) => `${e.store}:${e.kind}`)).toEqual([
      "store-a:price",
      "store-b:title",
    ]);
    expect(plan.crewMoves.map((m) => m.crew)).toEqual(["wick"]);
    expect(s.desk[0]?.title).toMatch(/^Weekly plan \(from simulated sales\)/);
    // Nothing changes before the owner accepts.
    expect(s.settings.get("store-c")).toBeUndefined();
    await s.hooks[0]?.({
      ...(s.desk[0] as Approval),
      id: "A-1",
      status: "approved",
      createdAt: 0,
      decidedAt: 1,
      note: null,
      artifactId: artifact.id,
    });
    expect(s.settings.get("store-c")?.listingsPerDay).toBe(5);
    expect(s.settings.get("store-a")?.listingsPerDay).toBe(0);
    expect(s.economy.priceFactor("store-a")).toBe(1.2);
    expect(s.economy.hints("store-b").title).toMatch(/recipient/i);
    expect(s.world.sim.crew.find((c) => c.id === "wick")?.room).toBe("factory-3");
    const lessons = s.store.memories("warden", 20).map((m) => m.text);
    expect(lessons).toContain(
      "(From simulated sales) Wall art converts about twice as well as candles.",
    );
  });

  it("feeds price experiments into the listing price", () => {
    const product = loadProducts()["candle-9oz"] as Product;
    const store = businesses[0];
    if (!store) throw new Error("no store");
    const rules = loadEtsyRules();
    expect(priceFor(product, store, rules, 1.2).price).toBeGreaterThan(
      priceFor(product, store, rules).price,
    );
  });

  it("runs the retro by itself only on Sunday evenings with real sales", () => {
    const s = setup();
    s.economy.tick();
    expect(s.desk).toHaveLength(0); // no real sales yet
  });
});

describe("production (D-046)", () => {
  it("refuses simulated weeks and ignores plans learned from them", () => {
    const s = setup(undefined, { simulation: false });
    expect(() => s.economy.simulateWeek(1)).toThrow(SimulationOffError);
    // One experiment from before the flag existed, one from a simulated week, one from real sales.
    const until = new Date(2026, 10, 20).toISOString();
    s.store.setKv(
      "economy.experiments",
      JSON.stringify([
        { store: "store-a", kind: "title", change: "Lead with the scent", hypothesis: "h", until },
        { store: "store-b", kind: "price", change: "1.1", hypothesis: "h", until, simulated: true },
        {
          store: "store-c",
          kind: "price",
          change: "0.9",
          hypothesis: "h",
          until,
          simulated: false,
        },
      ]),
    );
    expect(s.economy.experiments().map((e) => e.store)).toEqual(["store-c"]);
    expect(s.economy.priceFactor("store-b")).toBe(1);
    expect(s.economy.priceFactor("store-c")).toBe(0.9);
    expect(s.economy.hints("store-a").title).toBeNull();
  });

  it("refuses a retro on simulated sales", async () => {
    const s = setup(undefined, { simulation: false });
    await expect(s.economy.retro({ simulated: true })).rejects.toThrow(SimulationOffError);
  });

  it("marks what a simulated retro sets up, so production can tell it apart", async () => {
    const s = setup();
    s.economy.simulateWeek(3);
    const { artifact } = await s.economy.retro({ simulated: true });
    await s.hooks[0]?.({
      ...(s.desk[0] as Approval),
      id: "A-1",
      status: "approved",
      createdAt: 0,
      decidedAt: 1,
      note: null,
      artifactId: artifact.id,
    });
    const stored = JSON.parse(s.store.getKv("economy.experiments") ?? "[]") as {
      simulated?: boolean;
    }[];
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((e) => e.simulated === true)).toBe(true);
  });
});
