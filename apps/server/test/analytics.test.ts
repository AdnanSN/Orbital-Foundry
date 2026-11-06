import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Approval } from "@orbital/shared";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import type { ModelRouter } from "../src/llm/router";
import {
  clampRetro,
  DEFAULT_ANALYTICS,
  localDay,
  NotEnoughStatsError,
  normalize,
  StudioAnalytics,
  type StudioRetroPlan,
} from "../src/studio/analytics";
import { type Channel, channelSchema } from "../src/studio/channel";
import type { VideoDoc } from "../src/studio/editbay";
import type { GpuJob } from "../src/studio/gpu";
import { type Idea, type ScriptDoc, scoreIdea, WritersRoom } from "../src/studio/writers";
import type { PostRecord } from "../src/uplink/publisher";
import type { WorkDirector } from "../src/work/director";
import { WorkStore } from "../src/work/store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-analytics-"));
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
  fs.rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400_000;
/** Thursday 5 November 2026, 10:00 local time. */
const T0 = new Date(2026, 10, 5, 10, 0).getTime();

const channel: Channel = channelSchema.parse({
  id: "phenomena",
  status: "active",
  name: "Orbital Foundry Studio",
  handle: "@orbitalfoundry",
  niche: "Rare phenomena of Earth and space",
  audience: "Curious adults",
  persona: "A calm narrator; the narration is an AI voice.",
  style: { tone: "Clear" },
  voice: { kokoro: "am_michael" },
});

function video(id: string, extra: Partial<VideoDoc> = {}): VideoDoc {
  const iso = new Date(T0 - 5 * DAY).toISOString();
  return {
    id,
    scriptId: `S-${id}`,
    channel: channel.id,
    format: "short",
    kind: "main",
    test: false,
    status: "posted",
    stage: "done",
    progress: 100,
    title: `Video ${id}`,
    titles: [],
    description: "",
    tags: [],
    duration: 45,
    renderSeconds: 3600,
    voice: { provider: "elevenlabs", units: 1000 },
    shots: [
      { beat: 0, start: 0, duration: 5, want: "ai-still", got: "ai-still" },
      { beat: 1, start: 5, duration: 5, want: "ai-still", got: "ai-still" },
      { beat: 2, start: 10, duration: 5, want: "stock-video", got: "stock-video" },
    ],
    assets: [],
    disclosure: { syntheticMedia: false, aiNarration: true },
    lane: "live",
    createdAt: iso,
    updatedAt: iso,
    ...extra,
  };
}

function post(
  id: string,
  videoId: string,
  platform: PostRecord["platform"],
  extra: Partial<PostRecord> = {},
): PostRecord {
  const iso = new Date(T0 - 3 * DAY).toISOString();
  return {
    id,
    videoId,
    channel: channel.id,
    platform,
    format: "short",
    title: `Video ${videoId}`,
    status: platform === "tiktok" ? "draft" : "posted",
    mode: "live",
    how: "api",
    at: iso,
    remoteId: `${platform}-${id}`,
    warnings: [],
    createdAt: iso,
    updatedAt: iso,
    ...extra,
  };
}

function setup(opts: { videos?: VideoDoc[]; posts?: PostRecord[]; plan?: StudioRetroPlan } = {}) {
  const dir = fs.mkdtempSync(path.join(root, "a-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => db.close());
  const store = new WorkStore(db);
  let now = T0;
  const videos = opts.videos ?? [video("V-1")];
  const posts = opts.posts ?? [
    post("U-1", "V-1", "youtube"),
    post("U-2", "V-1", "instagram"),
    post("U-3", "V-2", "youtube", { mode: "dry-run", remoteId: "dry-youtube-U-3" }),
    post("U-4", "V-1", "youtube", {
      status: "scheduled",
      at: new Date(T0 + DAY).toISOString(),
      remoteId: "yt-later",
    }),
    post("U-5", "V-1", "tiktok"),
  ];
  const calls = { stats: [] as unknown[][], prompts: [] as string[], rescored: 0 };
  const youtube = {
    status: () => ({ connected: true }),
    stats: async (ids: string[], start: string, end: string) => {
      calls.stats.push([ids, start, end]);
      return Object.fromEntries(
        ids.map((i) => [
          i,
          {
            views: 1200,
            averageViewPercentage: 64.5,
            averageViewDuration: 29,
            subscribersGained: 7,
            likes: 80,
            comments: 5,
            shares: 3,
            estimatedMinutesWatched: 580,
          },
        ]),
      );
    },
    channelStats: async () => ({ subscribers: 120, views: 5000, videos: 4 }),
    trafficSources: async () => ({ SHORTS: 1000, YT_SEARCH: 150, SUGGESTED: 50 }),
    byContentType: async (start: string) =>
      start === localDay(now - 365 * DAY)
        ? {
            VIDEO_ON_DEMAND: { views: 900, minutes: 30_000 },
            SHORTS: { views: 400_000, minutes: 900 },
          }
        : { SHORTS: { views: 250_000, minutes: 800 } },
  };
  const instagram = {
    status: () => ({ connected: true }),
    insights: async () => ({
      views: 800,
      likes: 40,
      comments: 2,
      shares: 6,
      saved: 3,
      ig_reels_avg_watch_time: 7400,
    }),
    account: async () => ({ followers: 75, media: 3 }),
  };
  const idea: Idea = {
    id: "I-1",
    channel: channel.id,
    title: "Ball lightning",
    angle: "How we know",
    format: "short",
    hook: "A glowing ball drifts through a kitchen.",
    score: 6,
    scores: { demand: 8, originality: 6, fit: 7, risk: 2 },
    why: "",
    wikipedia: [],
    status: "scripted",
    createdAt: "",
  };
  const writers = {
    channel: () => channel,
    channels: () => [channel],
    script: (id: string) =>
      ({ id, ideaId: "I-1", hooks: ["A glowing ball drifts through a kitchen."] }) as ScriptDoc,
    ideas: () => [idea],
    rescore: () => {
      calls.rescored += 1;
      return 2;
    },
  };
  const desk: Approval[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  const director = {
    fileDeskItem: (f: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">) => {
      const a = {
        ...f,
        id: `A-${desk.length + 1}`,
        status: "pending",
        createdAt: 0,
        decidedAt: null,
        note: null,
      } as Approval;
      desk.push(a);
      return a;
    },
    onDecision: (h: (a: Approval) => void | Promise<void>) => hooks.push(h),
  } as unknown as WorkDirector;
  const plan: StudioRetroPlan = opts.plan ?? {
    summary: "Shorts with a number in the hook held viewers longer.",
    weights: { demand: 0.9, originality: 0, fit: 0.25, risk: 0 },
    cadence: { longPerWeek: 5, shortsPerDay: 0 },
    lessons: [
      { topic: "hooks", text: "Open with the number, not the question." },
      { topic: "hooks", text: "Open with the number, not the question." },
      { topic: "titles", text: "Name the phenomenon in the first three words." },
    ],
  };
  const router = {
    generate: async (req: { prompt: string }) => {
      calls.prompts.push(req.prompt);
      return { data: plan, text: "", provider: "fake", model: "m", lane: "live" };
    },
  } as unknown as ModelRouter;
  const jobs: GpuJob[] = [
    {
      id: "G-1",
      scriptId: "S-V-1",
      beat: 0,
      prompt: "p",
      orientation: "portrait",
      lane: "live",
      status: "done",
      deadline: "",
      attempts: 1,
      provider: "modal-video",
      costUsd: 0.12,
      seconds: 200,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "G-2",
      scriptId: "S-V-1",
      beat: 3,
      prompt: "q",
      orientation: "portrait",
      lane: "live",
      status: "done",
      deadline: "",
      attempts: 1,
      provider: "comfyui-video",
      costUsd: 0,
      seconds: 1800,
      createdAt: "",
      updatedAt: "",
    },
  ];
  const analytics = new StudioAnalytics({
    db,
    store,
    router,
    lane: "live",
    director,
    videos: {
      videos: () => videos,
      video: (id) => videos.find((v) => v.id === id) ?? null,
    },
    posts: { posts: () => posts },
    writers,
    youtube: youtube as never,
    instagram: instagram as never,
    gpuJobs: (scriptId) => jobs.filter((j) => j.scriptId === scriptId),
    config: DEFAULT_ANALYTICS,
    now: () => now,
  });
  const decide = async (a: Approval, status: "approved" | "rejected") => {
    for (const h of hooks) await h({ ...a, status } as Approval);
  };
  return {
    analytics,
    store,
    desk,
    decide,
    calls,
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe("analytics helpers", () => {
  it("makes the platforms' numbers comparable", () => {
    expect(
      normalize("youtube", { views: 10, averageViewPercentage: 50, averageViewDuration: 20 }),
    ).toEqual({
      views: 10,
      likes: 0,
      comments: 0,
      shares: 0,
      avgViewPercent: 50,
      avgViewSeconds: 20,
    });
    expect(normalize("instagram", { views: 5, ig_reels_avg_watch_time: 2500 }).avgViewSeconds).toBe(
      2.5,
    );
    expect(normalize("tiktok", { plays: 7 }).views).toBe(7);
  });

  it("keeps a retro plan to small, safe steps", () => {
    const current = {
      weights: { demand: 0.35, originality: 0.25, fit: 0.25, risk: 0.15 },
      cadence: { longPerWeek: 1, shortsPerDay: 1 },
    };
    const plan = clampRetro(
      {
        summary: " ok ",
        weights: { demand: 0.9, originality: -1, fit: Number.NaN, risk: 0 },
        cadence: { longPerWeek: 7, shortsPerDay: 0 },
        lessons: Array.from({ length: 9 }, (_x, i) => ({
          topic: "hooks" as const,
          text: `Lesson number ${i % 7}`,
        })),
      },
      current,
    );
    expect(plan.weights).toEqual({ demand: 0.4, originality: 0.2, fit: 0.25, risk: 0.1 });
    expect(plan.cadence).toEqual({ longPerWeek: 2, shortsPerDay: 1 });
    expect(plan.lessons).toHaveLength(6);
    expect(plan.summary).toBe("ok");
  });
});

describe("studio analytics", () => {
  it("collects live stats only, and counts the Partner Program numbers", async () => {
    const t = setup();
    const res = await t.analytics.collect();
    expect(res).toEqual({ snapshots: 2, errors: [] });
    expect(t.calls.stats).toEqual([[["youtube-U-1"], localDay(T0 - 3 * DAY), localDay(T0)]]);
    const yt = JSON.parse(t.store.getKv("analytics.youtube") ?? "{}");
    expect(yt).toMatchObject({ subscribers: 120, watchHours12m: 500, shortsViews90d: 250_000 });

    t.analytics.record("U-5", { views: 3000, likes: 100 });
    t.analytics.recordAccount("tiktok", { followers: 2500, views30d: 40_000 });
    const r = t.analytics.report();
    expect(r.videos).toHaveLength(1);
    const v = r.videos[0];
    expect(v?.views).toBe(1200 + 800 + 3000);
    expect(v?.platforms.youtube).toMatchObject({
      avgViewPercent: 64.5,
      subscribers: 7,
      traffic: { SHORTS: 1000, YT_SEARCH: 150, SUGGESTED: 50 },
    });
    expect(v?.platforms.instagram?.avgViewSeconds).toBeCloseTo(7.4);
    expect(v?.ideaScores).toEqual({ demand: 8, originality: 6, fit: 7, risk: 2 });
    // Voice 1,000 credits, two AI stills, an hour of rendering, a Modal clip and a local one.
    expect(v?.cost).toEqual({
      usd: 0.12,
      shadowUsd: 0.356,
      voice: 0.18,
      gpu: 0.14,
      images: 0.006,
      render: 0.03,
    });
    expect(r.formats[0]).toMatchObject({
      format: "short",
      videos: 1,
      views: 5000,
      avgViewPercent: 64.5,
    });
    expect(r.progress.youtube?.tiers).toEqual({ early: 0.167, full: 0.12, from2027: 0.063 });
    expect(r.progress.tiktok).toMatchObject({ rewards: 0.25, minVideoSeconds: 60 });
    expect(r.progress.instagram?.followers).toBe(75);
    expect(t.analytics.standupFacts()).toContain("1 posted video(s), 5000 views");
  });

  it("runs the weekly retro on real numbers, and applies it only when approved", async () => {
    const few = setup();
    await few.analytics.collect();
    await expect(few.analytics.retro(channel.id)).rejects.toBeInstanceOf(NotEnoughStatsError);

    const t = setup({
      videos: [video("V-1"), video("V-2", { format: "long" }), video("V-3")],
      posts: [
        post("U-1", "V-1", "youtube"),
        post("U-2", "V-2", "youtube"),
        post("U-3", "V-3", "youtube"),
      ],
    });
    await t.analytics.collect();
    const { plan } = await t.analytics.retro(channel.id);
    expect(t.calls.prompts[0]).toContain("64.5% viewed on YouTube");
    expect(t.calls.prompts[0]).toContain("idea ratings: demand 8");
    expect(t.calls.prompts[0]).toContain("YouTube views from SHORTS 1000, YT_SEARCH 150");
    expect(plan.weights).toEqual({ demand: 0.4, originality: 0.2, fit: 0.25, risk: 0.1 });
    expect(plan.cadence).toEqual({ longPerWeek: 2, shortsPerDay: 1 });
    expect(plan.lessons).toHaveLength(2);
    expect(t.desk[0]?.title).toBe("Studio retro: Orbital Foundry Studio");
    expect(t.store.artifact(t.desk[0]?.artifactId as string)?.meta.kind).toBe("studio.retro");
    // Nothing changes until the owner approves.
    expect(t.analytics.weights(channel.id).demand).toBe(0.35);
    await t.decide(t.desk[0] as Approval, "approved");
    expect(t.analytics.weights(channel.id)).toEqual(plan.weights);
    expect(t.analytics.cadence(channel.id)).toEqual({ longPerWeek: 2, shortsPerDay: 1 });
    expect(t.analytics.lessons(channel.id)).toEqual([
      "Hooks: Open with the number, not the question.",
      "Titles: Name the phenomenon in the first three words.",
    ]);
    expect(t.calls.rescored).toBe(1);
  });

  it("runs the retro by itself on Sunday evening, once a week", async () => {
    const t = setup({
      videos: [video("V-1"), video("V-2"), video("V-3")],
      posts: [
        post("U-1", "V-1", "youtube"),
        post("U-2", "V-2", "youtube"),
        post("U-3", "V-3", "youtube"),
      ],
    });
    await t.analytics.tick();
    expect(t.desk).toHaveLength(0);
    // Sunday 8 November, 18:30.
    t.setNow(new Date(2026, 10, 8, 18, 30).getTime());
    await t.analytics.tick();
    expect(t.desk).toHaveLength(1);
    await t.analytics.tick();
    expect(t.desk).toHaveLength(1);
  });
});

describe("learning in the Writers' Room", () => {
  it("scores ideas with the approved weights and re-ranks the backlog", () => {
    expect(scoreIdea({ demand: 8, originality: 4, fit: 6, risk: 2 })).toBe(5);
    const dir = fs.mkdtempSync(path.join(root, "w-"));
    const db = openDb(path.join(dir, "station.db"));
    cleanups.push(() => db.close());
    const writers = new WritersRoom({
      router: {} as never,
      lane: "live",
      web: {} as never,
      signals: {} as never,
      store: new WorkStore(db),
      db,
      dir,
    });
    const insert = db.prepare(
      "INSERT INTO ideas (id, channel, title, score, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const [id, scores] of [
      ["I-1", { demand: 9, originality: 2, fit: 5, risk: 1 }],
      ["I-2", { demand: 3, originality: 9, fit: 5, risk: 1 }],
    ] as const) {
      const idea = {
        id,
        channel: "phenomena",
        title: id,
        angle: "",
        format: "short",
        hook: "",
        score: scoreIdea(scores),
        scores,
        why: "",
        wikipedia: [],
        status: "backlog",
        createdAt: "2026-11-05T00:00:00.000Z",
      };
      insert.run(id, "phenomena", id, idea.score, "backlog", JSON.stringify(idea), idea.createdAt);
    }
    expect(writers.ideas("phenomena").map((i) => i.id)).toEqual(["I-1", "I-2"]);
    writers.setLearning({
      weights: () => ({ demand: 0.1, originality: 0.6, fit: 0.25, risk: 0.15 }),
      lessons: () => [],
    });
    expect(writers.rescore("phenomena")).toBe(2);
    expect(writers.ideas("phenomena").map((i) => i.id)).toEqual(["I-2", "I-1"]);
  });
});
