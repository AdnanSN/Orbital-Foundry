import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR, DATA_DIR } from "../paths";

/**
 * Always-on operations (ROADMAP Stage 11): quiet hours and nightly backups. Backups use SQLite's
 * online backup (safe while the station runs) and copy artifact files incrementally: files never
 * change once written, so only new ones are copied.
 */

export const opsConfigSchema = z.object({
  quietHours: z
    .tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)])
    .default([23, 7]),
  backups: z
    .object({
      hour: z.number().int().min(0).max(23).default(3),
      keep: z.number().int().min(1).max(90).default(7),
      dir: z.string().default(""),
    })
    .default({ hour: 3, keep: 7, dir: "" }),
  logs: z
    .object({ keepDays: z.number().int().min(1).max(365).default(14) })
    .default({ keepDays: 14 }),
});
export type OpsConfig = z.infer<typeof opsConfigSchema>;

export function loadOpsConfig(file = path.join(CONFIG_DIR, "ops.yaml")): OpsConfig {
  if (!fs.existsSync(file)) return opsConfigSchema.parse({});
  return opsConfigSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
}

/** True inside [start, end) local hours, wrapping past midnight (23 to 7). */
export function isQuiet(date: Date, [start, end]: [number, number]): boolean {
  const h = date.getHours();
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface BackupResult {
  database: string;
  copiedFiles: number;
  removed: string[];
  bytes: number;
}

/** Copy new files from `src` into `dst` (same relative paths); returns how many were copied. */
function mirror(src: string, dst: string): { files: number; bytes: number } {
  if (!fs.existsSync(src)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const r = mirror(from, to);
      files += r.files;
      bytes += r.bytes;
    } else if (entry.isFile()) {
      const size = fs.statSync(from).size;
      if (fs.existsSync(to) && fs.statSync(to).size === size) continue;
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(from, to);
      files += 1;
      bytes += size;
    }
  }
  return { files, bytes };
}

export class OpsService {
  private readonly dir: string;

  constructor(
    private readonly db: Database.Database,
    private readonly config: OpsConfig,
    private readonly opts: {
      dataDir?: string;
      backupDir?: string;
      clock?: () => Date;
      getKv(key: string): string | null;
      setKv(key: string, value: string): void;
      log?: (m: string) => void;
    },
  ) {
    this.dir =
      opts.backupDir || config.backups.dir || path.join(opts.dataDir ?? DATA_DIR, "backups");
  }

  get backupDir(): string {
    return this.dir;
  }

  quiet(date = this.now()): boolean {
    return isQuiet(date, this.config.quietHours);
  }

  /** A consistent copy of the database plus new artifact files; old database copies pruned. */
  async backup(): Promise<BackupResult> {
    const now = this.now();
    fs.mkdirSync(this.dir, { recursive: true });
    const database = path.join(this.dir, `orbital-${stamp(now)}.db`);
    await this.db.backup(database);
    const art = mirror(
      path.join(this.opts.dataDir ?? DATA_DIR, "artifacts"),
      path.join(this.dir, "artifacts"),
    );
    const copies = fs
      .readdirSync(this.dir)
      .filter((f) => /^orbital-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f))
      .sort();
    const removed: string[] = [];
    while (copies.length > this.config.backups.keep) {
      const old = copies.shift();
      if (!old) break;
      fs.rmSync(path.join(this.dir, old), { force: true });
      removed.push(old);
    }
    this.opts.setKv(
      "ops.lastBackup",
      JSON.stringify({ at: now.toISOString(), database, files: art.files }),
    );
    return {
      database,
      copiedFiles: art.files,
      removed,
      bytes: fs.statSync(database).size + art.bytes,
    };
  }

  lastBackup(): { at: string; database: string; files: number } | null {
    const raw = this.opts.getKv("ops.lastBackup");
    return raw ? (JSON.parse(raw) as { at: string; database: string; files: number }) : null;
  }

  /** Run the nightly backup once a day at the configured hour (call every few minutes). */
  async tick(): Promise<BackupResult | null> {
    const now = this.now();
    if (now.getHours() !== this.config.backups.hour) return null;
    const last = this.lastBackup();
    if (last && now.getTime() - new Date(last.at).getTime() < 20 * 3_600_000) return null;
    const r = await this.backup();
    this.opts.log?.(
      `nightly backup: ${path.basename(r.database)}, ${r.copiedFiles} new artifact file(s)`,
    );
    return r;
  }

  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }
}
