import type Database from "better-sqlite3";

/**
 * The Vault's ledger (ROADMAP Stage 7 records it, Stage 10 reports on it): money in and out per
 * business. Amounts are signed (sales positive; costs, fees and refunds negative), in dollars.
 * A (source, ref, kind) triple is unique, so syncing the same order twice records it once.
 * Simulated entries (dry runs, the sales simulator) are flagged and never mixed into real totals.
 */

export const LEDGER_KINDS = ["sale", "cost", "fee", "refund", "adjustment"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerEntry {
  id: number;
  at: string;
  business: string;
  source: string;
  kind: LedgerKind;
  amount: number;
  currency: string;
  ref: string;
  note: string | null;
  simulated: boolean;
}

export type NewLedgerEntry = Omit<LedgerEntry, "id" | "at" | "currency" | "note" | "simulated"> &
  Partial<Pick<LedgerEntry, "at" | "currency" | "note" | "simulated">>;

interface Row {
  id: number;
  at: string;
  business: string;
  source: string;
  kind: LedgerKind;
  amount: number;
  currency: string;
  ref: string;
  note: string | null;
  simulated: number;
}

function toEntry(r: Row): LedgerEntry {
  return { ...r, simulated: r.simulated === 1 };
}

export class Ledger {
  constructor(private readonly db: Database.Database) {}

  /** Record an entry; returns false when it was already recorded. */
  add(e: NewLedgerEntry): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO ledger (at, business, source, kind, amount, currency, ref, note, simulated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.at ?? new Date().toISOString(),
        e.business,
        e.source,
        e.kind,
        Math.round(e.amount * 100) / 100,
        e.currency ?? "USD",
        e.ref,
        e.note ?? null,
        e.simulated ? 1 : 0,
      );
    return res.changes > 0;
  }

  entries(
    filter: { business?: string; since?: string; simulated?: boolean; limit?: number } = {},
  ): LedgerEntry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.business) {
      where.push("business = ?");
      args.push(filter.business);
    }
    if (filter.since) {
      where.push("at >= ?");
      args.push(filter.since);
    }
    if (filter.simulated !== undefined) {
      where.push("simulated = ?");
      args.push(filter.simulated ? 1 : 0);
    }
    const sql = `SELECT * FROM ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 500) as Row[]).map(toEntry);
  }

  /** Totals per kind for one business (or all), real or simulated money. */
  totals(
    filter: { business?: string; since?: string; simulated?: boolean } = {},
  ): Record<LedgerKind | "net", number> {
    const out = { sale: 0, cost: 0, fee: 0, refund: 0, adjustment: 0, net: 0 };
    for (const e of this.entries({ ...filter, limit: 1_000_000 })) {
      out[e.kind] += e.amount;
      out.net += e.amount;
    }
    for (const k of Object.keys(out) as (keyof typeof out)[])
      out[k] = Math.round(out[k] * 100) / 100;
    return out;
  }
}

/**
 * Idempotent external writes: `once(key, fn)` runs `fn` the first time and returns the stored
 * result afterwards, so retrying an approved publish never creates a second product.
 */
export class Outbox {
  constructor(private readonly db: Database.Database) {}

  get(key: string): unknown | undefined {
    const row = this.db
      .prepare("SELECT result FROM outbox WHERE key = ? AND status = 'done'")
      .get(key) as { result: string | null } | undefined;
    return row ? (row.result ? (JSON.parse(row.result) as unknown) : null) : undefined;
  }

  async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const saved = this.get(key);
    if (saved !== undefined) return saved as T;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO outbox (key, status, created_at, updated_at) VALUES (?, 'running', ?, ?)
         ON CONFLICT (key) DO UPDATE SET status = 'running', updated_at = excluded.updated_at`,
      )
      .run(key, now, now);
    try {
      const result = await fn();
      this.db
        .prepare(
          "UPDATE outbox SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE key = ?",
        )
        .run(JSON.stringify(result ?? null), new Date().toISOString(), key);
      return result;
    } catch (err) {
      this.db
        .prepare("UPDATE outbox SET status = 'failed', error = ?, updated_at = ? WHERE key = ?")
        .run(String(err).slice(0, 1_000), new Date().toISOString(), key);
      throw err;
    }
  }
}
