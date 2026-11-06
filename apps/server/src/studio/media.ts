import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import YAML from "yaml";
import { z } from "zod";
import { ProviderGate } from "../llm/rateLimiter";
import { CONFIG_DIR } from "../paths";

/**
 * The studio's media providers (D-050): the same lane rule as the model router. A provider serves
 * the live lane only with `production: allowed`; every call goes through a gate and lands in
 * `media_calls` with the units it used (characters, credits, requests, seconds).
 */

export const MEDIA_KINDS = [
  "tts",
  "stt",
  "stock",
  "image",
  "video",
  "music",
  "sfx",
  "render",
  "signals",
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaLane = "sandbox" | "live";

const providerSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(MEDIA_KINDS),
    lanes: z.array(z.enum(["sandbox", "live"])).min(1),
    production: z.enum(["allowed", "forbidden", "unverified"]),
    termsChecked: z.union([z.string(), z.date()]).optional(),
    licence: z.string().min(1),
    local: z.boolean().default(false),
    apiKeyEnv: z.string().optional(),
    limits: z
      .object({
        rpm: z.number().int().positive(),
        rpd: z.number().int().positive().optional(),
        concurrency: z.number().int().positive().default(1),
      })
      .optional(),
    budget: z
      .object({
        unit: z.string().min(1),
        monthly: z.number().positive().optional(),
        daily: z.number().positive().optional(),
      })
      .optional(),
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((p) => !p.lanes.includes("live") || p.production === "allowed", {
    message: "a provider in the live lane needs production: allowed (D-050)",
  })
  // Hunyuan's licence excludes the EU, the UK and South Korea, so its models never go live (D-060).
  .refine((p) => !p.lanes.includes("live") || !/hunyuan/i.test(`${p.name} ${p.licence}`), {
    message: "Hunyuan-based models may not serve the live lane (D-060)",
  });

export const mediaConfigSchema = z.object({ providers: z.record(z.string(), providerSchema) });
export type MediaConfig = z.infer<typeof mediaConfigSchema>;
export type MediaProvider = z.infer<typeof providerSchema>;

export function loadMediaConfig(file = path.join(CONFIG_DIR, "media.yaml")): MediaConfig {
  return mediaConfigSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")));
}

export class MediaLaneError extends Error {
  constructor(provider: string, lane: MediaLane) {
    super(`${provider} may not serve the ${lane} lane (config/media.yaml, D-050).`);
  }
}

export class MediaBudgetError extends Error {}

export interface MediaCall {
  provider: string;
  kind: MediaKind;
  lane: MediaLane;
  units?: number;
  unit?: string;
  ms?: number;
  ok: boolean;
  error?: string;
  ref?: string;
}

/** The `media_calls` log, and what each provider used this month or today. */
export class MediaUsage {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  record(call: MediaCall): void {
    this.db
      .prepare(
        `INSERT INTO media_calls (ts, provider, kind, lane, units, unit, ms, ok, error, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date(this.now()).toISOString(),
        call.provider,
        call.kind,
        call.lane,
        call.units ?? 0,
        call.unit ?? null,
        call.ms ?? null,
        call.ok ? 1 : 0,
        call.error?.slice(0, 500) ?? null,
        call.ref ?? null,
      );
  }

  /** Units used since the first of this month (UTC). */
  monthUnits(provider: string): number {
    const d = new Date(this.now());
    const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    return this.sum(provider, since);
  }

  /** Units used since 00:00 UTC today. */
  dayUnits(provider: string): number {
    const d = new Date(this.now());
    const since = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    ).toISOString();
    return this.sum(provider, since);
  }

  callsToday(provider: string): number {
    const d = new Date(this.now());
    const since = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    ).toISOString();
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM media_calls WHERE provider = ? AND ts >= ?")
      .get(provider, since) as { n: number };
    return row.n;
  }

  private sum(provider: string, since: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(units), 0) AS u FROM media_calls WHERE provider = ? AND ok = 1 AND ts >= ?",
      )
      .get(provider, since) as { u: number };
    return row.u;
  }
}

/** Lanes, keys, gates and budgets for every media provider. */
export class MediaHub {
  private readonly gates = new Map<string, ProviderGate>();

  constructor(
    readonly config: MediaConfig,
    readonly usage: MediaUsage,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  provider(id: string): MediaProvider {
    const p = this.config.providers[id];
    if (!p) throw new Error(`Unknown media provider: ${id}`);
    return p;
  }

  has(id: string): boolean {
    return id in this.config.providers;
  }

  /** Whether `id` may serve `lane` and has the key it needs. */
  available(id: string, lane: MediaLane): boolean {
    if (!this.has(id)) return false;
    const p = this.provider(id);
    if (!p.lanes.includes(lane)) return false;
    if (lane === "live" && p.production !== "allowed") return false;
    return !p.apiKeyEnv || Boolean(this.key(id));
  }

  assertLane(id: string, lane: MediaLane): void {
    const p = this.provider(id);
    if (!p.lanes.includes(lane) || (lane === "live" && p.production !== "allowed")) {
      throw new MediaLaneError(id, lane);
    }
  }

  key(id: string): string | undefined {
    const name = this.provider(id).apiKeyEnv;
    const value = name ? this.env[name]?.trim() : undefined;
    return value || undefined;
  }

  /** A setting from config/media.yaml, or the fallback. */
  setting<T>(id: string, name: string, fallback: T): T {
    const value = this.provider(id).settings[name];
    return (value === undefined ? fallback : value) as T;
  }

  /** The first environment variable in `settings[name]` (a name or a list) that is set. */
  envSetting(id: string, name: string): string | undefined {
    const names = this.setting<string | string[]>(id, name, []);
    for (const n of Array.isArray(names) ? names : [names]) {
      const value = this.env[n]?.trim();
      if (value) return value;
    }
    return undefined;
  }

  /** Units left this month under our own budget (Infinity without one). */
  monthlyLeft(id: string): number {
    const monthly = this.provider(id).budget?.monthly;
    return monthly === undefined ? Number.POSITIVE_INFINITY : monthly - this.usage.monthUnits(id);
  }

  gate(id: string): ProviderGate | null {
    const limits = this.provider(id).limits;
    if (!limits) return null;
    let gate = this.gates.get(id);
    if (!gate) {
      gate = new ProviderGate(id, limits, this.usage.callsToday(id));
      this.gates.set(id, gate);
    }
    return gate;
  }

  /** Runs one provider call through its gate and logs it, failed or not. */
  async run<T>(
    id: string,
    lane: MediaLane,
    work: () => Promise<{ value: T; units?: number; unit?: string; ref?: string }>,
  ): Promise<T> {
    this.assertLane(id, lane);
    const release = (await this.gate(id)?.acquire()) ?? (() => {});
    const started = Date.now();
    const kind = this.provider(id).kind;
    try {
      const out = await work();
      this.usage.record({
        provider: id,
        kind,
        lane,
        ok: true,
        ms: Date.now() - started,
        ...(out.units === undefined ? {} : { units: out.units }),
        unit: out.unit ?? this.provider(id).budget?.unit ?? "calls",
        ...(out.ref ? { ref: out.ref } : {}),
      });
      return out.value;
    } catch (err) {
      this.usage.record({
        provider: id,
        kind,
        lane,
        ok: false,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      release();
    }
  }
}
