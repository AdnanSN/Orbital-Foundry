import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * The clip library (Stage 14): every downloaded or generated asset with its source, licence and
 * credit, reused before anything new is fetched. A size cap clears the least recently used files.
 */

export type AssetKind = "video" | "image" | "audio";

export interface Asset {
  id: string;
  kind: AssetKind;
  source: string;
  sourceId?: string;
  title?: string;
  tags: string[];
  licence: string;
  /** Text for the video description; empty when the licence asks for none. */
  credit: string;
  url?: string;
  path: string;
  bytes?: number;
  duration?: number;
  width?: number;
  height?: number;
  uses: number;
  createdAt: string;
  lastUsedAt?: string;
}

interface Row {
  id: string;
  kind: AssetKind;
  source: string;
  source_id: string | null;
  title: string | null;
  tags: string;
  licence: string;
  credit: string;
  url: string | null;
  path: string;
  bytes: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  uses: number;
  created_at: string;
  last_used_at: string | null;
}

function fromRow(r: Row): Asset {
  return {
    id: r.id,
    kind: r.kind,
    source: r.source,
    ...(r.source_id ? { sourceId: r.source_id } : {}),
    ...(r.title ? { title: r.title } : {}),
    tags: r.tags.split(" ").filter(Boolean),
    licence: r.licence,
    credit: r.credit,
    ...(r.url ? { url: r.url } : {}),
    path: r.path,
    ...(r.bytes !== null ? { bytes: r.bytes } : {}),
    ...(r.duration !== null ? { duration: r.duration } : {}),
    ...(r.width !== null ? { width: r.width } : {}),
    ...(r.height !== null ? { height: r.height } : {}),
    uses: r.uses,
    createdAt: r.created_at,
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  };
}

/** Lowercase words of 3+ letters, without filler, for matching shots to assets. */
export function terms(text: string): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "into",
    "over",
    "under",
    "its",
    "are",
    "was",
    "very",
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3 && !stop.has(w)),
    ),
  ];
}

export interface FindOptions {
  kind: AssetKind;
  query: string;
  /** "portrait" for shorts, "landscape" for long-form (prefers but doesn't require it). */
  orientation?: "portrait" | "landscape";
  minDuration?: number;
  /** Skip assets used in these videos already (no repeats within a video). */
  exclude?: string[];
  limit?: number;
}

export class AssetLibrary {
  constructor(
    private readonly db: Database.Database,
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  add(asset: Omit<Asset, "uses" | "createdAt"> & { uses?: number }): Asset {
    const created = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO assets (id, kind, source, source_id, title, tags, licence, credit, url, path, bytes, duration, width, height, uses, created_at)
         VALUES (@id, @kind, @source, @sourceId, @title, @tags, @licence, @credit, @url, @path, @bytes, @duration, @width, @height, @uses, @created)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, bytes = excluded.bytes, tags = excluded.tags`,
      )
      .run({
        id: asset.id,
        kind: asset.kind,
        source: asset.source,
        sourceId: asset.sourceId ?? null,
        title: asset.title ?? null,
        tags: asset.tags.join(" "),
        licence: asset.licence,
        credit: asset.credit,
        url: asset.url ?? null,
        path: asset.path,
        bytes: asset.bytes ?? null,
        duration: asset.duration ?? null,
        width: asset.width ?? null,
        height: asset.height ?? null,
        uses: asset.uses ?? 0,
        created,
      });
    return this.get(asset.id) as Asset;
  }

  get(id: string): Asset | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  all(kind?: AssetKind): Asset[] {
    const rows = (
      kind
        ? this.db.prepare("SELECT * FROM assets WHERE kind = ? ORDER BY created_at DESC").all(kind)
        : this.db.prepare("SELECT * FROM assets ORDER BY created_at DESC").all()
    ) as Row[];
    return rows.map(fromRow).filter((a) => fs.existsSync(a.path));
  }

  /** The best existing matches: shared terms first, then the right shape, then least used. */
  find(opts: FindOptions): Asset[] {
    const want = terms(opts.query);
    if (want.length === 0) return [];
    const exclude = new Set(opts.exclude ?? []);
    const scored = this.all(opts.kind)
      .filter((a) => !exclude.has(a.id))
      .filter((a) => opts.minDuration === undefined || (a.duration ?? 0) >= opts.minDuration)
      .map((a) => {
        const have = new Set([...a.tags, ...terms(a.title ?? "")]);
        const hits = want.filter((w) => have.has(w)).length;
        const shape =
          a.width && a.height && opts.orientation
            ? (opts.orientation === "portrait") === a.height > a.width
              ? 0.5
              : 0
            : 0;
        return { a, score: hits / want.length + shape * 0.2 - Math.min(a.uses, 10) * 0.02 };
      })
      .filter((s) => s.score >= 0.34)
      .sort((x, y) => y.score - x.score);
    return scored.slice(0, opts.limit ?? 5).map((s) => s.a);
  }

  markUsed(ids: string[]): void {
    const at = new Date(this.now()).toISOString();
    const stmt = this.db.prepare(
      "UPDATE assets SET uses = uses + 1, last_used_at = ? WHERE id = ?",
    );
    for (const id of ids) stmt.run(at, id);
  }

  bytes(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS b FROM assets").get() as {
      b: number;
    };
    return row.b;
  }

  /** Deletes the least recently used downloads until the library fits under `capBytes`. */
  trim(capBytes: number, keep: Set<string> = new Set()): number {
    let total = this.bytes();
    let removed = 0;
    if (total <= capBytes) return 0;
    const rows = this.db
      .prepare(
        "SELECT * FROM assets WHERE source NOT IN ('owner', 'code') ORDER BY COALESCE(last_used_at, created_at) ASC",
      )
      .all() as Row[];
    for (const r of rows) {
      if (total <= capBytes) break;
      if (keep.has(r.id)) continue;
      fs.rmSync(r.path, { force: true });
      this.db.prepare("DELETE FROM assets WHERE id = ?").run(r.id);
      total -= r.bytes ?? 0;
      removed++;
    }
    return removed;
  }

  /** Where a new file for `source` goes. */
  fileFor(source: string, name: string): string {
    const dir = path.join(this.dir, source);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name.replace(/[^\w.-]/g, "_"));
  }
}

/** The credits block for a video's description, grouped by what each licence asks for. */
export function creditsText(assets: Asset[]): string {
  const lines: string[] = [];
  const by = (source: string) => assets.filter((a) => a.source === source);
  if (by("pixabay").length > 0) lines.push("Stock footage and images: Pixabay (pixabay.com).");
  const nasa = by("nasa");
  if (nasa.length > 0) {
    const credits = [...new Set(nasa.map((a) => a.credit || "NASA"))];
    lines.push(`Images and footage: ${credits.join("; ")}. NASA does not endorse this video.`);
  }
  for (const a of by("openverse")) {
    lines.push(`"${a.title ?? "Image"}" ${a.credit}${a.url ? ` (${a.url})` : ""}.`);
  }
  for (const a of assets.filter((x) => x.kind === "audio" && x.credit && x.source === "owner")) {
    lines.push(`Music: ${a.credit}.`);
  }
  return lines.join("\n");
}
