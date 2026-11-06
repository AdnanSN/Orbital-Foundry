import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";
import type { WorkStore } from "../work/store";
import type { Cadence } from "./analytics";
import type { Channel } from "./channel";
import type { VideoDoc } from "./editbay";
import type { AssetLibrary } from "./library";
import type { Idea, ScriptDoc } from "./writers";

/**
 * The always-on studio (Stage 20, D-062): the weekly production schedule and the disk clean-up.
 *
 * The schedule runs once a day. For each active channel it counts what is in the pipeline per
 * format: scripts being written or waiting at the Owner's Desk, approved scripts not made yet, and
 * real videos being made, waiting at the Desk or approved but not posted. A long-form counts for
 * the three shorts cut from it too. Below the cadence's target it starts scripts for the best
 * backlog ideas, proposing fresh ideas first when the backlog runs low, and never more than a few a
 * day so the free tiers keep up. Nothing leaves the station: every script still waits for you.
 *
 * The clean-up keeps the disk in check: test renders and failed or sent-back videos lose their
 * folders after a few days, posted videos keep their MP4, thumbnail, captions and metadata but
 * lose the render's working files, and the clip library stays under its size cap.
 */

export const studioConfigSchema = z.object({
  schedule: z
    .object({
      enabled: z.boolean().default(true),
      /** Local hour of the daily run. */
      hour: z.number().int().min(0).max(23).default(9),
      /** Days of shorts to keep in the pipeline. */
      leadDays: z.number().int().min(1).max(14).default(3),
      maxScriptsPerDay: z.number().int().min(0).max(10).default(2),
      /** Propose new ideas when fewer than this wait in a format's backlog. */
      minBacklog: z.number().int().min(0).max(40).default(3),
    })
    .default({ enabled: true, hour: 9, leadDays: 3, maxScriptsPerDay: 2, minBacklog: 3 }),
  cleanup: z
    .object({
      testRenderDays: z.number().min(0).default(3),
      failedDays: z.number().min(0).default(7),
      postedWorkfilesDays: z.number().min(0).default(14),
      libraryCapGb: z.number().min(0.5).default(8),
    })
    .default({ testRenderDays: 3, failedDays: 7, postedWorkfilesDays: 14, libraryCapGb: 8 }),
});
export type StudioConfig = z.infer<typeof studioConfigSchema>;

export function loadStudioConfig(file = path.join(CONFIG_DIR, "studio.yaml")): StudioConfig {
  if (!fs.existsSync(file)) return studioConfigSchema.parse({});
  return studioConfigSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
}

/** The render's working files, which a posted video no longer needs (and backups skip). */
export function isWorkfile(name: string): boolean {
  return (
    name === "project" ||
    /^voice(-[\w-]+)?\.(wav|mp3)$/.test(name) ||
    /^starfield-\d+\.png$/.test(name) ||
    /\.hf-transaction/.test(name)
  );
}

/** Backups skip the render's working files and keep the finished videos (D-062). */
export function backupSkip(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  const i = parts.indexOf("videos");
  if (parts[i - 1] !== "studio" || i < 0) return false;
  const name = parts[i + 2];
  return name !== undefined && isWorkfile(name);
}

const PIPELINE: Partial<Record<VideoDoc["status"], true>> = {
  waiting: true,
  producing: true,
  review: true,
  approved: true,
};

export interface ScheduleDeps {
  store: WorkStore;
  writers: {
    channels(): Channel[];
    ideas(channelId?: string, status?: Idea["status"]): Idea[];
    scripts(channelId?: string): ScriptDoc[];
    proposeIdeas(channelId: string, count?: number): Promise<Idea[]>;
    start(channelId: string, opts: { format: "short" | "long"; ideaId?: string }): ScriptDoc;
  };
  videos: { videos(channel?: string): VideoDoc[]; save(v: VideoDoc): void };
  cadence: (channelId: string) => Cadence;
  library?: Pick<AssetLibrary, "trim">;
  /** data/artifacts/studio/videos */
  videosDir: string;
  config: StudioConfig;
  say?: (role: string, text: string) => void;
  log?: (message: string) => void;
  now?: () => number;
}

export interface PipelineCount {
  channel: string;
  short: number;
  long: number;
  target: { short: number; long: number };
}

export class StudioSchedule {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly deps: ScheduleDeps) {
    this.now = deps.now ?? Date.now;
  }

  private today(): string {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** What each active channel has on the way, against its cadence. */
  pipeline(): PipelineCount[] {
    const lead = this.deps.config.schedule.leadDays;
    return this.deps.writers
      .channels()
      .filter((c) => c.status === "active")
      .map((c) => {
        const videos = this.deps.videos.videos(c.id).filter((v) => !v.test);
        const made = new Set(
          videos
            .filter((v) => v.status !== "failed" && v.status !== "rejected")
            .map((v) => v.scriptId),
        );
        let short = 0;
        let long = 0;
        for (const s of this.deps.writers.scripts(c.id)) {
          const waiting = s.status === "writing" || s.status === "review";
          if (!waiting && !(s.status === "approved" && !made.has(s.id))) continue;
          if (s.format === "long") {
            long += 1;
            short += 3;
          } else short += 1;
        }
        // A long-form still being made counts for its three shorts until they exist.
        const cut = new Set(videos.filter((v) => v.kind === "cutdown").map((v) => v.parentId));
        for (const v of videos) {
          if (!PIPELINE[v.status]) continue;
          if (v.format === "long") {
            long += 1;
            if (!cut.has(v.id)) short += 3;
          } else short += 1;
        }
        const cadence = this.deps.cadence(c.id);
        return {
          channel: c.id,
          short,
          long,
          target: {
            short: Math.round(cadence.shortsPerDay * lead),
            long: cadence.longPerWeek > 0 ? Math.max(1, Math.round(cadence.longPerWeek)) : 0,
          },
        };
      });
  }

  /** One daily pass: start the scripts the cadence needs (at most a few). */
  async run(): Promise<{ started: string[]; proposed: number }> {
    const day = this.today();
    const cap = this.deps.config.schedule.maxScriptsPerDay;
    let startedToday = Number(this.deps.store.getKv(`schedule.started.${day}`) ?? 0);
    const started: string[] = [];
    let proposed = 0;
    for (const p of this.pipeline()) {
      let needLong = Math.max(0, p.target.long - p.long);
      let needShort = Math.max(0, p.target.short - p.short);
      while (startedToday < cap && (needLong > 0 || needShort > 0)) {
        // Long-form first: it also yields the three shorts cut from it.
        const format = needLong > 0 ? "long" : "short";
        let backlog = this.backlog(p.channel, format);
        if (backlog.length < this.deps.config.schedule.minBacklog) {
          const key = `schedule.ideas.${day}.${p.channel}`;
          if (!this.deps.store.getKv(key)) {
            this.deps.store.setKv(key, "yes");
            try {
              proposed += (await this.deps.writers.proposeIdeas(p.channel, 4)).length;
            } catch (err) {
              this.deps.log?.(`schedule: ideas for ${p.channel} failed: ${String(err)}`);
            }
            backlog = this.backlog(p.channel, format);
          }
        }
        const idea = backlog[0];
        if (format === "long") needLong -= 1;
        else needShort -= 1;
        if (!idea) continue;
        try {
          const doc = this.deps.writers.start(p.channel, { format, ideaId: idea.id });
          started.push(doc.id);
          startedToday += 1;
          this.deps.store.setKv(`schedule.started.${day}`, String(startedToday));
          if (format === "long") needShort = Math.max(0, needShort - 3);
        } catch (err) {
          this.deps.log?.(`schedule: script for ${idea.id} failed to start: ${String(err)}`);
        }
      }
    }
    this.deps.store.setKv("schedule.lastRun", new Date(this.now()).toISOString());
    if (started.length > 0) {
      this.deps.say?.(
        "researcher",
        `The schedule started ${started.length} script(s); they'll wait at the Owner's Desk.`,
      );
    }
    return { started, proposed };
  }

  /** Frees disk: old test renders, failed videos, posted videos' working files, the library. */
  cleanup(): { folders: number; workfiles: number; bytes: number; assets: number } {
    const c = this.deps.config.cleanup;
    const now = this.now();
    const age = (v: VideoDoc) => (now - Date.parse(v.updatedAt)) / 86_400_000;
    let folders = 0;
    let workfiles = 0;
    let bytes = 0;
    for (const v of this.deps.videos.videos()) {
      const dir = this.folder(v.id);
      if (!dir || !fs.existsSync(dir)) continue;
      const done = v.status !== "producing" && v.status !== "waiting";
      const oldTest = v.test && done && age(v) >= c.testRenderDays;
      const oldFailed =
        (v.status === "failed" || v.status === "rejected") && age(v) >= c.failedDays;
      if (oldTest || oldFailed) {
        bytes += sizeOf(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        folders += 1;
        v.cleaned = "folder";
        this.deps.videos.save(v);
        continue;
      }
      if (v.status === "posted" && v.cleaned === undefined && age(v) >= c.postedWorkfilesDays) {
        for (const name of fs.readdirSync(dir)) {
          if (!isWorkfile(name)) continue;
          const p = path.join(dir, name);
          bytes += sizeOf(p);
          fs.rmSync(p, { recursive: true, force: true });
          workfiles += 1;
        }
        v.cleaned = "workfiles";
        this.deps.videos.save(v);
      }
    }
    // Clips still needed by a video that isn't posted yet stay, whatever their age.
    const keep = new Set(
      this.deps.videos
        .videos()
        .filter((v) => PIPELINE[v.status])
        .flatMap((v) => v.assets),
    );
    const assets = this.deps.library?.trim(c.libraryCapGb * 1024 ** 3, keep) ?? 0;
    if (folders + workfiles + assets > 0) {
      this.deps.log?.(
        `clean-up: ${folders} folder(s), ${workfiles} working file(s), ${assets} library clip(s); ${(bytes / 1024 ** 2).toFixed(0)} MB freed`,
      );
    }
    this.deps.store.setKv("schedule.lastCleanup", new Date(this.now()).toISOString());
    return { folders, workfiles, bytes, assets };
  }

  status(): {
    enabled: boolean;
    hour: number;
    lastRun: string | null;
    lastCleanup: string | null;
    startedToday: number;
    pipeline: PipelineCount[];
  } {
    return {
      enabled: this.deps.config.schedule.enabled,
      hour: this.deps.config.schedule.hour,
      lastRun: this.deps.store.getKv("schedule.lastRun"),
      lastCleanup: this.deps.store.getKv("schedule.lastCleanup"),
      startedToday: Number(this.deps.store.getKv(`schedule.started.${this.today()}`) ?? 0),
      pipeline: this.pipeline(),
    };
  }

  start(everyMs = 10 * 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The daily run (from its hour on) and the daily clean-up. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const day = this.today();
      const hour = new Date(this.now()).getHours();
      const s = this.deps.config.schedule;
      if (s.enabled && hour >= s.hour && this.deps.store.getKv("schedule.ranOn") !== day) {
        this.deps.store.setKv("schedule.ranOn", day);
        await this.run();
      }
      if (this.deps.store.getKv("schedule.cleanedOn") !== day) {
        this.deps.store.setKv("schedule.cleanedOn", day);
        this.cleanup();
      }
    } catch (err) {
      this.deps.log?.(`schedule: ${String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private backlog(channel: string, format: "short" | "long"): Idea[] {
    return this.deps.writers
      .ideas(channel, "backlog")
      .filter((i) => i.format === format || i.format === "both");
  }

  /** The video's own folder, and only ever inside the videos directory. */
  private folder(id: string): string | null {
    if (!/^V-\d{4,}$/.test(id)) return null;
    const dir = path.resolve(this.deps.videosDir, id);
    return path.dirname(dir) === path.resolve(this.deps.videosDir) ? dir : null;
  }
}

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch {
    return 0;
  }
}
