import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { type Approval, getStationMap } from "@orbital/shared";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { creativeConfigSchema, loadStyles } from "../src/creative/config";
import { basicChecks, pixels } from "../src/creative/raster";
import { CreativeStudio } from "../src/creative/studio";
import { openDb } from "../src/db";
import { type Fixture, FixtureTransport } from "../src/llm/fixtures";
import {
  type Business,
  checkCatalog,
  type EtsyRules,
  loadBusinesses,
  loadEtsyRules,
  loadProducts,
  MOCKUP_KINDS,
  type Product,
} from "../src/pod/config";
import { PodFactory, PUBLISH_TOOL } from "../src/pod/factory";
import {
  clampTitle,
  copyProblems,
  etsyFees,
  fixCopy,
  fullDescription,
  priceFor,
  titleCase,
} from "../src/pod/listing";
import { detailMockup, productMockup } from "../src/pod/mockups";
import { type PrintifyCall, PrintifyClient } from "../src/printify/client";
import { PodPublisher } from "../src/printify/publisher";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import { Ledger, Outbox } from "../src/vault/ledger";
import { WorkStore } from "../src/work/store";
import { makeRouter, provider, tiersWith } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const rules: EtsyRules = loadEtsyRules();
const products = loadProducts();
const businesses = loadBusinesses();

describe("the store and product config", () => {
  it("loads three stores whose products all exist", () => {
    expect(businesses.map((b) => b.id)).toEqual(["store-a", "store-b", "store-c"]);
    expect(checkCatalog(businesses, products)).toEqual([]);
    const styles = loadStyles();
    for (const p of Object.values(products)) expect(styles[p.style]).toBeDefined();
  });
});

describe("listing rules", () => {
  const store = businesses[0] as Business;
  const mug = products["mug-11oz"] as Product;

  it("clamps titles at a word boundary", () => {
    const long = `${"Cozy cabin candle mug ".repeat(8)}gift`;
    const t = clampTitle(long, 140);
    expect(t.length).toBeLessThanOrEqual(140);
    expect(t.endsWith(" ")).toBe(false);
    expect(long.startsWith(t)).toBe(true);
  });

  it("fixes tags: normalized, deduped, shortened, padded to exactly 13", () => {
    const copy = {
      title: "Cozy Pine Cabin Mug, Winter Coffee Mug Gift",
      tags: ["Cozy Mug!", "cozy mug", "personalized winter cabin coffee mug", "pine"],
      description: "x".repeat(80),
    };
    expect(copyProblems(copy, rules, {})).not.toEqual([]);
    const fixed = fixCopy(copy, rules, store.seedTags);
    expect(fixed.tags).toHaveLength(13);
    expect(new Set(fixed.tags).size).toBe(13);
    expect(fixed.tags.every((t) => t.length <= 20 && t === t.toLowerCase())).toBe(true);
    expect(fixed.tags.slice(0, 3)).toEqual(["cozy mug", "cabin coffee mug", "pine"]);
    expect(fixed.title).toBe("Cozy Pine Cabin Mug, Winter Coffee Mug Gift");
    expect(copyProblems(fixed, rules, {})).toEqual([]);
  });

  it("drops an ellipsis and the word it cut from a title", () => {
    expect(clampTitle("First Christmas Dog Mug - Golden Puppy Watercolor, Ceram...", 140)).toBe(
      "First Christmas Dog Mug - Golden Puppy Watercolor",
    );
    expect(clampTitle("Cozy Cabin Mug …", 140)).toBe("Cozy Cabin Mug");
  });

  it("title-cases lower-case titles and leaves deliberate casing alone", () => {
    expect(titleCase("first christmas in new home mug, cozy cottage")).toBe(
      "First Christmas in New Home Mug, Cozy Cottage",
    );
    expect(titleCase("Retro Sunset Mug for DIY Fans")).toBe("Retro Sunset Mug for DIY Fans");
  });

  it("flags protected names in the copy", () => {
    const copy = {
      title: "Grinch mug for christmas",
      tags: ["grinch"],
      description: "y".repeat(80),
    };
    expect(copyProblems(copy, rules, { characters: ["Grinch"] }).at(-1)).toMatch(/Grinch/);
  });

  it("prices from cost plus margin after Etsy fees, ending in the store's cents", () => {
    const p = priceFor(mug, store, rules);
    expect(p.cost).toBeCloseTo(11.2);
    expect(Math.round((p.price % 1) * 100)).toBe(95);
    expect(p.price).toBeGreaterThanOrEqual(store.price.minPrice);
    expect(p.margin).toBeGreaterThanOrEqual(store.price.targetMargin);
    expect(p.fees).toBeCloseTo(etsyFees(p.price, rules), 2);
    // A cent less than the next lower ending would miss the margin.
    const lower = p.price - 1;
    expect((lower - p.cost - etsyFees(lower, rules)) / lower).toBeLessThan(
      store.price.targetMargin,
    );
  });

  it("adds product facts and both disclosures to the description", () => {
    const d = fullDescription(
      { title: "t".repeat(20), tags: [], description: "A calm pine design." },
      store,
      mug,
      rules,
    );
    expect(d).toContain(rules.disclosures.ai);
    expect(d).toContain(rules.disclosures.productionPartner);
    expect(d).toContain("Ceramic mug, 11 oz");
  });
});

describe("mockups", () => {
  it("draws every product kind with the design on it", () => {
    const design = createCanvas(600, 400);
    const ctx = design.getContext("2d");
    ctx.fillStyle = "#c0392b";
    ctx.fillRect(100, 100, 400, 200);
    for (const kind of MOCKUP_KINDS) {
      const m = productMockup(kind, design);
      expect([m.width, m.height]).toEqual([1200, 1200]);
      const p = pixels(m);
      let red = 0;
      for (let i = 0; i < p.data.length; i += 4) {
        if ((p.data[i] ?? 0) > 170 && (p.data[i + 1] ?? 0) < 90 && (p.data[i + 2] ?? 0) < 90)
          red += 1;
      }
      expect(red, kind).toBeGreaterThan(2_000);
    }
    const detail = detailMockup(design, products["mug-11oz"] as Product, "Caption");
    expect(basicChecks(pixels(detail)).blank).toBe(false);
  });
});

// -- The factory end to end, with fixture models and a fake image endpoint ----------------------

const CONCEPT = {
  niche: "Snowy pine cabin evenings",
  concept: "A small log cabin under snowy pines with warm windows, in a soft winter palette",
  product: "mug-11oz",
  keywords: ["cabin mug", "winter mug", "cozy cabin gift"],
  why: "Winter gifting season is close.",
};
const COPY = {
  title: "Snowy Pine Cabin Mug, Cozy Winter Coffee Mug, Cabin Lover Gift, Hygge Mug",
  tags: [
    "cabin mug",
    "winter mug",
    "cozy cabin gift",
    "pine tree mug",
    "hygge mug",
    "snowy cabin",
    "cabin lover gift",
    "winter coffee mug",
    "cozy mug",
    "log cabin decor",
    "mountain cabin",
    "christmas mug gift",
    "rustic mug",
  ],
  description:
    "Warm windows glow under snowy pines on this cozy cabin mug.\n\nMade for slow mornings.\n- Soft winter palette\n- A calm gift",
};
const QA = (score: number) =>
  JSON.stringify({
    score,
    defects: score < 7 ? ["muddy edges"] : [],
    garbledText: false,
    artifacts: false,
    legibility: 8,
    notes: "",
  });

function fixtures(over: { ipRisk?: string; qaScores?: number[] } = {}): Fixture[] {
  const scores = over.qaScores ?? [6, 8, 7, 5];
  return [
    {
      when: { system: "You are Scout, the market researcher" },
      reply: { content: JSON.stringify(CONCEPT) },
    },
    {
      when: { system: "Turn the design concept into" },
      reply: {
        content: JSON.stringify({
          prompts: [
            "a log cabin under pines",
            "a cabin with smoke",
            "pines and a moon",
            "a snowy porch",
          ],
        }),
      },
    },
    { when: { system: "You write Etsy listings" }, reply: { content: JSON.stringify(COPY) } },
    ...scores.map((s) => ({
      when: { system: "image QA reviewer" },
      reply: { content: QA(s) },
      once: true,
    })),
    { when: { system: "image QA reviewer" }, reply: { content: QA(8) } },
    {
      when: { system: "You screen designs" },
      reply: {
        content: JSON.stringify({
          risk: over.ipRisk ?? "none",
          issues: over.ipRisk === "high" ? ["a famous cartoon cabin"] : [],
        }),
      },
    },
  ];
}

function setup(
  fx: Fixture[] = fixtures(),
  now = new Date(2026, 10, 5, 10, 0),
  extra: { imagesReadyAt?: () => number } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-pod-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new WorkStore(db);
  const world = new SimServer({
    map: getStationMap(),
    store: new SimStore(db),
    seed: 2,
    mockProviders: false,
  });
  const transport = new FixtureTransport(fx);
  const { router } = makeRouter({
    providers: { fake: provider("fake", ["sandbox"]) },
    tiers: tiersWith({
      creative: { sandbox: ["fake:big"] },
      vision: { sandbox: ["fake:vl"] },
      fast: { sandbox: ["fake:small"] },
    }),
    transport,
  });
  let n = 0;
  const studio = new CreativeStudio({
    images: {
      generate: async () => {
        n += 1;
        const c = createCanvas(64, 64);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = n % 2 ? "#2d6a4f" : "#9d0208";
        ctx.beginPath();
        ctx.arc(32, 32, 20, 0, Math.PI * 2);
        ctx.fill();
        return {
          bytes: await c.encode("png"),
          mime: "image/png",
          endpoint: "fake",
          provider: "fake",
          latencyMs: 1,
          attempts: [],
        };
      },
    },
    router,
    store,
    dir: path.join(dir, "images"),
    lane: "sandbox",
    config: creativeConfigSchema.parse({ aspects: { "1:1": [64, 64], "4:5": [64, 80] } }),
    styles: loadStyles(),
    blocklist: {},
    now: () => world.sim.now,
  });
  const desk: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  // Small print areas keep the test fast; the real ones are in config/products.yaml.
  const small = Object.fromEntries(
    Object.entries(products).map(([k, p]) => [
      k,
      {
        ...p,
        printArea: [Math.round(p.printArea[0] / 10), Math.round(p.printArea[1] / 10)] as [
          number,
          number,
        ],
      },
    ]),
  );
  const factory = new PodFactory({
    router,
    studio,
    store,
    world,
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
    businesses,
    products: small,
    rules,
    blocklist: {},
    dir: path.join(dir, "packages"),
    lane: "sandbox",
    autopilot: true,
    clock: () => now,
    ...extra,
  });
  const events: string[] = [];
  world.subscribe((batch) => {
    for (const e of batch) events.push(e.type);
  });
  const ledger = new Ledger(db);
  const calls: PrintifyCall[] = [];
  const publisher = new PodPublisher({
    client: new PrintifyClient({ mode: "dry-run", onCall: (c) => calls.push(c) }),
    store,
    studio,
    world,
    ledger,
    outbox: new Outbox(db),
    businesses,
    products: small,
    rules,
    lane: "sandbox",
    shopId: null,
    dailyCap: 1,
    storePaused: (id) => factory.settings(id).paused,
    clock: () => now,
  });
  factory.publisher = publisher;
  return {
    factory,
    store,
    world,
    desk,
    hooks,
    studio,
    transport,
    events,
    publisher,
    ledger,
    calls,
    db,
    small,
  };
}

describe("PodFactory", () => {
  it("runs the §7.1 pipeline into a package on the Owner's Desk", async () => {
    const s = setup();
    const pkg = await s.factory.runListing("store-a");
    // Lens picked the best of four candidates (scores 6, 8, 7, 5).
    expect(pkg.candidates.map((c) => c.score)).toEqual([6, 8, 7, 5]);
    expect(pkg.design).toBe(pkg.candidates[1]?.id);
    expect(pkg.title.length).toBeLessThanOrEqual(140);
    expect(pkg.tags).toHaveLength(13);
    expect(pkg.compliance.ok).toBe(true);
    expect(pkg.compliance.printFile).toMatchObject({ width: 248, height: 116, matches: true });
    expect(pkg.trace.map((t) => t.step)).toEqual([
      "concept",
      "prompts",
      "generate",
      "pick",
      "production",
      "listing",
      "mockups",
      "compliance",
      "package",
    ]);
    const files = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(pkg.zip)))).sort();
    expect(files).toEqual([
      "README.txt",
      "compliance.md",
      "design.png",
      "listing.json",
      "mockup-detail.png",
      "mockup-product.png",
      "print-file.png",
    ]);
    expect(s.desk).toHaveLength(1);
    expect(s.desk[0]).toMatchObject({
      kind: "deliverable",
      artifactId: pkg.id,
      taskId: pkg.taskId,
    });
    expect(s.world.sim.task(pkg.taskId)).toMatchObject({
      status: "done",
      artifactId: pkg.id,
      pipeline: "pod",
    });
    expect(s.factory.countToday("store-a")).toBe(1);
    expect(s.store.artifact(pkg.id)?.content).toContain("![Product mockup](I-");
    s.world.tick(100);
    expect(s.events).toContain("artifact.created");
    expect(s.events).toContain("agent.say");
  });

  it("stops at compliance when the IP screen blocks, and escalates once a day", async () => {
    const s = setup(fixtures({ ipRisk: "high" }));
    await expect(s.factory.runListing("store-a")).rejects.toThrow(/Compliance blocked/);
    expect(s.desk.map((d) => d.kind)).toEqual(["escalation"]);
    expect(s.world.sim.task("P-0001")?.status).toBe("failed");
    await expect(s.factory.runListing("store-a")).rejects.toThrow();
    expect(s.desk).toHaveLength(1);
  });

  it("tries one more round when no candidate passes QA", async () => {
    const s = setup(fixtures({ qaScores: [4, 5, 3, 5, 8] }));
    const pkg = await s.factory.runListing("store-c");
    expect(pkg.candidates).toHaveLength(6);
    expect(pkg.candidates.find((c) => c.id === pkg.design)?.score).toBe(8);
    expect(pkg.product.startsWith("poster")).toBe(true);
  });

  it("acts on the owner's decisions: approve marks it ready, send back starts over", async () => {
    const s = setup();
    const pkg = await s.factory.runListing("store-a");
    const base = { ...(s.desk[0] as Approval), id: "A-1", createdAt: 0, note: null };
    await s.hooks[0]?.({ ...base, status: "approved", decidedAt: 1 });
    expect(s.store.artifact(pkg.id)?.meta.review).toBe("approved");
    await s.hooks[0]?.({ ...base, status: "rejected", decidedAt: 2, note: "Warmer colours" });
    expect(s.factory.isRunning("store-a")).toBe(true);
    const retry = s.world.sim.taskList.find((t) => t.id === "P-0002");
    expect(retry?.brief).toBe("Owner's note: Warmer colours");
  });

  it("still acts on a decision after the task has rotated out of memory", async () => {
    const s = setup();
    const pkg = await s.factory.runListing("store-b");
    const desk = s.desk[0] as Approval;
    await s.hooks[0]?.({
      ...desk,
      id: "A-1",
      taskId: "P-0099",
      status: "rejected",
      createdAt: 0,
      decidedAt: 1,
      note: "Bigger subject",
    });
    expect(s.store.artifact(pkg.id)?.meta.review).toBe("rejected");
    expect(s.factory.isRunning("store-b")).toBe(true);
  });

  it("runs the daily schedule in working hours, one listing at a time", async () => {
    const s = setup();
    s.factory.tick();
    expect(s.factory.isRunning("store-a")).toBe(true);
    s.factory.tick();
    expect(s.world.sim.taskList.filter((t) => t.pipeline === "pod")).toHaveLength(1);
    const night = setup(fixtures(), new Date(2026, 10, 5, 23, 0));
    night.factory.tick();
    expect(night.factory.isRunning("store-a")).toBe(false);
    night.factory.updateSettings("store-a", { paused: true });
    expect(night.factory.settings("store-a")).toEqual({ listingsPerDay: 1, paused: true });
  });

  it("waits for the image budget instead of failing listings while it is spent", () => {
    let readyAt = Date.now() + 3_600_000;
    const s = setup(fixtures(), new Date(2026, 10, 5, 10, 0), { imagesReadyAt: () => readyAt });
    s.factory.tick();
    expect(s.factory.isRunning("store-a")).toBe(false);
    readyAt = 0;
    s.factory.tick();
    expect(s.factory.isRunning("store-a")).toBe(true);
  });

  it("marks listings interrupted by a restart as failed", () => {
    const s = setup();
    s.world.mutate((w) =>
      w.upsertTask({
        id: "P-0009",
        title: "Listing",
        room: "factory-1",
        assignee: "wick",
        status: "in_progress",
        reworks: 0,
        createdAt: 0,
        updatedAt: 0,
        pipeline: "pod",
      }),
    );
    expect(s.factory.recover()).toBe(1);
    expect(s.world.sim.task("P-0009")?.status).toBe("failed");
  });
});

describe("publishing through Printify (Stage 7)", () => {
  async function accepted() {
    const s = setup();
    const pkg = await s.factory.runListing("store-a");
    const deliverable = { ...(s.desk[0] as Approval), id: "A-1", createdAt: 0, note: null };
    await s.hooks[0]?.({ ...deliverable, status: "approved", decidedAt: 1 });
    return { s, pkg };
  }

  it("asks again before publishing, then dry-runs the Printify calls exactly once", async () => {
    const { s, pkg } = await accepted();
    const offer = s.desk.find((d) => d.kind === "action");
    expect(offer?.action?.tool).toBe(PUBLISH_TOOL);
    expect(offer?.title).toMatch(/^Publish \(dry run\)/);
    expect(s.calls).toHaveLength(0);
    const approval = {
      ...(offer as Approval),
      id: "A-2",
      status: "approved" as const,
      createdAt: 0,
      decidedAt: 2,
      note: null,
    };
    await s.hooks[0]?.(approval);
    expect(
      s.calls.map((c) => `${c.method} ${c.path.replace(/dry-product-[0-9a-f]+/, "<id>")}`),
    ).toEqual([
      "POST /uploads/images.json",
      "POST /shops/0/products.json",
      "POST /shops/0/products/<id>/publish.json",
    ]);
    expect(s.calls.every((c) => c.dryRun)).toBe(true);
    const sent = s.calls[1]?.body as {
      title: string;
      tags: string[];
      variants: { price: number }[];
    };
    expect(sent.title).toBe(pkg.title);
    expect(sent.tags).toEqual(pkg.tags);
    expect(sent.variants[0]?.price).toBe(Math.round(pkg.price.price * 100));
    expect(s.publisher.published(pkg.id)?.mode).toBe("dry-run");
    expect(s.store.artifact(pkg.id)?.meta.info?.published).toMatchObject({ mode: "dry-run" });
    expect(s.ledger.entries({ simulated: true }).map((e) => [e.kind, e.amount])).toEqual([
      ["fee", -0.2],
    ]);
    expect(s.ledger.totals({ simulated: false }).net).toBe(0);
    // Approving the same item again changes nothing: it is already published.
    await s.hooks[0]?.(approval);
    expect(s.calls).toHaveLength(3);
    expect(s.desk.at(-1)).toMatchObject({
      kind: "escalation",
      title: expect.stringMatching(/stopped/),
    });
  });

  it("refuses while the kill switch is on, the store is paused, or the daily cap is reached", async () => {
    const { s, pkg } = await accepted();
    s.publisher.setKill(true);
    expect(s.publisher.blockers(pkg.id)).toContain("The station kill switch is on.");
    expect(() => s.factory.start("store-b")).toThrow(/kill switch/);
    s.factory.tick();
    expect(s.factory.isRunning("store-b")).toBe(false);
    await expect(s.publisher.publish(pkg.id, "K-1")).rejects.toThrow(/kill switch/);
    expect(s.calls).toHaveLength(0);
    s.publisher.setKill(false);
    s.factory.updateSettings("store-a", { paused: true });
    expect(s.publisher.blockers(pkg.id)).toEqual(["store-a is paused."]);
    s.factory.updateSettings("store-a", { paused: false });
    await s.publisher.publish(pkg.id, "K-2");
    const second = await s.factory.runListing("store-a");
    s.store.updateArtifact(second.id, { review: "approved" });
    expect(s.publisher.blockers(second.id)).toEqual(["store-a reached today's publish cap (1)."]);
  });

  it("in live mode, sells only live-lane designs with a token, a shop and a mapped product", async () => {
    const { s, pkg } = await accepted();
    const live = new PodPublisher({
      client: new PrintifyClient({ mode: "live" }),
      store: s.store,
      studio: s.studio,
      world: s.world,
      ledger: s.ledger,
      outbox: new Outbox(s.db),
      businesses,
      products: s.small,
      rules,
      lane: "sandbox",
      shopId: null,
      dailyCap: 3,
      storePaused: () => false,
    });
    const blockers = live.blockers(pkg.id).join("\n");
    expect(blockers).toContain("No Printify token");
    expect(blockers).toContain("No Printify shop");
    expect(blockers).toContain("not running in the live lane");
    expect(blockers).toContain("not mapped to a Printify blueprint");
    expect(blockers).toContain("made in the sandbox lane; only live-lane images may be sold");
  });

  it("syncs Printify orders into the ledger once (sale, cost, Etsy fees)", async () => {
    const { s, pkg } = await accepted();
    s.store.setKv(
      `publish.${pkg.id}`,
      JSON.stringify({ mode: "live", productId: "prod-1", at: "x" }),
    );
    const order = {
      id: "ord-1",
      status: "fulfilled",
      created_at: "2026-11-05 12:00:00+00:00",
      line_items: [
        {
          product_id: "prod-1",
          quantity: 2,
          cost: 650,
          shipping_cost: 450,
          metadata: { title: "Mug", price: 1995 },
        },
      ],
    };
    const seen: { url: string; auth: string | null; ua: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        auth: headers.get("authorization"),
        ua: headers.get("user-agent"),
      });
      return new Response(JSON.stringify({ current_page: 1, last_page: 1, data: [order] }));
    }) as typeof fetch;
    const live = new PodPublisher({
      client: new PrintifyClient({ mode: "live", token: "tok-123", fetchImpl }),
      store: s.store,
      studio: s.studio,
      world: s.world,
      ledger: s.ledger,
      outbox: new Outbox(s.db),
      businesses,
      products: s.small,
      rules,
      lane: "live",
      shopId: 42,
      dailyCap: 3,
      storePaused: () => false,
    });
    expect(await live.syncOrders()).toEqual({ added: 1 });
    expect(await live.syncOrders()).toEqual({ added: 0 });
    expect(seen[0]).toEqual({
      url: "https://api.printify.com/v1/shops/42/orders.json?page=1&limit=10",
      auth: "Bearer tok-123",
      ua: "OrbitalFoundry/0.7",
    });
    const t = s.ledger.totals({ business: "store-a", simulated: false });
    expect(t.sale).toBe(39.9);
    expect(t.cost).toBe(-11);
    expect(t.fee).toBeCloseTo(-(39.9 * 0.095 + 0.25), 2);
  });

  it("keeps dry runs and the order sync apart: no orders without a live token", async () => {
    const { s } = await accepted();
    expect(await s.publisher.syncOrders()).toMatchObject({ added: 0 });
  });
});
