import type Database from "better-sqlite3";
import type { WorkStore } from "../work/store";

/**
 * Achievements (ROADMAP Stage 11 polish): milestones the station reaches, checked from what it
 * already records. Unlocking one makes WARDEN announce it; the Vault lists them.
 */

export interface Counts {
  objectivesDone: number;
  packages: number;
  published: number;
  thumbDeliveries: number;
  assetPacks: number;
  retros: number;
  realSales: number;
  tasksDone: number;
}

export const ACHIEVEMENTS: { id: string; title: string; check: (c: Counts) => boolean }[] = [
  {
    id: "first-objective",
    title: "First objective delivered",
    check: (c) => c.objectivesDone >= 1,
  },
  { id: "first-package", title: "First listing package", check: (c) => c.packages >= 1 },
  { id: "five-packages", title: "Five listing packages", check: (c) => c.packages >= 5 },
  {
    id: "first-publish",
    title: "First publish (a dry run counts)",
    check: (c) => c.published >= 1,
  },
  { id: "first-thumbs", title: "First thumbnails delivered", check: (c) => c.thumbDeliveries >= 1 },
  { id: "first-pack", title: "First asset pack", check: (c) => c.assetPacks >= 1 },
  { id: "first-retro", title: "First weekly plan", check: (c) => c.retros >= 1 },
  { id: "first-sale", title: "First real sale", check: (c) => c.realSales >= 1 },
  { id: "hundred-tasks", title: "100 real tasks done", check: (c) => c.tasksDone >= 100 },
];

export class Achievements {
  constructor(
    private readonly db: Database.Database,
    private readonly store: WorkStore,
    private readonly announce: (title: string) => void,
  ) {}

  counts(): Counts {
    const kind = (k: string) => this.store.findArtifacts({ kind: k, limit: 10_000 });
    const packages = kind("listing-package");
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      objectivesDone: this.store.objectives(10_000).filter((o) => o.status === "done").length,
      packages: packages.length,
      published: packages.filter((p) => p.info?.published).length,
      thumbDeliveries: kind("thumbnail-delivery").length,
      assetPacks: kind("asset-pack").length,
      retros: kind("retro").length,
      realSales: one("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'sale' AND simulated = 0"),
      tasksDone: one("SELECT COUNT(*) AS n FROM tasks WHERE mock = 0 AND status = 'done'"),
    };
  }

  unlocked(): Record<string, string> {
    return JSON.parse(this.store.getKv("achievements") ?? "{}") as Record<string, string>;
  }

  list(): { id: string; title: string; at: string | null }[] {
    const got = this.unlocked();
    return ACHIEVEMENTS.map((a) => ({ id: a.id, title: a.title, at: got[a.id] ?? null }));
  }

  /** Unlock whatever is newly earned; returns the new ones. */
  check(): string[] {
    const got = this.unlocked();
    const c = this.counts();
    const fresh = ACHIEVEMENTS.filter((a) => !got[a.id] && a.check(c));
    if (fresh.length === 0) return [];
    const at = new Date().toISOString();
    for (const a of fresh) got[a.id] = at;
    this.store.setKv("achievements", JSON.stringify(got));
    for (const a of fresh) this.announce(a.title);
    return fresh.map((a) => a.id);
  }
}
