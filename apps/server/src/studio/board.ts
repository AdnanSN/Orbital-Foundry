import fs from "node:fs";
import type { PostRecord, UplinkStatus } from "../uplink/publisher";
import type { StudioReport } from "./analytics";
import type { Channel } from "./channel";
import type { VideoDoc } from "./editbay";
import type { GpuStatus } from "./gpu";
import type { MediaHub } from "./media";
import type { StudioSchedule } from "./schedule";
import type { ScriptDoc } from "./writers";

/**
 * The Studio panel's view (Stage 20, D-062): each script and video as a board of steps (idea,
 * script, voice, visuals, render, screening, approval, posted), with the budgets left, the GPU
 * queue, platform status and the production schedule, in one call.
 */

export const BOARD_STEPS = [
  "idea",
  "script",
  "voice",
  "visuals",
  "render",
  "screening",
  "approval",
  "posted",
] as const;
export type BoardStep = (typeof BOARD_STEPS)[number];
export type StepState = "done" | "current" | "todo" | "failed";

export interface BoardItem {
  /** The video id, or the script id while there is no video yet. */
  id: string;
  scriptId: string;
  videoId?: string;
  channel: string;
  title: string;
  format: "short" | "long";
  kind: "main" | "cutdown" | "script";
  test: boolean;
  /** What is happening, in words. */
  status: string;
  progress: number;
  steps: Record<BoardStep, StepState>;
  posts: { platform: string; status: string; at: string; url?: string; mode: string }[];
  voice?: { provider: string; fallback?: string };
  hasFile: boolean;
  updatedAt: string;
}

export interface Board {
  items: BoardItem[];
  budgets: {
    elevenlabs: { creditsLeft: number | null; budget: number | null; usedThisMonth: number };
    stills: { madeToday: number };
    gpu: Pick<GpuStatus, "counts" | "spend"> & { ready: string[] };
    disk: { freeGb: number | null };
  };
  posting: Pick<UplinkStatus, "mode" | "killed" | "platforms"> | null;
  schedule: ReturnType<StudioSchedule["status"]> | null;
  numbers: Pick<StudioReport, "formats" | "progress" | "collectedAt"> | null;
  channels: { id: string; name: string; status: string }[];
}

const STAGE_STEP: Record<string, BoardStep> = {
  "ai-clips": "visuals",
  voice: "voice",
  shots: "visuals",
  render: "render",
  screening: "screening",
  done: "approval",
};

function steps(upTo: BoardStep, state: StepState): Record<BoardStep, StepState> {
  const at = BOARD_STEPS.indexOf(upTo);
  return Object.fromEntries(
    BOARD_STEPS.map((s, i) => [s, i < at ? "done" : i === at ? state : "todo"]),
  ) as Record<BoardStep, StepState>;
}

/** Where a video is on its board. */
export function videoBoard(
  v: VideoDoc,
  posts: PostRecord[],
): Pick<BoardItem, "steps" | "status" | "progress"> {
  const step = STAGE_STEP[v.stage] ?? "voice";
  const live = posts.filter((p) => p.status !== "cancelled");
  switch (v.status) {
    case "waiting":
      return {
        steps: steps("visuals", "current"),
        status: "Waiting for its AI clips",
        progress: 0,
      };
    case "producing":
      return {
        steps: steps(step, "current"),
        status: `Making it: ${v.stage}`,
        progress: v.progress,
      };
    case "failed":
      return {
        steps: steps(step, "failed"),
        status: v.error ? `Failed: ${v.error.slice(0, 120)}` : "Failed",
        progress: v.progress,
      };
    case "review":
      return {
        steps: steps("approval", "current"),
        status: v.test ? "Test render: watch it at the Owner's Desk" : "Waiting for your approval",
        progress: 100,
      };
    case "rejected":
      return { steps: steps("approval", "failed"), status: "Sent back", progress: 100 };
    case "approved": {
      const planned = live.length > 0;
      return {
        steps: steps("posted", planned ? "current" : "todo"),
        status: planned
          ? live.some((p) => p.status === "awaiting")
            ? "Post plan waiting for your approval"
            : "Scheduled to post"
          : "Approved; no post plan yet",
        progress: 100,
      };
    }
    case "posted":
      return { steps: steps("posted", "done"), status: "Posted", progress: 100 };
  }
}

/** Where a script without a video is on its board. */
export function scriptBoard(s: ScriptDoc): Pick<BoardItem, "steps" | "status" | "progress"> {
  switch (s.status) {
    case "writing":
      return { steps: steps("script", "current"), status: "Being written", progress: 0 };
    case "review":
      return {
        steps: steps("script", "current"),
        status: "Script waiting for your approval",
        progress: 100,
      };
    case "approved":
      return {
        steps: steps("voice", "todo"),
        status: "Approved; the cut starts soon",
        progress: 0,
      };
    case "failed":
      return {
        steps: steps("script", "failed"),
        status: s.error ? `Failed: ${s.error.slice(0, 120)}` : "Failed",
        progress: 0,
      };
    default:
      return { steps: steps("script", "failed"), status: s.status, progress: 0 };
  }
}

export interface BoardDeps {
  writers: { channels(): Channel[]; scripts(channelId?: string): ScriptDoc[] };
  videos: { videos(): VideoDoc[] };
  posts?: { posts(): PostRecord[]; status(): UplinkStatus };
  gpu?: { status(): Promise<GpuStatus> };
  voices?: { elevenCreditsLeft(): Promise<number> };
  hub?: Pick<MediaHub, "has" | "provider" | "usage">;
  stillsToday?: () => number;
  schedule?: Pick<StudioSchedule, "status">;
  analytics?: { report(): StudioReport };
  /** Where free disk is measured (the data folder). */
  diskPath?: string;
  now?: () => number;
}

export class StudioBoard {
  private credits: { at: number; left: number | null } | null = null;

  constructor(private readonly deps: BoardDeps) {}

  async build(): Promise<Board> {
    const now = this.deps.now ?? Date.now;
    const posts = this.deps.posts?.posts() ?? [];
    const videos = this.deps.videos.videos();
    const withVideo = new Set(videos.map((v) => v.scriptId));
    const items: BoardItem[] = [];
    for (const s of this.deps.writers.scripts()) {
      if (withVideo.has(s.id) && s.status === "approved") continue;
      if (s.status === "rejected") continue;
      items.push({
        id: s.id,
        scriptId: s.id,
        channel: s.channel,
        title: s.titles[0] ?? s.idea.title,
        format: s.format,
        kind: "script",
        test: false,
        ...scriptBoard(s),
        posts: [],
        hasFile: false,
        updatedAt: s.updatedAt,
      });
    }
    for (const v of videos) {
      const mine = posts.filter((p) => p.videoId === v.id);
      items.push({
        id: v.id,
        scriptId: v.scriptId,
        videoId: v.id,
        channel: v.channel,
        title: v.title,
        format: v.format,
        kind: v.kind,
        test: v.test,
        ...videoBoard(v, mine),
        posts: mine.map((p) => ({
          platform: p.platform,
          status: p.status,
          at: p.at,
          mode: p.mode,
          ...(p.url ? { url: p.url } : {}),
        })),
        ...(v.voice
          ? {
              voice: {
                provider: v.voice.provider,
                ...(v.voice.fallback ? { fallback: v.voice.fallback } : {}),
              },
            }
          : {}),
        hasFile: Boolean(v.file && v.cleaned !== "folder" && fs.existsSync(v.file)),
        updatedAt: v.updatedAt,
      });
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const gpu = await this.deps.gpu?.status().catch(() => null);
    const hub = this.deps.hub;
    const eleven = hub?.has("elevenlabs") ? hub.provider("elevenlabs").budget?.monthly : undefined;
    let freeGb: number | null = null;
    try {
      if (this.deps.diskPath) {
        const st = fs.statfsSync(this.deps.diskPath);
        freeGb = Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10;
      }
    } catch {
      freeGb = null;
    }
    const posting = this.deps.posts?.status();
    const report = this.deps.analytics?.report();
    return {
      items: items.slice(0, 60),
      budgets: {
        elevenlabs: {
          creditsLeft: await this.creditsLeft(now()),
          budget: eleven ?? null,
          usedThisMonth: hub?.has("elevenlabs") ? hub.usage.monthUnits("elevenlabs") : 0,
        },
        stills: { madeToday: this.deps.stillsToday?.() ?? 0 },
        gpu: {
          counts:
            gpu?.counts ??
            ({
              queued: 0,
              running: 0,
              done: 0,
              failed: 0,
              expired: 0,
              cancelled: 0,
            } as GpuStatus["counts"]),
          spend: gpu?.spend ?? { modal: 0, modalCap: 0, fal: 0, falCap: 0 },
          ready: gpu?.generators.filter((g) => g.ready).map((g) => g.id) ?? [],
        },
        disk: { freeGb },
      },
      posting: posting
        ? { mode: posting.mode, killed: posting.killed, platforms: posting.platforms }
        : null,
      schedule: this.deps.schedule?.status() ?? null,
      numbers: report
        ? { formats: report.formats, progress: report.progress, collectedAt: report.collectedAt }
        : null,
      channels: this.deps.writers
        .channels()
        .map((c) => ({ id: c.id, name: c.name, status: c.status })),
    };
  }

  /** ElevenLabs' own count, asked at most every five minutes. */
  private async creditsLeft(now: number): Promise<number | null> {
    if (!this.deps.voices) return null;
    if (this.credits && now - this.credits.at < 5 * 60_000) return this.credits.left;
    const left = await this.deps.voices.elevenCreditsLeft().catch(() => null);
    this.credits = { at: now, left };
    return left;
  }
}
