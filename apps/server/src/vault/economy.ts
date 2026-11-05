import type { Approval, ArtifactMeta, CrewMember, Lane } from "@orbital/shared";
import { z } from "zod";
import type { ModelRouter } from "../llm/router";
import type { PodFactory } from "../pod/factory";
import type { SimServer } from "../sim/simServer";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";
import type { KpiService } from "./kpis";
import type { Ledger } from "./ledger";

/**
 * The learning loop (ROADMAP Stage 10): a weekly retro in which WARDEN reads the numbers and
 * proposes changes (listings per day, experiments on titles, prices and niches, crew moves). The
 * proposal goes to the Owner's Desk; accepting it applies it and saves the lessons to the strategy
 * memory. A week-of-sales simulator lets the loop be tried before real sales exist; its money is
 * flagged as simulated and never counts as real.
 */

export const EXPERIMENT_KINDS = ["price", "title", "niche"] as const;

const retroSchema = z.object({
  summary: z.string().min(10).max(1_200),
  lessons: z.array(z.string().max(240)).max(6).default([]),
  storeChanges: z
    .array(
      z.object({
        store: z.string(),
        listingsPerDay: z.coerce.number().int(),
        reason: z.string().max(240),
      }),
    )
    .max(6)
    .default([]),
  experiments: z
    .array(
      z.object({
        store: z.string(),
        kind: z.enum(EXPERIMENT_KINDS),
        change: z
          .string()
          .max(240)
          .describe(
            "For price: a multiplier such as 0.9 or 1.1. Otherwise: the instruction to try",
          ),
        hypothesis: z.string().max(240),
      }),
    )
    .max(4)
    .default([]),
  crewMoves: z
    .array(z.object({ crew: z.string(), toRoom: z.string(), reason: z.string().max(240) }))
    .max(2)
    .default([]),
});
export type RetroPlan = z.infer<typeof retroSchema>;

export interface Experiment {
  store: string;
  kind: (typeof EXPERIMENT_KINDS)[number];
  change: string;
  hypothesis: string;
  until: string;
  /** Learned from a simulated week. Production acts only on experiments marked false (D-046). */
  simulated?: boolean;
}

export interface EconomyDeps {
  router: ModelRouter;
  store: WorkStore;
  world: SimServer;
  ledger: Ledger;
  kpis: KpiService;
  director: Pick<WorkDirector, "fileDeskItem" | "onDecision">;
  pod: Pick<PodFactory, "businesses" | "settings" | "updateSettings" | "packages">;
  lane: Lane;
  /** Simulated weeks, and plans learned from them (default true). Production turns them off. */
  simulation?: boolean;
  clock?: () => Date;
  log?: (m: string) => void;
}

/** Production refuses simulated sales and retros on them (D-046). */
export class SimulationOffError extends Error {
  constructor() {
    super("Simulated sales are off in production (ORBITAL_MODE=production).");
  }
}

/** A small seeded generator (mulberry32), so a simulated week is repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Economy {
  /** False in production: no simulated weeks, and nothing learned from one steers real work. */
  readonly simulation: boolean;
  private readonly clock: () => Date;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: EconomyDeps) {
    this.simulation = deps.simulation ?? true;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    deps.director.onDecision((a) => this.onDecision(a));
  }

  // -- Experiments ------------------------------------------------------------------------------------

  experiments(store?: string): Experiment[] {
    const all = JSON.parse(this.deps.store.getKv("economy.experiments") ?? "[]") as Experiment[];
    const now = this.clock().toISOString();
    return all.filter(
      (e) =>
        e.until > now &&
        (!store || e.store === store) &&
        // Production follows only what real sales taught; older entries carry no flag (D-046).
        (this.simulation || e.simulated === false),
    );
  }

  /** The price multiplier an active price experiment asks for (1 when none). */
  priceFactor(store: string): number {
    const e = this.experiments(store).find((x) => x.kind === "price");
    const f = e ? Number.parseFloat(e.change) : 1;
    return Number.isFinite(f) && f >= 0.7 && f <= 1.3 ? f : 1;
  }

  /** Extra instructions for the factory's prompts from active title and niche experiments. */
  hints(store: string): { title: string | null; niche: string | null } {
    const ex = this.experiments(store);
    return {
      title: ex.find((e) => e.kind === "title")?.change ?? null,
      niche: ex.find((e) => e.kind === "niche")?.change ?? null,
    };
  }

  // -- The simulator ------------------------------------------------------------------------------------

  /**
   * A week of simulated sales for the listing packages, Fiverr gigs and itch.io packs, written to
   * the ledger as simulated entries. Demand depends on the store, the design's QA score, the price
   * and a fixed per-design appeal, so different stores really do perform differently.
   */
  simulateWeek(seed = 1): { sales: number; revenue: number; days: number } {
    if (!this.simulation) throw new SimulationOffError();
    const rand = rng(seed);
    const end = this.clock();
    const storeBase: Record<string, number> = {};
    for (const b of this.deps.pod.businesses)
      storeBase[b.id] = 0.6 + (hash(b.id + seed) % 100) / 100;
    let sales = 0;
    let revenue = 0;
    const packages = this.deps.pod.packages(undefined, 200).filter((p) => p.review !== "rejected");
    for (let day = 6; day >= 0; day--) {
      const date = new Date(end.getTime() - day * 86_400_000);
      for (const p of packages) {
        const store = String(p.info?.business ?? "");
        const price = Number(p.info?.price ?? 20);
        const qa = Number(p.info?.qa ?? 7);
        const appeal = 0.5 + (hash(p.id) % 100) / 100;
        const views = Math.round((8 + rand() * 30) * (storeBase[store] ?? 1) * appeal);
        const conversion = 0.025 * (qa / 9) * Math.min(1.6, 25 / Math.max(10, price)) * appeal;
        for (let v = 0; v < views; v++) {
          if (rand() >= conversion) continue;
          const ref = `sim:${p.id}:${date.toISOString().slice(0, 10)}:${v}`;
          const cost = -(Number(p.info?.price ?? 20) - Number(p.info?.profit ?? 8)) * 0.8;
          this.deps.ledger.add({
            business: store,
            source: "simulation",
            kind: "sale",
            amount: price,
            ref,
            note: `Simulated sale of ${p.id}`,
            simulated: true,
            at: date.toISOString(),
          });
          this.deps.ledger.add({
            business: store,
            source: "simulation",
            kind: "cost",
            amount: cost,
            ref,
            note: "Simulated production and shipping",
            simulated: true,
            at: date.toISOString(),
          });
          this.deps.ledger.add({
            business: store,
            source: "simulation",
            kind: "fee",
            amount: -(price * 0.095 + 0.25),
            ref,
            note: "Simulated Etsy fees",
            simulated: true,
            at: date.toISOString(),
          });
          sales += 1;
          revenue += price;
        }
      }
      // Factories 2 and 3: a few gig orders and pack sales.
      const gigs = rand() < 0.45 ? 1 : 0;
      for (let g = 0; g < gigs; g++) {
        const price = [15, 30, 55][Math.floor(rand() * 3)] ?? 15;
        const ref = `sim:gig:${date.toISOString().slice(0, 10)}:${g}`;
        this.deps.ledger.add({
          business: "thumbs",
          source: "simulation",
          kind: "sale",
          amount: price,
          ref,
          note: "Simulated Fiverr order",
          simulated: true,
          at: date.toISOString(),
        });
        this.deps.ledger.add({
          business: "thumbs",
          source: "simulation",
          kind: "fee",
          amount: -price * 0.2,
          ref,
          note: "Simulated Fiverr fee (20%)",
          simulated: true,
          at: date.toISOString(),
        });
        sales += 1;
        revenue += price;
      }
      const packsSold = Math.floor(rand() * 3);
      for (let k = 0; k < packsSold; k++) {
        const ref = `sim:pack:${date.toISOString().slice(0, 10)}:${k}`;
        this.deps.ledger.add({
          business: "forge",
          source: "simulation",
          kind: "sale",
          amount: 4,
          ref,
          note: "Simulated itch.io sale",
          simulated: true,
          at: date.toISOString(),
        });
        this.deps.ledger.add({
          business: "forge",
          source: "simulation",
          kind: "fee",
          amount: -0.4,
          ref,
          note: "Simulated itch.io share (10%)",
          simulated: true,
          at: date.toISOString(),
        });
        sales += 1;
        revenue += 4;
      }
    }
    this.deps.store.setKv("economy.simulatedThrough", end.toISOString());
    return { sales, revenue: Math.round(revenue * 100) / 100, days: 7 };
  }

  // -- The weekly retro ---------------------------------------------------------------------------------

  /** WARDEN reads the week and proposes a plan; it goes to the Owner's Desk. */
  async retro(
    opts: { simulated?: boolean } = {},
  ): Promise<{ plan: RetroPlan; artifact: ArtifactMeta }> {
    const simulated = opts.simulated ?? false;
    if (simulated && !this.simulation) throw new SimulationOffError();
    const k = this.deps.kpis.snapshot({ simNow: this.deps.world.sim.now });
    const money = simulated ? k.simulated : k.real;
    const settings = this.deps.pod.businesses.map((b) => ({
      store: b.id,
      name: b.name,
      ...this.deps.pod.settings(b.id),
    }));
    const crew = this.deps.world.sim.crew
      .filter((c: CrewMember) => c.role !== "overseer" && c.role !== "reviewer")
      .map((c) => `${c.id} (${c.role}, ${c.room})`);
    const facts = [
      `Money this week (${simulated ? "SIMULATED" : "real"}): ${JSON.stringify(money.map((m) => ({ business: m.id, sales: m.sales, net: m.net, orders: m.orders, listings: m.listings })))}`,
      `Store settings: ${JSON.stringify(settings)}`,
      `Rooms: ${JSON.stringify(k.rooms)}`,
      `Crew: ${crew.join("; ")}`,
      `Active experiments: ${JSON.stringify(this.experiments())}`,
      `Monthly goal: $${k.month.goal}; real net this month $${k.month.net}.`,
    ].join("\n");
    const res = await this.deps.router.generate({
      tier: "reasoning",
      lane: this.deps.lane,
      schema: retroSchema,
      system: [
        "You are WARDEN, the Overseer. Write this week's retro from the facts only, and propose next week's plan.",
        "Put more listings into stores that convert and fewer into stores that don't (0 to 5 a day each).",
        "Propose at most four experiments on titles, prices (a multiplier from 0.8 to 1.2) or niches, each with a hypothesis you can check next week.",
        "Move at most two crew members to the rooms that need them most, and only operators, thumbnailers or forgers.",
        "Write lessons as short, specific sentences for the strategy memory.",
        "Limits: the stores cannot offer personalization or custom text yet; at most one experiment per store and kind.",
        "Reply with the JSON object alone.",
      ].join("\n"),
      prompt: facts,
      maxTokens: 4_000,
      purpose: "weekly retro",
    });
    const raw = res.data as RetroPlan | undefined;
    if (!raw) throw new Error("No retro plan.");
    const plan = this.clamp(raw);
    const artifact = this.writeRetro(plan, k, simulated);
    this.deps.director.fileDeskItem({
      kind: "deliverable",
      title: `Weekly plan${simulated ? " (from simulated sales)" : ""}: ${plan.storeChanges.length} store change(s), ${plan.experiments.length} experiment(s), ${plan.crewMoves.length} crew move(s)`,
      summary: `${plan.summary.slice(0, 300)} Accept to apply it.`,
      requestedBy: "warden",
      objectiveId: null,
      taskId: null,
      artifactId: artifact.id,
      action: null,
    });
    this.deps.store.setKv(
      "economy.lastRetro",
      JSON.stringify({ at: this.clock().toISOString(), artifact: artifact.id }),
    );
    return { plan, artifact };
  }

  /** Keep the plan inside safe bounds whatever the model said. */
  clamp(plan: RetroPlan): RetroPlan {
    const stores = new Set(this.deps.pod.businesses.map((b) => b.id));
    const movable = new Set(
      this.deps.world.sim.crew
        .filter((c) => ["operator", "thumbnailer", "forger", "researcher"].includes(c.role))
        .map((c) => c.id),
    );
    const rooms = new Set(
      this.deps.world.sim.crew
        .map((c) => c.room)
        .concat(["factory-1", "factory-2", "factory-3", "research"]),
    );
    return {
      ...plan,
      storeChanges: plan.storeChanges
        .filter((c) => stores.has(c.store))
        .map((c) => ({ ...c, listingsPerDay: Math.max(0, Math.min(5, c.listingsPerDay)) })),
      experiments: plan.experiments
        .filter((e) => stores.has(e.store))
        // The stores cannot personalize products yet (no per-order print files).
        .filter(
          (e) => !/personali[sz]|custom (name|text)|monogram/i.test(`${e.change} ${e.hypothesis}`),
        )
        // One experiment per store and kind, so results can be read.
        .filter((e, i, all) => all.findIndex((x) => x.store === e.store && x.kind === e.kind) === i)
        .map((e) => {
          if (e.kind !== "price") return e;
          const f = Number.parseFloat(e.change);
          return { ...e, change: String(Number.isFinite(f) ? Math.max(0.8, Math.min(1.2, f)) : 1) };
        }),
      crewMoves: plan.crewMoves
        .filter((m) => movable.has(m.crew) && rooms.has(m.toRoom))
        .slice(0, 2),
    };
  }

  private writeRetro(
    plan: RetroPlan,
    k: ReturnType<KpiService["snapshot"]>,
    simulated: boolean,
  ): ArtifactMeta {
    const money = simulated ? k.simulated : k.real;
    const md = [
      `**${simulated ? "Simulated week" : "Week"} ending ${this.clock().toDateString()}**${simulated ? " · sales are simulated, not real money" : ""}`,
      "",
      plan.summary,
      "",
      "| Business | Orders | Sales | Net |",
      "|---|---|---|---|",
      ...money.map(
        (m) => `| ${m.name} | ${m.orders} | $${m.sales.toFixed(2)} | $${m.net.toFixed(2)} |`,
      ),
      "",
      "## Proposed changes",
      ...(plan.storeChanges.length
        ? plan.storeChanges.map(
            (c) =>
              `- **${c.store}**: ${this.deps.pod.settings(c.store).listingsPerDay} → ${c.listingsPerDay} listings a day. ${c.reason}`,
          )
        : ["- No store changes."]),
      ...plan.experiments.map(
        (e) => `- **Experiment** (${e.store}, ${e.kind}): ${e.change}. Hypothesis: ${e.hypothesis}`,
      ),
      ...plan.crewMoves.map((m) => `- **Move** ${m.crew} to ${m.toRoom}. ${m.reason}`),
      "",
      plan.lessons.length
        ? `## Lessons for the strategy memory\n${plan.lessons.map((l) => `- ${l}`).join("\n")}`
        : "",
      "",
      "Accept to apply the changes (experiments run for 7 days). Send back to keep things as they are.",
    ].join("\n");
    const id = this.deps.store.nextId("F");
    const meta: ArtifactMeta = {
      id,
      kind: "retro",
      title: `Weekly retro${simulated ? " (simulated)" : ""}: ${this.clock().toDateString()}`,
      mime: "text/markdown",
      taskId: null,
      objectiveId: null,
      createdBy: "warden",
      createdAt: this.deps.world.sim.now,
      size: md.length,
      room: "bridge",
      review: "pending",
      parentId: null,
      info: { plan, simulated },
    };
    this.deps.store.saveArtifact(meta, md);
    this.deps.world.mutate((s) =>
      s.publish({ type: "artifact.created", t: s.now, artifact: meta }),
    );
    return meta;
  }

  private async onDecision(a: Approval): Promise<void> {
    if (a.kind !== "deliverable" || !a.artifactId) return;
    const art = this.deps.store.artifact(a.artifactId);
    if (art?.meta.kind !== "retro") return;
    if (a.status !== "approved") return;
    const plan = art.meta.info?.plan as RetroPlan | undefined;
    if (!plan) return;
    this.apply(plan, Boolean(art.meta.info?.simulated));
  }

  /** Apply an accepted plan: settings, experiments, crew moves, strategy memory. */
  apply(proposed: RetroPlan, simulated: boolean): void {
    // Clamp again at apply time: the stored plan may predate a tighter rule.
    const plan = this.clamp(proposed);
    for (const c of plan.storeChanges)
      this.deps.pod.updateSettings(c.store, { listingsPerDay: c.listingsPerDay });
    const until = new Date(this.clock().getTime() + 7 * 86_400_000).toISOString();
    const active = this.experiments().filter(
      (e) => !plan.experiments.some((x) => x.store === e.store && x.kind === e.kind),
    );
    this.deps.store.setKv(
      "economy.experiments",
      JSON.stringify([...active, ...plan.experiments.map((e) => ({ ...e, until, simulated }))]),
    );
    for (const m of plan.crewMoves) {
      try {
        this.deps.world.reassign(m.crew, m.toRoom);
      } catch (err) {
        this.log(`move ${m.crew} failed: ${String(err)}`);
      }
    }
    for (const lesson of plan.lessons) {
      this.deps.store.saveMemory({
        agentId: "warden",
        scope: "station",
        text: `${simulated ? "(From simulated sales) " : ""}${lesson}`,
        tags: ["retro", "strategy", ...(simulated ? ["simulated"] : [])],
        embedding: null,
      });
    }
    this.deps.world.mutate((s) => {
      const warden = s.crew.find((c) => c.role === "overseer");
      if (warden) s.sayNow(warden.id, "New weekly plan in effect.");
    });
  }

  /** The retro runs itself on Sunday evenings when there are real sales to learn from. */
  tick(): void {
    const now = this.clock();
    if (now.getDay() !== 0 || now.getHours() < 18) return;
    const last = JSON.parse(this.deps.store.getKv("economy.lastRetro") ?? "null") as {
      at: string;
    } | null;
    if (last && now.getTime() - new Date(last.at).getTime() < 6 * 86_400_000) return;
    const real = this.deps.kpis.snapshot({ simNow: this.deps.world.sim.now }).real;
    if (!real.some((m) => m.orders > 0)) return;
    void this.retro().catch((err: unknown) => this.log(`retro failed: ${String(err)}`));
  }
}
