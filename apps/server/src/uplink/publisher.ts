import fs from "node:fs";
import path from "node:path";
import type { Approval, ArtifactMeta, Lane } from "@orbital/shared";
import type Database from "better-sqlite3";
import { zipSync } from "fflate";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";
import type { VideoDoc } from "../studio/editbay";
import type { Outbox } from "../vault/ledger";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";
import type { InstagramConnector } from "./instagram";
import type { TikTokConnector } from "./tiktok";
import type { YouTubeConnector } from "./youtube";

/**
 * The Uplink's publisher (Stage 17, D-059). An approved video gets a post plan at the Owner's Desk
 * (platforms, times, captions, mode), and approving the plan posts it:
 * - YouTube: uploaded at once with a publish time, plus the thumbnail, captions, playlist and the
 *   AI-disclosure flag. The very first live upload goes out unlisted, as a check.
 * - Instagram: a Reel, published at its time.
 * - TikTok: a draft in the owner's inbox at its time, with a phone notice to post it.
 * - A platform that isn't connected gets an upload kit (video, caption, hashtags, thumbnail).
 * Every post runs once (the outbox), obeys the kill switch and the platform's daily cap, and is a
 * dry run unless PUBLISH_MODE=live. Only live-lane videos that aren't test renders can be posted.
 */

export const PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

export type PostStatus =
  /** Waiting for the post plan's approval. */
  | "awaiting"
  /** Approved; it goes out (or, on YouTube, goes public) at `at`. */
  | "scheduled"
  | "posting"
  | "posted"
  /** In the TikTok inbox; the owner posts it in the app. */
  | "draft"
  /** Not connected: an upload kit is ready for posting by hand. */
  | "kit"
  /** The kill switch stopped it; resume it from the Uplink panel. */
  | "held"
  | "failed"
  | "cancelled";

export interface PostRecord {
  id: string;
  videoId: string;
  channel: string;
  platform: Platform;
  format: "short" | "long";
  title: string;
  status: PostStatus;
  /** The mode the plan was approved in; a dry-run plan never posts for real. */
  mode: "dry-run" | "live";
  /** Through the platform's API, or an upload kit. Fixed when the plan is filed. */
  how: "api" | "kit";
  /** When it goes public (ISO). */
  at: string;
  /** YouTube: "unlisted" for the first live upload (a check), otherwise "public". */
  privacy?: "unlisted" | "public";
  approvalId?: string;
  remoteId?: string;
  url?: string;
  detail?: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const platformSchema = z.object({
  enabled: z.boolean().default(true),
  dailyCap: z.number().int().min(0).max(100),
  formats: z.array(z.enum(["short", "long"])).min(1),
});

export const uplinkConfigSchema = z.object({
  platforms: z.object({
    youtube: platformSchema,
    instagram: platformSchema,
    tiktok: platformSchema,
  }),
  schedule: z.object({
    shortTimes: z.array(hhmm).min(1),
    longDays: z.array(z.enum(DAYS)).min(1),
    longTime: hhmm,
    leadMinutes: z.number().int().min(0).max(1440).default(30),
  }),
  youtube: z
    .object({
      firstUploadUnlisted: z.boolean().default(true),
      playlists: z
        .record(
          z.string(),
          z.object({ long: z.string().default(""), short: z.string().default("") }),
        )
        .default({}),
    })
    .default({ firstUploadUnlisted: true, playlists: {} }),
});
export type UplinkConfig = z.infer<typeof uplinkConfigSchema>;

export const DEFAULT_UPLINK: UplinkConfig = {
  platforms: {
    youtube: { enabled: true, dailyCap: 4, formats: ["long", "short"] },
    instagram: { enabled: true, dailyCap: 2, formats: ["short"] },
    tiktok: { enabled: true, dailyCap: 2, formats: ["short"] },
  },
  schedule: { shortTimes: ["17:00"], longDays: ["sat"], longTime: "15:00", leadMinutes: 30 },
  youtube: { firstUploadUnlisted: true, playlists: {} },
};

export function loadUplinkConfig(file = path.join(CONFIG_DIR, "uplink.yaml")): UplinkConfig {
  if (!fs.existsSync(file)) return DEFAULT_UPLINK;
  return uplinkConfigSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")));
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The next free posting time on a platform, in this computer's local time: the schedule's times,
 * no sooner than the lead, one post per slot, and the platform's daily cap.
 */
export function nextSlot(
  format: "short" | "long",
  platform: Platform,
  cfg: UplinkConfig,
  taken: { platform: Platform; at: string }[],
  now: number,
): Date {
  const earliest = now + cfg.schedule.leadMinutes * 60_000;
  const mine = taken.filter((t) => t.platform === platform).map((t) => new Date(t.at));
  const today = new Date(now);
  for (let d = 0; d < 120; d++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + d);
    if (mine.filter((t) => sameDay(t, day)).length >= cfg.platforms[platform].dailyCap) continue;
    const times =
      format === "short"
        ? cfg.schedule.shortTimes
        : cfg.schedule.longDays.includes(DAYS[day.getDay()] as (typeof DAYS)[number])
          ? [cfg.schedule.longTime]
          : [];
    for (const t of [...times].sort()) {
      const [h, m] = t.split(":").map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (at.getTime() < earliest) continue;
      if (mine.some((x) => Math.abs(x.getTime() - at.getTime()) < 60_000)) continue;
      return at;
    }
  }
  return new Date(earliest);
}

/** "Sat 8 Nov, 15:00" in local time. */
export function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Sent {
  remoteId: string;
  url?: string;
  warnings: string[];
  status: "posted" | "scheduled" | "draft";
  detail: string;
  privacy?: "unlisted" | "public";
}

interface PostTexts {
  youtube: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    synthetic: boolean;
  };
  /** `ai`: Meta's "AI info" label, set when the Reel is created. */
  instagram: { caption: string; ai: boolean };
  /** `aigc`: TikTok's AI-generated content label (the owner turns it on when posting a draft). */
  tiktok: { caption: string; aigc: boolean };
}

export interface UplinkStatus {
  mode: "dry-run" | "live";
  killed: boolean;
  platforms: {
    platform: Platform;
    enabled: boolean;
    connected: boolean;
    dailyCap: number;
    today: number;
  }[];
  posts: PostRecord[];
}

export interface UplinkDeps {
  videos: {
    video(id: string): VideoDoc | null;
    videos(): VideoDoc[];
    save(v: VideoDoc): void;
  };
  store: WorkStore;
  db: Database.Database;
  outbox: Outbox;
  director?: WorkDirector;
  youtube?: Pick<YouTubeConnector, "status" | "upload" | "hold" | "reschedule">;
  instagram?: Pick<InstagramConnector, "status" | "publishReel">;
  tiktok?: Pick<TikTokConnector, "status" | "upload" | "settled">;
  config?: UplinkConfig;
  /** PUBLISH_MODE=live, or a dry run. */
  mode: "dry-run" | "live";
  lane: Lane;
  /** data/uplink */
  dir: string;
  /** A phone notice (Telegram), when one is set up. */
  notify?: (text: string) => unknown;
  say?: (role: string, text: string) => void;
  log?: (message: string) => void;
  now?: () => number;
}

export class UplinkPublisher {
  private readonly now: () => number;
  private readonly cfg: UplinkConfig;
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UplinkDeps) {
    this.now = deps.now ?? Date.now;
    this.cfg = deps.config ?? DEFAULT_UPLINK;
    fs.mkdirSync(deps.dir, { recursive: true });
    deps.director?.onDecision((a) => this.onDecision(a));
    for (const p of this.posts({ status: "posting" })) {
      this.mark(p, "failed", "The station restarted during the upload. Resume it from the Uplink.");
    }
  }

  get mode(): "dry-run" | "live" {
    return this.deps.mode;
  }

  get config(): UplinkConfig {
    return this.cfg;
  }

  killed(): boolean {
    return this.deps.store.getKv("station.kill") === "on";
  }

  /** Checks for due posts every minute. */
  start(everyMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs whatever is due, one pass at a time; tests await it. */
  tick(): Promise<void> {
    this.queue = this.queue
      .then(() => this.step())
      .catch((err: unknown) => this.log(`tick: ${errText(err)}`));
    return this.queue;
  }

  status(): UplinkStatus {
    const today = new Date(this.now());
    return {
      mode: this.mode,
      killed: this.killed(),
      platforms: PLATFORMS.map((p) => ({
        platform: p,
        enabled: this.cfg.platforms[p].enabled,
        connected: this.connected(p),
        dailyCap: this.cfg.platforms[p].dailyCap,
        today: this.sentOn(p, today),
      })),
      posts: this.posts().slice(0, 40),
    };
  }

  posts(filter: { videoId?: string; status?: PostStatus } = {}): PostRecord[] {
    const rows = this.deps.db
      .prepare(
        "SELECT data FROM posts WHERE (? IS NULL OR video_id = ?) AND (? IS NULL OR status = ?) ORDER BY at DESC, id DESC LIMIT 500",
      )
      .all(
        filter.videoId ?? null,
        filter.videoId ?? null,
        filter.status ?? null,
        filter.status ?? null,
      ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as PostRecord);
  }

  post(id: string): PostRecord | null {
    const row = this.deps.db.prepare("SELECT data FROM posts WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as PostRecord) : null;
  }

  /** The platforms a video goes to: enabled ones that take its format. */
  platformsFor(v: Pick<VideoDoc, "format">): Platform[] {
    return PLATFORMS.filter(
      (p) => this.cfg.platforms[p].enabled && this.cfg.platforms[p].formats.includes(v.format),
    );
  }

  /** Files the post plan for an approved video at the Owner's Desk. */
  propose(videoId: string, opts: { platforms?: Platform[]; now?: boolean } = {}): PostRecord[] {
    const v = this.deps.videos.video(videoId);
    if (!v) throw new Error(`No video "${videoId}".`);
    if (v.test) throw new Error("Test renders can't be posted.");
    if (v.status !== "approved" && v.status !== "posted") {
      throw new Error("Approve the video at the Owner's Desk first.");
    }
    if (!v.file || !fs.existsSync(v.file)) throw new Error("The video file is missing.");
    const allowed = this.platformsFor(v);
    const planned = this.posts({ videoId }).filter(
      (p) => p.status !== "failed" && p.status !== "cancelled",
    );
    const want = (opts.platforms ?? allowed).filter(
      (p) => allowed.includes(p) && !planned.some((x) => x.platform === p),
    );
    if (want.length === 0) {
      throw new Error("Every platform that takes this video already has a post planned.");
    }
    const taken = this.posts().filter(
      (p) => p.mode === this.mode && p.status !== "failed" && p.status !== "cancelled",
    );
    const checked = taken.some((p) => p.platform === "youtube" && p.mode === "live");
    const created = new Date(this.now()).toISOString();
    const posts = want.map((platform) => {
      const at = opts.now
        ? new Date(this.now())
        : nextSlot(v.format, platform, this.cfg, taken, this.now());
      const p: PostRecord = {
        id: this.deps.store.nextId("U"),
        videoId: v.id,
        channel: v.channel,
        platform,
        format: v.format,
        title: v.title,
        status: "awaiting",
        mode: this.mode,
        how: this.connected(platform) ? "api" : "kit",
        at: at.toISOString(),
        warnings: [],
        createdAt: created,
        updatedAt: created,
      };
      if (platform === "youtube") {
        p.privacy =
          this.mode === "live" && this.cfg.youtube.firstUploadUnlisted && !checked
            ? "unlisted"
            : "public";
      }
      taken.push(p);
      return p;
    });
    const content = this.planText(v, posts);
    const meta: ArtifactMeta = {
      id: this.deps.store.nextId("F"),
      kind: "studio.post",
      title: `Post plan: ${v.title}`.slice(0, 140),
      mime: "text/markdown",
      taskId: null,
      objectiveId: null,
      createdBy: "operator",
      createdAt: this.now(),
      size: content.length,
      room: null,
      info: { videoId: v.id, posts: posts.map((p) => p.id) },
    };
    this.deps.store.saveArtifact(meta, content);
    const approval = this.deps.director?.fileDeskItem({
      kind: "deliverable",
      title: `Post: ${v.title.slice(0, 90)}`,
      summary: this.planSummary(posts),
      requestedBy: "operator",
      objectiveId: null,
      taskId: null,
      artifactId: meta.id,
      action: null,
    });
    for (const p of posts) {
      p.approvalId = approval?.id;
      this.save(p);
    }
    this.deps.say?.("operator", `The post plan for ${v.id} is at the Owner's Desk.`);
    return posts;
  }

  /** Puts a held or failed post back on the schedule (a fresh slot if its time has passed). */
  async resume(id: string): Promise<PostRecord> {
    if (this.killed()) throw new Error("Turn the kill switch off first.");
    const p = this.post(id);
    if (!p) throw new Error(`No post "${id}".`);
    if (p.status !== "held" && p.status !== "failed") {
      throw new Error("Only held or failed posts can be resumed.");
    }
    const v = this.deps.videos.video(p.videoId);
    if (!v) throw new Error("The video is gone.");
    if (Date.parse(p.at) < this.now() + this.cfg.schedule.leadMinutes * 60_000) {
      const taken = this.posts().filter(
        (x) =>
          x.id !== p.id && x.mode === p.mode && x.status !== "failed" && x.status !== "cancelled",
      );
      p.at = nextSlot(p.format, p.platform, this.cfg, taken, this.now()).toISOString();
    }
    if (p.status === "held" && this.isLiveYouTube(p)) {
      await this.deps.youtube?.reschedule(
        p.remoteId as string,
        p.at,
        this.texts(v).youtube.synthetic,
      );
    }
    this.mark(p, "scheduled", `Back on the schedule for ${when(p.at)}.`);
    void this.tick();
    return p;
  }

  /** Stops a post that hasn't gone out. A scheduled YouTube upload is made private. */
  async cancel(id: string): Promise<PostRecord> {
    const p = this.post(id);
    if (!p) throw new Error(`No post "${id}".`);
    if (["posting", "posted", "draft", "cancelled"].includes(p.status)) {
      throw new Error("It has already gone out (or is going); remove it on the platform.");
    }
    if (p.status === "scheduled" && this.isLiveYouTube(p)) {
      const v = this.deps.videos.video(p.videoId);
      await this.deps.youtube?.hold(
        p.remoteId as string,
        v ? this.texts(v).youtube.synthetic : true,
      );
      this.mark(p, "cancelled", "Cancelled. The upload is private on YouTube; delete it there.");
      return p;
    }
    this.mark(p, "cancelled", "Cancelled.");
    return p;
  }

  /** The upload kit for posting by hand: the video, thumbnail, captions file and the text. */
  kitZip(id: string): { name: string; data: Uint8Array } {
    const p = this.post(id);
    if (!p) throw new Error(`No post "${id}".`);
    const v = this.deps.videos.video(p.videoId);
    if (!v?.file || !fs.existsSync(v.file)) throw new Error("The video file is missing.");
    const files: Record<string, Uint8Array> = { "video.mp4": fs.readFileSync(v.file) };
    if (v.thumbnail && fs.existsSync(v.thumbnail)) {
      files["thumbnail.png"] = fs.readFileSync(v.thumbnail);
    }
    if (p.platform === "youtube" && v.srt && fs.existsSync(v.srt)) {
      files["captions.srt"] = fs.readFileSync(v.srt);
    }
    files["post.txt"] = new TextEncoder().encode(this.kitText(p, v));
    // The video is compressed already, so the ZIP only stores it.
    return { name: `${p.id}-${p.platform}-${v.id}.zip`, data: zipSync(files, { level: 0 }) };
  }

  /** The station's kill switch moved: hold everything scheduled at once. */
  onKill(): Promise<void> {
    return this.tick();
  }

  private async step(): Promise<void> {
    if (this.killed()) {
      await this.holdAll();
      return;
    }
    const now = this.now();
    for (const p of this.posts({ status: "scheduled" }).reverse()) {
      if (this.killed()) return;
      if (p.how === "kit") {
        await this.toKit(p);
        continue;
      }
      const due = Date.parse(p.at) <= now + 60_000;
      if (p.platform === "youtube") {
        // YouTube takes the upload now and makes it public at its time by itself.
        if (!p.remoteId) await this.run(p);
        else if (due) this.went(p, "posted", "Public on YouTube.");
      } else if (due) {
        await this.run(p);
      }
    }
  }

  private async run(p: PostRecord): Promise<void> {
    const v = this.deps.videos.video(p.videoId);
    const blocked = this.blockers(p, v);
    if (blocked.length > 0 || !v) {
      this.mark(p, "failed", blocked.join(" ") || "The video is gone.");
      await this.notice(`⚠️ ${PLATFORM_NAMES[p.platform]} post ${p.id} stopped: ${p.detail}`);
      return;
    }
    if (!this.connected(p.platform)) {
      await this.toKit(p, `${PLATFORM_NAMES[p.platform]} isn't connected any more.`);
      return;
    }
    this.mark(p, "posting", "Sending…");
    try {
      const sent = await this.deps.outbox.once(`uplink.${p.id}`, () => this.send(p, v));
      p.remoteId = sent.remoteId;
      p.url = sent.url;
      p.warnings = sent.warnings;
      if (sent.privacy) p.privacy = sent.privacy;
      this.went(p, sent.status, sent.detail);
      const dry = p.remoteId.startsWith("dry-") ? " (dry run)" : "";
      if (p.platform === "tiktok") {
        const text = this.texts(v).tiktok;
        await this.notice(
          `📥 TikTok draft ready${dry}: "${v.title}". Open TikTok → Inbox to post it.\n\nCaption:\n${text.caption}${text.aigc ? "\n\nTurn on the AI-generated content label." : ""}`,
        );
      } else {
        await this.notice(
          `📡 ${PLATFORM_NAMES[p.platform]}${dry}: ${sent.detail}${p.url ? ` ${p.url}` : ""}`,
        );
      }
    } catch (err) {
      this.mark(p, "failed", errText(err));
      await this.notice(
        `⚠️ ${PLATFORM_NAMES[p.platform]} post failed for "${v.title}": ${p.detail}`,
      );
    }
  }

  private async send(p: PostRecord, v: VideoDoc): Promise<Sent> {
    const text = this.texts(v);
    const future = Date.parse(p.at) > this.now() + 15 * 60_000;
    const unlisted = p.privacy === "unlisted";
    if (!(p.mode === "live" && this.mode === "live")) {
      const status =
        p.platform === "tiktok"
          ? "draft"
          : p.platform === "youtube" && future && !unlisted
            ? "scheduled"
            : "posted";
      return {
        remoteId: `dry-${p.platform}-${p.id}`,
        warnings: [],
        status,
        detail: "Dry run: nothing left the station.",
      };
    }
    const file = v.file as string;
    if (p.platform === "youtube") {
      const yt = this.deps.youtube;
      if (!yt) throw new Error("YouTube isn't set up.");
      const playlist = this.cfg.youtube.playlists[v.channel]?.[v.format] || undefined;
      const res = await yt.upload({
        file,
        title: text.youtube.title,
        description: text.youtube.description,
        tags: text.youtube.tags,
        categoryId: text.youtube.categoryId,
        privacy: unlisted ? "unlisted" : "public",
        publishAt: !unlisted && future ? p.at : undefined,
        syntheticMedia: text.youtube.synthetic,
        thumbnail: v.thumbnail,
        srt: v.srt,
        playlist,
      });
      return {
        remoteId: res.videoId,
        url: res.url,
        warnings: res.warnings,
        status: !unlisted && future ? "scheduled" : "posted",
        detail: unlisted
          ? "Uploaded unlisted (the first upload is a check). Make it public in YouTube Studio once it looks right."
          : future
            ? `Scheduled on YouTube for ${when(p.at)}.`
            : "Public on YouTube.",
        privacy: unlisted ? "unlisted" : "public",
      };
    }
    if (p.platform === "instagram") {
      const ig = this.deps.instagram;
      if (!ig) throw new Error("Instagram isn't set up.");
      const res = await ig.publishReel({
        file,
        caption: text.instagram.caption,
        shareToFeed: true,
        thumbOffsetMs: 1500,
        aiGenerated: text.instagram.ai,
      });
      return {
        remoteId: res.mediaId,
        url: res.url,
        warnings: [],
        status: "posted",
        detail: "Published as a Reel.",
      };
    }
    const tt = this.deps.tiktok;
    if (!tt) throw new Error("TikTok isn't set up.");
    const record = await tt.upload(`${v.id}.mp4`, fs.readFileSync(file));
    const done = await tt.settled(record.id);
    if (!done || done.status === "failed" || done.status === "uploading") {
      throw new Error(done?.detail ?? "TikTok didn't take the draft.");
    }
    return {
      remoteId: done.publishId ?? record.id,
      warnings:
        done.status === "in_inbox"
          ? []
          : ["TikTok hasn't confirmed the draft yet; check the inbox."],
      status: "draft",
      detail: "In your TikTok inbox: open TikTok, add the caption and post it.",
    };
  }

  /** Everything that stops this post going out now, in plain words. */
  blockers(p: PostRecord, v: VideoDoc | null): string[] {
    const out: string[] = [];
    if (this.killed()) out.push("The station kill switch is on.");
    if (!v) return [...out, "The video is gone."];
    if (v.test) out.push("Test renders can't be posted.");
    if (v.status !== "approved" && v.status !== "posted") out.push("The video isn't approved.");
    if (!v.file || !fs.existsSync(v.file)) out.push("The video file is missing.");
    const rules = this.cfg.platforms[p.platform];
    if (!rules.enabled) out.push(`${PLATFORM_NAMES[p.platform]} is off in config/uplink.yaml.`);
    if (this.sentOn(p.platform, new Date(p.at), p.id) >= rules.dailyCap) {
      out.push(`${PLATFORM_NAMES[p.platform]} already has its ${rules.dailyCap} post(s) that day.`);
    }
    if (p.mode === "live" && this.mode === "live") {
      if (this.deps.lane !== "live") {
        out.push("Live posting needs the station in the live lane (ORBITAL_MODE=production).");
      }
      if (v.lane !== "live") out.push("Only videos made in the live lane can be posted.");
    }
    return out;
  }

  private async holdAll(): Promise<void> {
    for (const p of this.posts({ status: "scheduled" })) {
      if (this.isLiveYouTube(p)) {
        if (Date.parse(p.at) <= this.now()) continue; // Already public.
        const warned = p.warnings.some((w) => w.startsWith("The kill switch couldn't"));
        if (warned) continue;
        try {
          const v = this.deps.videos.video(p.videoId);
          await this.deps.youtube?.hold(
            p.remoteId as string,
            v ? this.texts(v).youtube.synthetic : true,
          );
          this.mark(p, "held", "The kill switch took it off YouTube's schedule; it's private now.");
        } catch (err) {
          p.warnings = [
            ...p.warnings,
            `The kill switch couldn't pull it back (${errText(err)}); set it to private in YouTube Studio.`,
          ];
          this.save(p);
        }
        continue;
      }
      this.mark(p, "held", "Held by the kill switch.");
    }
  }

  private async toKit(p: PostRecord, reason?: string): Promise<void> {
    const v = this.deps.videos.video(p.videoId);
    if (!v?.file || !fs.existsSync(v.file)) {
      this.mark(p, "failed", "The video file is missing.");
      return;
    }
    this.mark(
      p,
      "kit",
      `${reason ? `${reason} ` : ""}The upload kit is ready: post it by hand on ${PLATFORM_NAMES[p.platform]} at ${when(p.at)}.`,
    );
    await this.notice(
      `📦 ${PLATFORM_NAMES[p.platform]} upload kit ready for "${v.title}"; post it at ${when(p.at)}. It's in the Uplink panel.`,
    );
  }

  private onDecision = async (a: Approval): Promise<void> => {
    if (!a.artifactId) return;
    const art = this.deps.store.artifact(a.artifactId);
    if (!art) return;
    if (art.meta.kind === "studio.video") {
      if (a.status !== "approved") return;
      const v = this.deps.videos.videos().find((x) => x.artifactId === a.artifactId);
      if (!v || v.test || v.status !== "approved") return;
      try {
        this.propose(v.id);
      } catch (err) {
        this.log(`post plan for ${v.id}: ${errText(err)}`);
      }
      return;
    }
    if (art.meta.kind !== "studio.post") return;
    const posts = this.posts().filter((p) => p.approvalId === a.id && p.status === "awaiting");
    if (a.status === "approved") {
      for (const p of posts) this.mark(p, "scheduled", `Approved for ${when(p.at)}.`);
      void this.tick();
    } else if (a.status === "rejected") {
      for (const p of posts) {
        this.mark(p, "cancelled", a.note?.trim() || "Sent back at the Owner's Desk.");
      }
    }
  };

  private went(p: PostRecord, status: PostStatus, detail: string): void {
    this.mark(p, status, detail);
    if (p.mode !== "live" || p.remoteId?.startsWith("dry-")) return;
    const v = this.deps.videos.video(p.videoId);
    if (v && v.status === "approved") {
      v.status = "posted";
      this.deps.videos.save(v);
    }
  }

  private isLiveYouTube(p: PostRecord): boolean {
    return (
      p.platform === "youtube" &&
      p.mode === "live" &&
      Boolean(p.remoteId) &&
      !p.remoteId?.startsWith("dry-")
    );
  }

  private connected(p: Platform): boolean {
    try {
      return Boolean(this.deps[p]?.status().connected);
    } catch {
      return false;
    }
  }

  /** Posts on this platform that have left (or are leaving) for that local day. */
  private sentOn(platform: Platform, day: Date, except?: string): number {
    return this.posts().filter(
      (p) =>
        p.platform === platform &&
        p.mode === this.mode &&
        p.id !== except &&
        sameDay(new Date(p.at), day) &&
        (["posting", "posted", "draft"].includes(p.status) ||
          (p.status === "scheduled" && Boolean(p.remoteId))),
    ).length;
  }

  private texts(v: VideoDoc): PostTexts {
    let meta: {
      youtube?: Partial<{
        title: string;
        description: string;
        tags: string[];
        categoryId: string;
        containsSyntheticMedia: boolean;
      }>;
      instagram?: { caption?: string; isAiGenerated?: boolean };
      tiktok?: { caption?: string; isAigc?: boolean };
    } = {};
    // Realistic AI audio counts for TikTok's and Meta's labels, so the AI narrator does (D-059).
    const aiLabel = v.disclosure.syntheticMedia || v.disclosure.aiNarration;
    try {
      if (v.metadata) meta = JSON.parse(fs.readFileSync(v.metadata, "utf8"));
    } catch {
      meta = {};
    }
    const hashtags = (n: number) =>
      v.tags
        .slice(0, n)
        .map((t) => `#${t.replace(/[^\p{L}\p{N}]/gu, "")}`)
        .filter((t) => t.length > 1)
        .join(" ");
    return {
      youtube: {
        title: meta.youtube?.title ?? v.title,
        description: meta.youtube?.description ?? v.description,
        tags: meta.youtube?.tags ?? v.tags,
        categoryId: meta.youtube?.categoryId ?? "28",
        synthetic: meta.youtube?.containsSyntheticMedia ?? v.disclosure.syntheticMedia,
      },
      instagram: {
        caption: meta.instagram?.caption ?? `${v.title}\n\n${hashtags(8)}\n\nNarration: AI voice.`,
        ai: (meta.instagram?.isAiGenerated ?? false) || aiLabel,
      },
      tiktok: {
        caption: meta.tiktok?.caption ?? `${v.title} ${hashtags(4)}`,
        aigc: (meta.tiktok?.isAigc ?? false) || aiLabel,
      },
    };
  }

  private planSummary(posts: PostRecord[]): string {
    const parts = posts.map((p) => {
      const how =
        p.how === "kit"
          ? "upload kit"
          : p.platform === "tiktok"
            ? "inbox draft"
            : p.privacy === "unlisted"
              ? "unlisted check"
              : p.platform === "youtube"
                ? "scheduled"
                : "Reel";
      return `${PLATFORM_NAMES[p.platform]} ${how}, ${when(p.at)}`;
    });
    const mode =
      this.mode === "live" ? "Live: approving posts it." : "Dry run: nothing leaves the station.";
    return `${parts.join(" · ")}. ${mode}`;
  }

  private planText(v: VideoDoc, posts: PostRecord[]): string {
    const t = this.texts(v);
    const rows = posts.map((p) => {
      const how =
        p.how === "kit"
          ? "Upload kit (not connected)"
          : p.platform === "youtube"
            ? p.privacy === "unlisted"
              ? "Upload, unlisted (first-upload check)"
              : "Upload with a publish time"
            : p.platform === "instagram"
              ? "Reel"
              : "Draft in your TikTok inbox";
      return `| ${PLATFORM_NAMES[p.platform]} | ${how} | ${when(p.at)} |`;
    });
    const has = (pl: Platform) => posts.some((p) => p.platform === pl);
    const playlist = this.cfg.youtube.playlists[v.channel]?.[v.format];
    const parts = [
      `# Post plan: ${v.title}`,
      `<!-- video:${v.id} -->`,
      this.mode === "live"
        ? "**Mode: live.** Approving this posts the video as planned below."
        : "**Mode: dry run.** Nothing leaves the station; set `PUBLISH_MODE=live` in `.env` to post for real.",
      ["| Platform | How | When |", "|---|---|---|", ...rows].join("\n"),
      `AI disclosure: YouTube's "altered or synthetic content" setting is **${t.youtube.synthetic ? "on" : "off"}** (it covers realistic people, places and events). Instagram's AI info label is **${t.instagram.ai ? "on" : "off"}**, and TikTok's AI-generated label should be **${t.tiktok.aigc ? "on" : "off"}**${v.disclosure.aiNarration ? "; the captions say the narration is an AI voice" : ""}.`,
    ];
    if (has("youtube")) {
      parts.push(
        [
          "## YouTube",
          `**Title:** ${t.youtube.title}`,
          `**Tags:** ${t.youtube.tags.join(", ") || "none"}`,
          playlist ? `**Playlist:** ${playlist}` : "",
          "",
          t.youtube.description
            .slice(0, 1500)
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n"),
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    }
    if (has("instagram"))
      parts.push(`## Instagram caption\n\n\`\`\`\n${t.instagram.caption}\n\`\`\``);
    if (has("tiktok")) {
      parts.push(
        `## TikTok caption\n\n\`\`\`\n${t.tiktok.caption}\n\`\`\`${t.tiktok.aigc ? "\n\nTurn on TikTok's AI-generated content label when you post." : ""}`,
      );
    }
    parts.push(
      "Approve to post as planned. Send it back to cancel; you can plan it again from the Uplink panel.",
    );
    return parts.join("\n\n");
  }

  private kitText(p: PostRecord, v: VideoDoc): string {
    const t = this.texts(v);
    const head = [
      `Orbital Foundry Studio: upload kit for ${PLATFORM_NAMES[p.platform]}`,
      `Video ${v.id}: ${v.title}`,
      `Post at: ${when(p.at)}`,
      "",
    ];
    if (p.platform === "youtube") {
      return [
        ...head,
        "TITLE",
        t.youtube.title,
        "",
        "DESCRIPTION",
        t.youtube.description,
        "",
        "TAGS",
        t.youtube.tags.join(", "),
        "",
        "SETTINGS",
        "- Audience: No, it's not made for kids",
        `- Altered or synthetic content: ${t.youtube.synthetic ? "Yes" : "No"}`,
        "- Subtitles: upload captions.srt (English)",
        "- Thumbnail: thumbnail.png",
        "",
      ].join("\n");
    }
    if (p.platform === "instagram") {
      return [
        ...head,
        "CAPTION",
        t.instagram.caption,
        "",
        "SETTINGS",
        "- Post as a Reel, shared to the feed",
        "- Cover: pick a frame or use thumbnail.png",
        `- AI label (Advanced settings): ${t.instagram.ai ? "on (the narration is an AI voice)" : "off"}`,
        "",
      ].join("\n");
    }
    return [
      ...head,
      "CAPTION",
      t.tiktok.caption,
      "",
      "SETTINGS",
      `- AI-generated content label: ${t.tiktok.aigc ? "on (the narration is an AI voice)" : "off"}`,
      "- Cover: pick a frame",
      "",
    ].join("\n");
  }

  private mark(p: PostRecord, status: PostStatus, detail: string): void {
    p.status = status;
    p.detail = detail;
    this.save(p);
  }

  private save(p: PostRecord): void {
    p.updatedAt = new Date(this.now()).toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO posts (id, video_id, platform, status, at, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, at = excluded.at,
           data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        p.id,
        p.videoId,
        p.platform,
        p.status,
        p.at,
        JSON.stringify(p),
        p.createdAt,
        p.updatedAt,
      );
  }

  private async notice(text: string): Promise<void> {
    this.log(text.split("\n")[0] ?? text);
    try {
      await this.deps.notify?.(text);
    } catch (err) {
      this.log(`phone notice failed: ${errText(err)}`);
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
