import type { Lane } from "@orbital/shared";
import type Database from "better-sqlite3";

export interface UsageEntry {
  lane: Lane;
  tier?: string;
  provider: string;
  model: string;
  kind: "chat" | "embed" | "image";
  /** "ok" or a failure kind such as "rate-limited". */
  outcome: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Who made the call, e.g. "census:json" or "agent:scout". */
  purpose?: string;
  error?: string;
}

/** Every request a provider actually received. Feeds daily budgets now and the Server Room later. */
export interface UsageLog {
  record(entry: UsageEntry): void;
  countToday(provider: string): number;
}

function todayStartIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export class SqliteUsageLog implements UsageLog {
  private readonly insert: Database.Statement;
  private readonly count: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO llm_calls (ts, lane, tier, provider, model, kind, ok, outcome, latency_ms,
         input_tokens, output_tokens, purpose, error)
       VALUES (@ts, @lane, @tier, @provider, @model, @kind, @ok, @outcome, @latencyMs,
         @inputTokens, @outputTokens, @purpose, @error)`,
    );
    this.count = db.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE provider = ? AND ts >= ?");
  }

  record(entry: UsageEntry): void {
    this.insert.run({
      ts: new Date().toISOString(),
      lane: entry.lane,
      tier: entry.tier ?? null,
      provider: entry.provider,
      model: entry.model,
      kind: entry.kind,
      ok: entry.outcome === "ok" ? 1 : 0,
      outcome: entry.outcome,
      latencyMs: entry.latencyMs ?? null,
      inputTokens: entry.inputTokens ?? null,
      outputTokens: entry.outputTokens ?? null,
      purpose: entry.purpose ?? null,
      error: entry.error?.slice(0, 500) ?? null,
    });
  }

  countToday(provider: string): number {
    const row = this.count.get(provider, todayStartIso()) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

export class MemoryUsageLog implements UsageLog {
  readonly entries: (UsageEntry & { ts: string })[] = [];

  record(entry: UsageEntry): void {
    this.entries.push({ ...entry, ts: new Date().toISOString() });
  }

  countToday(provider: string): number {
    const start = todayStartIso();
    return this.entries.filter((e) => e.provider === provider && e.ts >= start).length;
  }
}
