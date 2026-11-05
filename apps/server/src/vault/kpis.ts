import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";
import type { WorkStore } from "../work/store";
import type { Ledger, LedgerKind } from "./ledger";

/**
 * The station's numbers (ROADMAP Stage 10): money per business from the ledger (real and
 * simulated kept apart), KPIs per room and per crew member, and model usage with its shadow cost
 * (what the free calls would cost on paid APIs).
 */

const priceSchema = z.object({ input: z.number().min(0), output: z.number().min(0) });

export const vaultConfigSchema = z.object({
  monthlyGoal: z.number().min(0).default(250),
  jokeGoal: z.number().positive().default(1e12),
  businesses: z.record(z.string(), z.object({ name: z.string(), room: z.string() })).default({}),
  shadowPrices: z
    .object({
      reasoning: priceSchema,
      creative: priceSchema,
      fast: priceSchema,
      vision: priceSchema,
      embed: priceSchema,
      image: z.number().min(0),
    })
    .partial()
    .default({}),
});
export type VaultConfig = z.infer<typeof vaultConfigSchema>;

export function loadVaultConfig(file = path.join(CONFIG_DIR, "vault.yaml")): VaultConfig {
  if (!fs.existsSync(file)) return vaultConfigSchema.parse({});
  return vaultConfigSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
}

export interface BusinessNumbers {
  id: string;
  name: string;
  room: string;
  sales: number;
  costs: number;
  fees: number;
  net: number;
  orders: number;
  listings: number;
}

export interface RoomKpis {
  room: string;
  done: number;
  failed: number;
  reworkRate: number;
  qaPassRate: number | null;
  approvalRate: number | null;
}

export interface CrewKpis {
  id: string;
  done: number;
  failed: number;
  reworks: number;
}

export interface UsageRow {
  provider: string;
  tier: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  shadowCost: number;
}

export interface Kpis {
  since: string;
  real: BusinessNumbers[];
  simulated: BusinessNumbers[];
  month: { net: number; goal: number; progress: number };
  joke: { goal: number; logProgress: number };
  rooms: RoomKpis[];
  crew: CrewKpis[];
  usage: UsageRow[];
  shadowCost: number;
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export class KpiService {
  constructor(
    private readonly db: Database.Database,
    private readonly store: WorkStore,
    private readonly ledger: Ledger,
    private readonly config: VaultConfig,
  ) {}

  /** Money per business since `since` (ISO), real or simulated. */
  business(since: string, simulated: boolean): BusinessNumbers[] {
    const entries = this.ledger.entries({ since, simulated, limit: 1_000_000 });
    const packages = this.store.findArtifacts({ kind: "listing-package", limit: 5_000 });
    const ids = new Set([
      ...Object.keys(this.config.businesses),
      ...entries.map((e) => e.business),
    ]);
    return [...ids].map((id) => {
      const mine = entries.filter((e) => e.business === id);
      const sum = (kinds: LedgerKind[]) =>
        round(mine.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + e.amount, 0));
      const meta = this.config.businesses[id];
      return {
        id,
        name: meta?.name ?? id,
        room: meta?.room ?? "unknown",
        sales: sum(["sale"]),
        costs: sum(["cost"]),
        fees: sum(["fee"]),
        net: sum(["sale", "cost", "fee", "refund", "adjustment"]),
        orders: new Set(mine.filter((e) => e.kind === "sale").map((e) => e.ref)).size,
        listings: packages.filter((p) => p.info?.business === id).length,
      };
    });
  }

  rooms(sinceSim: number): { rooms: RoomKpis[]; crew: CrewKpis[] } {
    const rows = this.db
      .prepare(
        "SELECT room, assignee, status, reworks FROM tasks WHERE (mock IS NULL OR mock = 0) AND updated_at >= ?",
      )
      .all(sinceSim) as { room: string; assignee: string; status: string; reworks: number }[];
    const images = this.store.findArtifacts({ kind: "image", limit: 5_000 });
    const approvals = this.store.approvals(undefined, 5_000).filter((a) => a.status !== "pending");
    const roomIds = new Set([
      ...rows.map((r) => r.room),
      ...Object.values(this.config.businesses).map((b) => b.room),
    ]);
    const rooms: RoomKpis[] = [...roomIds].map((room) => {
      const mine = rows.filter((r) => r.room === room);
      const finished = mine.filter((r) => r.status === "done" || r.status === "failed");
      const qa = images.filter(
        (i) => i.room === room && i.info?.qa && typeof i.info.qa === "object",
      );
      const passed = qa.filter(
        (i) => (i.info?.qa as { pass?: boolean } | undefined)?.pass === true,
      ).length;
      const crewInRoom = new Set(mine.map((r) => r.assignee));
      const decided = approvals.filter((a) => crewInRoom.has(a.requestedBy) && a.kind !== "action");
      return {
        room,
        done: mine.filter((r) => r.status === "done").length,
        failed: mine.filter((r) => r.status === "failed").length,
        reworkRate: finished.length
          ? round(finished.filter((r) => r.reworks > 0).length / finished.length, 3)
          : 0,
        qaPassRate: qa.length ? round(passed / qa.length, 3) : null,
        approvalRate: decided.length
          ? round(decided.filter((a) => a.status === "approved").length / decided.length, 3)
          : null,
      };
    });
    const crewIds = new Set(rows.map((r) => r.assignee));
    const crew: CrewKpis[] = [...crewIds].map((id) => {
      const mine = rows.filter((r) => r.assignee === id);
      return {
        id,
        done: mine.filter((r) => r.status === "done").length,
        failed: mine.filter((r) => r.status === "failed").length,
        reworks: mine.reduce((s, r) => s + r.reworks, 0),
      };
    });
    return {
      rooms: rooms.sort((a, b) => b.done - a.done),
      crew: crew.sort((a, b) => b.done - a.done),
    };
  }

  usage(since: string): UsageRow[] {
    const rows = this.db
      .prepare(
        `SELECT provider, COALESCE(tier, kind) AS tier, COUNT(*) AS calls, SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS failures,
           COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
           SUM(CASE WHEN kind = 'image' AND ok = 1 THEN 1 ELSE 0 END) AS images
         FROM llm_calls WHERE ts >= ? GROUP BY provider, COALESCE(tier, kind) ORDER BY calls DESC`,
      )
      .all(since) as {
      provider: string;
      tier: string;
      calls: number;
      failures: number;
      input_tokens: number;
      output_tokens: number;
      images: number;
    }[];
    const prices = this.config.shadowPrices;
    return rows.map((r) => {
      const p = prices[r.tier as keyof typeof prices];
      const tokenCost =
        p && typeof p === "object"
          ? (r.input_tokens * p.input + r.output_tokens * p.output) / 1_000_000
          : 0;
      const imageCost = r.images * (prices.image ?? 0);
      return {
        provider: r.provider,
        tier: r.tier,
        calls: r.calls,
        failures: r.failures,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        shadowCost: round(tokenCost + imageCost, 4),
      };
    });
  }

  /** Everything the Vault panel shows. `sinceSim` is sim time for task KPIs. */
  snapshot(opts: { days?: number; simNow: number }): Kpis {
    const days = opts.days ?? 7;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthNet = round(
      this.ledger.totals({ since: monthStart.toISOString(), simulated: false }).net,
    );
    const allTimeNet = Math.max(0, this.ledger.totals({ simulated: false }).net);
    const { rooms, crew } = this.rooms(opts.simNow - days * 86_400_000);
    const usage = this.usage(since);
    return {
      since,
      real: this.business(since, false),
      simulated: this.business(since, true),
      month: {
        net: monthNet,
        goal: this.config.monthlyGoal,
        progress:
          this.config.monthlyGoal > 0
            ? round(Math.max(0, monthNet) / this.config.monthlyGoal, 3)
            : 0,
      },
      joke: {
        goal: this.config.jokeGoal,
        logProgress: round(Math.log10(1 + allTimeNet) / Math.log10(1 + this.config.jokeGoal), 4),
      },
      rooms,
      crew,
      usage,
      shadowCost: round(
        usage.reduce((s, u) => s + u.shadowCost, 0),
        4,
      ),
    };
  }
}
