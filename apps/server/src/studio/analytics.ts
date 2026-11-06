import fs from "node:fs";
import path from "node:path";
import type { Approval, ArtifactMeta, Lane } from "@orbital/shared";
import type Database from "better-sqlite3";
import YAML from "yaml";
import { z } from "zod";
import type { ModelRouter } from "../llm/router";
import { CONFIG_DIR } from "../paths";
import type { InstagramConnector } from "../uplink/instagram";
import type { Platform, PostRecord } from "../uplink/publisher";
import type { YouTubeConnector } from "../uplink/youtube";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";
import type { Channel } from "./channel";
import type { VideoDoc } from "./editbay";
import type { GpuJob } from "./gpu";
import { DEFAULT_IDEA_WEIGHTS, type Idea, type IdeaWeights, type ScriptDoc } from "./writers";

/**
 * Analytics and the learning loop (Stage 19, D-061). Real stats from the platforms (YouTube
 * Analytics, Instagram Insights, TikTok's numbers entered by hand until its API allows it), each
 * video's cost and shadow cost, progress toward the Partner Program and Creator Rewards, and a
 * weekly retro: WARDEN reads the numbers and proposes new idea-score weights, lessons and a
 * cadence, clamped to small steps, which apply only when the owner approves them.
 */

const tier = z.object({
  subscribers: z.number().min(0),
  watchHours12m: z.number().min(0),
  shortsViews90d: z.number().min(0),
});
export const analyticsConfigSchema = z.object({
  collectEveryHours: z.number().min(1).max(48),
  retro: z.object({
    minVideos: z.number().int().min(1),
    day: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
  }),
  costs: z.object({
    usdPerVoiceCredit: z.number().min(0),
    localGpuUsdPerHour: z.number().min(0),
    renderUsdPerHour: z.number().min(0),
    imageUsd: z.number().min(0),
  }),
  thresholds: z.object({
    youtube: z.object({ early: tier, full: tier, from2027: tier }),
    tiktok: z.object({
      rewards: z.object({
        followers: z.number().min(0),
        views30d: z.number().min(0),
        minVideoSeconds: z.number().min(0),
      }),
    }),
  }),
});
export type AnalyticsConfig = z.infer<typeof analyticsConfigSchema>;

export const DEFAULT_ANALYTICS: AnalyticsConfig = {
  collectEveryHours: 6,
  retro: { minVideos: 3, day: 0, hour: 18 },
  costs: {
    usdPerVoiceCredit: 0.00018,
    localGpuUsdPerHour: 0.04,
    renderUsdPerHour: 0.03,
    imageUsd: 0.003,
  },
  thresholds: {
    youtube: {
      early: { subscribers: 500, watchHours12m: 3000, shortsViews90d: 3_000_000 },
      full: { subscribers: 1000, watchHours12m: 4000, shortsViews90d: 10_000_000 },
      from2027: { subscribers: 1000, watchHours12m: 8000, shortsViews90d: 20_000_000 },
    },
    tiktok: { rewards: { followers: 10_000, views30d: 100_000, minVideoSeconds: 60 } },
  },
};

export function loadAnalyticsConfig(
  file = path.join(CONFIG_DIR, "analytics.yaml"),
): AnalyticsConfig {
  if (!fs.existsSync(file)) return DEFAULT_ANALYTICS;
  const y = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as Partial<AnalyticsConfig>;
  const d = DEFAULT_ANALYTICS;
  return analyticsConfigSchema.parse({
    ...d,
    ...y,
    retro: { ...d.retro, ...y.retro },
    costs: { ...d.costs, ...y.costs },
    thresholds: {
      youtube: { ...d.thresholds.youtube, ...y.thresholds?.youtube },
      tiktok: { ...d.thresholds.tiktok, ...y.thresholds?.tiktok },
    },
  });
}

/** Local YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface PlatformNumbers {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  avgViewSeconds?: number;
  avgViewPercent?: number;
  subscribers?: number;
  watchMinutes?: number;
  /** YouTube: views by traffic source (SHORTS, YT_SEARCH, SUGGESTED…). */
  traffic?: Record<string, number>;
}

/** One platform's metric names, made comparable. */
export function normalize(platform: Platform, m: Record<string, number>): PlatformNumbers {
  const base = {
    views: m.views ?? m.plays ?? 0,
    likes: m.likes ?? 0,
    comments: m.comments ?? 0,
    shares: m.shares ?? 0,
  };
  const extra: Partial<PlatformNumbers> = {};
  if (platform === "youtube") {
    if (m.averageViewDuration !== undefined) extra.avgViewSeconds = m.averageViewDuration;
    if (m.averageViewPercentage !== undefined) extra.avgViewPercent = m.averageViewPercentage;
    if (m.subscribersGained !== undefined) extra.subscribers = m.subscribersGained;
    if (m.estimatedMinutesWatched !== undefined) extra.watchMinutes = m.estimatedMinutesWatched;
    const traffic = Object.entries(m).filter(([k]) => k.startsWith("src."));
    if (traffic.length > 0) {
      extra.traffic = Object.fromEntries(traffic.map(([k, v]) => [k.slice(4), v]));
    }
  } else if (platform === "instagram") {
    if (m.ig_reels_avg_watch_time !== undefined) {
      extra.avgViewSeconds = m.ig_reels_avg_watch_time / 1000;
    }
  } else if (m.avgViewSeconds !== undefined) {
    extra.avgViewSeconds = m.avgViewSeconds;
  }
  return { ...base, ...extra };
}

export interface VideoReport {
  videoId: string;
  title: string;
  format: "short" | "long";
  kind: "main" | "cutdown";
  channel: string;
  scriptId: string;
  ideaId: string | null;
  ideaScores?: Idea["scores"];
  hook?: string;
  duration: number;
  postedAt: string | null;
  ageDays: number;
  platforms: Partial<Record<Platform, PlatformNumbers & { day: string }>>;
  views: number;
  /** usd: money actually spent (Modal, fal); shadowUsd: what all of it would cost on paid tiers. */
  cost: {
    usd: number;
    shadowUsd: number;
    voice: number;
    gpu: number;
    images: number;
    render: number;
  };
}

export interface FormatReport {
  format: "short" | "long";
  videos: number;
  views: number;
  avgViews: number;
  avgViewPercent: number | null;
  shadowUsd: number;
  shadowUsdPer1kViews: number | null;
}

export interface Progress {
  youtube: {
    subscribers: number;
    watchHours12m: number;
    shortsViews90d: number;
    at: string;
    /** 0 to 1 for each tier: the subscriber count and the better of the two paths. */
    tiers: Record<"early" | "full" | "from2027", number>;
  } | null;
  tiktok: {
    followers: number;
    views30d: number;
    at: string;
    rewards: number;
    minVideoSeconds: number;
  } | null;
  instagram: { followers: number; at: string } | null;
}

export interface StudioReport {
  videos: VideoReport[];
  formats: FormatReport[];
  progress: Progress;
  collectedAt: string | null;
}

export const RETRO_TOPICS = ["hooks", "titles", "thumbnails", "topics", "formats"] as const;
export const studioRetroSchema = z.object({
  summary: z.string().min(1).max(1500),
  weights: z.object({
    demand: z.number(),
    originality: z.number(),
    fit: z.number(),
    risk: z.number(),
  }),
  cadence: z.object({ longPerWeek: z.number(), shortsPerDay: z.number() }),
  lessons: z
    .array(z.object({ topic: z.enum(RETRO_TOPICS), text: z.string().min(5).max(240) }))
    .max(6),
});
export type StudioRetroPlan = z.infer<typeof studioRetroSchema>;
export interface Cadence {
  longPerWeek: number;
  shortsPerDay: number;
}

const WEIGHT_KEYS = ["demand", "originality", "fit", "risk"] as const;
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Keeps a plan inside safe bounds whatever the model said: weights move at most 0.05 a week within
 * 0.05 to 0.6 (risk never below 0.1), cadence moves one step within 0 to 2 long-form a week and 1
 * to 3 shorts a day, and at most six distinct lessons.
 */
export function clampRetro(
  plan: StudioRetroPlan,
  current: { weights: IdeaWeights; cadence: Cadence },
): StudioRetroPlan {
  const weights = { ...current.weights };
  for (const k of WEIGHT_KEYS) {
    const want = Number.isFinite(plan.weights[k]) ? plan.weights[k] : current.weights[k];
    const step = clamp(want, current.weights[k] - 0.05, current.weights[k] + 0.05);
    weights[k] = round(clamp(step, k === "risk" ? 0.1 : 0.05, 0.6));
  }
  const step = (want: number, now: number, lo: number, hi: number) =>
    clamp(
      Math.round(Number.isFinite(want) ? want : now),
      Math.max(lo, now - 1),
      Math.min(hi, now + 1),
    );
  const seen = new Set<string>();
  const lessons = plan.lessons
    .map((l) => ({ topic: l.topic, text: l.text.trim().slice(0, 240) }))
    .filter((l) => {
      const key = l.text.toLowerCase();
      if (l.text.length < 5 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
  return {
    summary: plan.summary.trim().slice(0, 1500),
    weights,
    cadence: {
      longPerWeek: step(plan.cadence.longPerWeek, current.cadence.longPerWeek, 0, 2),
      shortsPerDay: step(plan.cadence.shortsPerDay, current.cadence.shortsPerDay, 1, 3),
    },
    lessons,
  };
}

export class NotEnoughStatsError extends Error {}

export interface AnalyticsDeps {
  db: Database.Database;
  store: WorkStore;
  router: ModelRouter;
  lane: Lane;
  director?: WorkDirector;
  videos: { videos(): VideoDoc[]; video(id: string): VideoDoc | null };
  posts: { posts(): PostRecord[] };
  writers: {
    channel(id: string): Channel;
    channels(): Channel[];
    script(id: string): ScriptDoc | null;
    ideas(channelId?: string): Idea[];
    rescore(channelId: string): number;
  };
  youtube?: Pick<
    YouTubeConnector,
    "status" | "stats" | "channelStats" | "byContentType" | "trafficSources"
  >;
  instagram?: Pick<InstagramConnector, "status" | "insights" | "account">;
  gpuJobs?: (scriptId: string) => GpuJob[];
  config?: AnalyticsConfig;
  say?: (role: string, text: string) => void;
  log?: (message: string) => void;
  now?: () => number;
}

export class StudioAnalytics {
  private readonly now: () => number;
  private readonly cfg: AnalyticsConfig;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly deps: AnalyticsDeps) {
    this.now = deps.now ?? Date.now;
    this.cfg = deps.config ?? DEFAULT_ANALYTICS;
    deps.director?.onDecision((a) => this.onDecision(a));
  }

  // -- What the Writers' Room reads ----------------------------------------------------------------

  weights(channelId: string): IdeaWeights {
    const saved = this.json<IdeaWeights>(`studio.weights.${channelId}`);
    return saved ? { ...DEFAULT_IDEA_WEIGHTS, ...saved } : { ...DEFAULT_IDEA_WEIGHTS };
  }

  lessons(channelId: string): string[] {
    return (this.json<{ topic: string; text: string }[]>(`studio.lessons.${channelId}`) ?? []).map(
      (l) => `${l.topic[0]?.toUpperCase() ?? ""}${l.topic.slice(1)}: ${l.text}`,
    );
  }

  /** The approved cadence, or the channel bible's. */
  cadence(channelId: string): Cadence {
    const saved = this.json<Cadence>(`studio.cadence.${channelId}`);
    if (saved) return saved;
    const c = this.deps.writers.channel(channelId).cadence;
    return { longPerWeek: c.longPerWeek, shortsPerDay: c.shortsPerDay };
  }

  // -- Stats ----------------------------------------------------------------------------------------

  /** Live posts that reached a platform. Dry runs have no stats. */
  livePosts(): PostRecord[] {
    return this.deps.posts
      .posts()
      .filter(
        (p) =>
          p.mode === "live" &&
          Boolean(p.remoteId) &&
          !p.remoteId?.startsWith("dry-") &&
          ["posted", "scheduled", "draft"].includes(p.status) &&
          Date.parse(p.at) <= this.now(),
      );
  }

  /** Fetches today's numbers from every connected platform. */
  async collect(): Promise<{ snapshots: number; errors: string[] }> {
    const day = localDay(this.now());
    const errors: string[] = [];
    let snapshots = 0;
    const posts = this.livePosts();
    const yt = this.deps.youtube;
    if (yt?.status().connected) {
      const mine = posts.filter((p) => p.platform === "youtube");
      if (mine.length > 0) {
        try {
          const start = mine.map((p) => localDay(Date.parse(p.at))).sort()[0] ?? day;
          const stats = await yt.stats(
            mine.map((p) => p.remoteId as string),
            start,
            day,
          );
          for (const p of mine) {
            const id = p.remoteId as string;
            // Traffic sources are a report of their own, one video at a time (no quota cost).
            const sources = await yt.trafficSources(id, start, day).catch(() => ({}));
            const traffic = Object.fromEntries(
              Object.entries(sources).map(([k, v]) => [`src.${k}`, v]),
            );
            this.saveSnapshot(p, day, { ...(stats[id] ?? {}), ...traffic });
            snapshots += 1;
          }
        } catch (err) {
          errors.push(`YouTube stats: ${String(err).slice(0, 200)}`);
        }
      }
      try {
        const ch = await yt.channelStats();
        const year = await yt.byContentType(localDay(this.now() - 365 * 86_400_000), day);
        const quarter = await yt.byContentType(localDay(this.now() - 90 * 86_400_000), day);
        this.deps.store.setKv(
          "analytics.youtube",
          JSON.stringify({
            subscribers: ch.subscribers,
            views: ch.views,
            watchHours12m: Math.round((year.VIDEO_ON_DEMAND?.minutes ?? 0) / 60),
            shortsViews90d: quarter.SHORTS?.views ?? 0,
            at: new Date(this.now()).toISOString(),
          }),
        );
      } catch (err) {
        errors.push(`YouTube channel: ${String(err).slice(0, 200)}`);
      }
    }
    const ig = this.deps.instagram;
    if (ig?.status().connected) {
      for (const p of posts.filter((x) => x.platform === "instagram")) {
        try {
          this.saveSnapshot(p, day, await ig.insights(p.remoteId as string));
          snapshots += 1;
        } catch (err) {
          errors.push(`Instagram ${p.id}: ${String(err).slice(0, 200)}`);
        }
      }
      try {
        const a = await ig.account();
        this.deps.store.setKv(
          "analytics.instagram",
          JSON.stringify({ followers: a.followers, at: new Date(this.now()).toISOString() }),
        );
      } catch (err) {
        errors.push(`Instagram account: ${String(err).slice(0, 200)}`);
      }
    }
    this.deps.store.setKv("analytics.collectedAt", new Date(this.now()).toISOString());
    for (const e of errors) this.deps.log?.(e);
    return { snapshots, errors };
  }

  /** Numbers typed in by hand (TikTok, until its API gives them). */
  record(postId: string, metrics: Record<string, number>): void {
    const p = this.deps.posts.posts().find((x) => x.id === postId);
    if (!p) throw new Error(`No post "${postId}".`);
    this.saveSnapshot(p, localDay(this.now()), metrics);
  }

  /** Account numbers typed in by hand, e.g. TikTok's followers and 30-day views. */
  recordAccount(platform: Platform, numbers: Record<string, number>): void {
    const key = `analytics.${platform}`;
    const old = this.json<Record<string, unknown>>(key) ?? {};
    this.deps.store.setKv(
      key,
      JSON.stringify({ ...old, ...numbers, at: new Date(this.now()).toISOString() }),
    );
  }

  report(channelId?: string): StudioReport {
    const byVideo = new Map<string, PostRecord[]>();
    for (const p of this.livePosts()) {
      if (channelId && p.channel !== channelId) continue;
      byVideo.set(p.videoId, [...(byVideo.get(p.videoId) ?? []), p]);
    }
    const videos: VideoReport[] = [];
    for (const [id, posts] of byVideo) {
      const v = this.deps.videos.video(id);
      if (v) videos.push(this.videoReport(v, posts));
    }
    videos.sort((a, b) => b.views - a.views);
    const formats = (["short", "long"] as const).map((format): FormatReport => {
      const list = videos.filter((v) => v.format === format);
      const views = list.reduce((n, v) => n + v.views, 0);
      const pcts = list.flatMap((v) =>
        v.platforms.youtube?.avgViewPercent !== undefined
          ? [v.platforms.youtube.avgViewPercent]
          : [],
      );
      const shadow = list.reduce((n, v) => n + v.cost.shadowUsd, 0);
      return {
        format,
        videos: list.length,
        views,
        avgViews: list.length ? Math.round(views / list.length) : 0,
        avgViewPercent: pcts.length
          ? round(pcts.reduce((a, b) => a + b, 0) / pcts.length, 1)
          : null,
        shadowUsd: round(shadow, 2),
        shadowUsdPer1kViews: views > 0 ? round((shadow / views) * 1000, 3) : null,
      };
    });
    return {
      videos,
      formats,
      progress: this.progress(),
      collectedAt: this.deps.store.getKv("analytics.collectedAt"),
    };
  }

  progress(): Progress {
    const t = this.cfg.thresholds;
    const yt = this.json<{
      subscribers: number;
      watchHours12m: number;
      shortsViews90d: number;
      at: string;
    }>("analytics.youtube");
    const tt = this.json<{ followers?: number; views30d?: number; at: string }>("analytics.tiktok");
    const ig = this.json<{ followers?: number; at: string }>("analytics.instagram");
    const share = (have: number, need: number) => (need <= 0 ? 1 : clamp(have / need, 0, 1));
    const tierOf = (x: z.infer<typeof tier>) =>
      yt
        ? round(
            Math.min(
              share(yt.subscribers, x.subscribers),
              Math.max(
                share(yt.watchHours12m, x.watchHours12m),
                share(yt.shortsViews90d, x.shortsViews90d),
              ),
            ),
          )
        : 0;
    return {
      youtube: yt
        ? {
            ...yt,
            tiers: {
              early: tierOf(t.youtube.early),
              full: tierOf(t.youtube.full),
              from2027: tierOf(t.youtube.from2027),
            },
          }
        : null,
      tiktok: tt
        ? {
            followers: tt.followers ?? 0,
            views30d: tt.views30d ?? 0,
            at: tt.at,
            rewards: round(
              Math.min(
                share(tt.followers ?? 0, t.tiktok.rewards.followers),
                share(tt.views30d ?? 0, t.tiktok.rewards.views30d),
              ),
            ),
            minVideoSeconds: t.tiktok.rewards.minVideoSeconds,
          }
        : null,
      instagram: ig ? { followers: ig.followers ?? 0, at: ig.at } : null,
    };
  }

  /** One line of real numbers for WARDEN's daily standup. */
  standupFacts(): string {
    const r = this.report();
    if (r.videos.length === 0) {
      return "Studio: nothing posted live yet (posting is a dry run until PUBLISH_MODE=live).";
    }
    const best = r.videos[0];
    const yt = r.progress.youtube;
    return [
      `Studio: ${r.videos.length} posted video(s), ${r.videos.reduce((n, v) => n + v.views, 0)} views in all`,
      best ? `best "${best.title}" with ${best.views}` : "",
      yt
        ? `YouTube ${yt.subscribers} subscribers, ${yt.watchHours12m} watch hours (12 months), ${yt.shortsViews90d} Shorts views (90 days)`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
  }

  // -- The weekly retro -----------------------------------------------------------------------------

  async retro(channelId: string): Promise<{ plan: StudioRetroPlan; artifact: ArtifactMeta }> {
    const channel = this.deps.writers.channel(channelId);
    const report = this.report(channelId);
    const ready = report.videos.filter(
      (v) => v.ageDays >= 2 && Object.keys(v.platforms).length > 0,
    );
    if (ready.length < this.cfg.retro.minVideos) {
      throw new NotEnoughStatsError(
        `The retro needs ${this.cfg.retro.minVideos} posted videos with two days of stats; there ${ready.length === 1 ? "is" : "are"} ${ready.length}.`,
      );
    }
    const current = { weights: this.weights(channelId), cadence: this.cadence(channelId) };
    const lines = ready.slice(0, 30).map((v) => {
      const yt = v.platforms.youtube;
      const s = v.ideaScores;
      return [
        `- "${v.title}" (${v.format}${v.kind === "cutdown" ? " cut from a long-form" : ""}, ${Math.round(v.duration)} s, ${v.ageDays} days old)`,
        `${v.views} views (${Math.round(v.views / Math.max(1, v.ageDays))} a day)`,
        yt?.avgViewPercent !== undefined ? `${yt.avgViewPercent}% viewed on YouTube` : "",
        yt?.subscribers !== undefined ? `${yt.subscribers} subscribers gained` : "",
        yt?.traffic
          ? `YouTube views from ${Object.entries(yt.traffic)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 3)
              .map(([k, n]) => `${k} ${n}`)
              .join(", ")}`
          : "",
        `${Object.values(v.platforms).reduce((n, p) => n + (p?.likes ?? 0), 0)} likes`,
        s
          ? `idea ratings: demand ${s.demand}, originality ${s.originality}, fit ${s.fit}, risk ${s.risk}`
          : "",
        v.hook ? `hook: "${v.hook}"` : "",
        `shadow cost $${v.cost.shadowUsd}`,
      ]
        .filter(Boolean)
        .join("; ");
    });
    const facts = [
      `Channel: ${channel.name} (${channel.niche}).`,
      `Videos with stats:\n${lines.join("\n")}`,
      `By format: ${JSON.stringify(report.formats)}`,
      `Progress: ${JSON.stringify(report.progress)}`,
      `Current idea weights: ${JSON.stringify(current.weights)}`,
      `Current cadence: ${current.cadence.longPerWeek} long-form a week, ${current.cadence.shortsPerDay} shorts a day.`,
      `Current lessons: ${this.lessons(channelId).join(" | ") || "none"}`,
      `TikTok's Creator Rewards pay only for videos over ${this.cfg.thresholds.tiktok.rewards.minVideoSeconds} s.`,
    ].join("\n");
    const res = await this.deps.router.generate({
      tier: "reasoning",
      lane: this.deps.lane,
      schema: studioRetroSchema,
      system: [
        "You are WARDEN, the Overseer of a faceless video studio. Read this week's numbers and propose next week's changes. Use only the numbers given; never invent any.",
        "weights: how much each idea rating counts (demand, originality and fit add; risk subtracts). Move weight toward the ratings of the videos that did best, in small steps.",
        "cadence: long-form videos a week and shorts a day. Change it only when the numbers clearly favour one format.",
        "lessons: up to six short, specific lessons on hooks, titles, thumbnails, topics or formats, each tied to the numbers.",
        "summary: what happened, in three to five sentences.",
        "Reply with the JSON object alone.",
      ].join("\n"),
      prompt: facts,
      maxTokens: 1_400,
      purpose: "studio retro",
    });
    const raw = res.data as StudioRetroPlan | undefined;
    if (!raw) throw new Error("No retro plan came back.");
    const plan = clampRetro(raw, current);
    const artifact = this.writeRetro(channel, plan, current, ready);
    this.deps.director?.fileDeskItem({
      kind: "deliverable",
      title: `Studio retro: ${channel.name}`,
      summary: `${plan.summary.slice(0, 280)} Approve to apply the new weights, ${plan.lessons.length} lesson(s) and the cadence.`,
      requestedBy: "warden",
      objectiveId: null,
      taskId: null,
      artifactId: artifact.id,
      action: null,
    });
    this.deps.store.setKv(`studio.lastRetro.${channelId}`, new Date(this.now()).toISOString());
    return { plan, artifact };
  }

  /** Applies an approved plan (clamped again, in case the rules tightened since). */
  apply(channelId: string, proposed: StudioRetroPlan): void {
    const current = { weights: this.weights(channelId), cadence: this.cadence(channelId) };
    const plan = clampRetro(proposed, current);
    this.deps.store.setKv(`studio.weights.${channelId}`, JSON.stringify(plan.weights));
    this.deps.store.setKv(`studio.cadence.${channelId}`, JSON.stringify(plan.cadence));
    const old = this.json<{ topic: string; text: string }[]>(`studio.lessons.${channelId}`) ?? [];
    const merged = [
      ...plan.lessons,
      ...old.filter((o) => !plan.lessons.some((l) => l.text === o.text)),
    ];
    this.deps.store.setKv(`studio.lessons.${channelId}`, JSON.stringify(merged.slice(0, 12)));
    const moved = this.deps.writers.rescore(channelId);
    this.deps.say?.("overseer", `New studio plan in effect; ${moved} idea(s) re-ranked.`);
  }

  // -- Timers ---------------------------------------------------------------------------------------

  start(everyMs = 10 * 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Collects when due, and runs the weekly retro on its day when there are enough stats. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const last = Date.parse(this.deps.store.getKv("analytics.collectedAt") ?? "") || 0;
      if (
        this.livePosts().length > 0 &&
        this.now() - last >= this.cfg.collectEveryHours * 3_600_000
      ) {
        await this.collect();
      }
      const now = new Date(this.now());
      if (now.getDay() !== this.cfg.retro.day || now.getHours() < this.cfg.retro.hour) return;
      for (const ch of this.deps.writers.channels().filter((c) => c.status === "active")) {
        const lastRetro = Date.parse(this.deps.store.getKv(`studio.lastRetro.${ch.id}`) ?? "") || 0;
        if (this.now() - lastRetro < 6 * 86_400_000) continue;
        try {
          await this.retro(ch.id);
        } catch (err) {
          if (!(err instanceof NotEnoughStatsError))
            this.deps.log?.(`retro ${ch.id}: ${String(err)}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // -- Internals ------------------------------------------------------------------------------------

  private videoReport(v: VideoDoc, posts: PostRecord[]): VideoReport {
    const platforms: VideoReport["platforms"] = {};
    for (const p of posts) {
      const row = this.deps.db
        .prepare("SELECT data, day FROM video_stats WHERE post_id = ? ORDER BY day DESC LIMIT 1")
        .get(p.id) as { data: string; day: string } | undefined;
      if (!row) continue;
      platforms[p.platform] = {
        ...normalize(p.platform, JSON.parse(row.data) as Record<string, number>),
        day: row.day,
      };
    }
    const postedAt = posts.map((p) => p.at).sort()[0] ?? null;
    const script = this.deps.writers.script(v.scriptId);
    const idea = script?.ideaId
      ? this.deps.writers.ideas(v.channel).find((i) => i.id === script.ideaId)
      : undefined;
    return {
      videoId: v.id,
      title: v.title,
      format: v.format,
      kind: v.kind,
      channel: v.channel,
      scriptId: v.scriptId,
      ideaId: script?.ideaId ?? null,
      ...(idea?.scores ? { ideaScores: idea.scores } : {}),
      ...(v.kind === "main" && script?.hooks[0] ? { hook: script.hooks[0] } : {}),
      duration: v.duration ?? 0,
      postedAt,
      ageDays: postedAt ? Math.floor((this.now() - Date.parse(postedAt)) / 86_400_000) : 0,
      platforms,
      views: Object.values(platforms).reduce((n, p) => n + (p?.views ?? 0), 0),
      cost: this.costs(v),
    };
  }

  private costs(v: VideoDoc): VideoReport["cost"] {
    const c = this.cfg.costs;
    const voice = (v.voice?.units ?? 0) * c.usdPerVoiceCredit;
    // AI clips belong to the script; count them once, on the main video.
    const jobs = v.kind === "main" ? (this.deps.gpuJobs?.(v.scriptId) ?? []) : [];
    const spent = jobs.reduce(
      (n, j) => n + (j.provider === "comfyui-video" ? 0 : (j.costUsd ?? 0)),
      0,
    );
    const local = jobs.reduce(
      (n, j) =>
        n + (j.provider === "comfyui-video" ? ((j.seconds ?? 0) / 3600) * c.localGpuUsdPerHour : 0),
      0,
    );
    const images = v.shots.filter((s) => s.got === "ai-still").length * c.imageUsd;
    const render = ((v.renderSeconds ?? 0) / 3600) * c.renderUsdPerHour;
    return {
      usd: round(spent),
      shadowUsd: round(voice + spent + local + images + render),
      voice: round(voice),
      gpu: round(spent + local),
      images: round(images),
      render: round(render),
    };
  }

  private writeRetro(
    channel: Channel,
    plan: StudioRetroPlan,
    current: { weights: IdeaWeights; cadence: Cadence },
    videos: VideoReport[],
  ): ArtifactMeta {
    const w = (k: keyof IdeaWeights) => `| ${k} | ${current.weights[k]} | ${plan.weights[k]} |`;
    const md = [
      `# Studio retro: ${channel.name}`,
      plan.summary,
      "## The numbers",
      [
        "| Video | Format | Views | Viewed (YouTube) | Shadow cost |",
        "|---|---|---|---|---|",
        ...videos
          .slice(0, 15)
          .map(
            (v) =>
              `| ${v.title.replace(/\|/g, "/")} | ${v.format} | ${v.views} | ${v.platforms.youtube?.avgViewPercent !== undefined ? `${v.platforms.youtube.avgViewPercent}%` : "–"} | $${v.cost.shadowUsd} |`,
          ),
      ].join("\n"),
      "## Idea-score weights",
      ["| Rating | Now | Proposed |", "|---|---|---|", ...WEIGHT_KEYS.map(w)].join("\n"),
      `## Cadence\n\nLong-form a week: ${current.cadence.longPerWeek} → **${plan.cadence.longPerWeek}**. Shorts a day: ${current.cadence.shortsPerDay} → **${plan.cadence.shortsPerDay}**.`,
      plan.lessons.length
        ? `## Lessons for the Writers' Room\n\n${plan.lessons.map((l) => `- **${l.topic}:** ${l.text}`).join("\n")}`
        : "",
      "Approve to apply these from the next ideas and scripts on. Send it back to keep things as they are.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const meta: ArtifactMeta = {
      id: this.deps.store.nextId("F"),
      kind: "studio.retro",
      title: `Studio retro: ${channel.name}`,
      mime: "text/markdown",
      taskId: null,
      objectiveId: null,
      createdBy: "warden",
      createdAt: this.now(),
      size: md.length,
      room: null,
      info: { channel: channel.id, plan },
    };
    this.deps.store.saveArtifact(meta, md);
    return meta;
  }

  private onDecision = async (a: Approval): Promise<void> => {
    if (!a.artifactId || a.status !== "approved") return;
    const art = this.deps.store.artifact(a.artifactId);
    if (art?.meta.kind !== "studio.retro") return;
    const channel = String(art.meta.info?.channel ?? "");
    const plan = art.meta.info?.plan as StudioRetroPlan | undefined;
    if (!channel || !plan) return;
    this.apply(channel, plan);
  };

  private saveSnapshot(p: PostRecord, day: string, metrics: Record<string, number>): void {
    this.deps.db
      .prepare(
        `INSERT INTO video_stats (post_id, video_id, platform, day, data, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (post_id, day) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      )
      .run(
        p.id,
        p.videoId,
        p.platform,
        day,
        JSON.stringify(metrics),
        new Date(this.now()).toISOString(),
      );
  }

  private json<T>(key: string): T | null {
    const raw = this.deps.store.getKv(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
