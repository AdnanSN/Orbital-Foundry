import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import YAML from "yaml";
import { z } from "zod";
import { isQuiet } from "../ops/ops";
import { CONFIG_DIR, REPO_ROOT } from "../paths";
import type { WorkStore } from "../work/store";
import { probeMedia } from "./ffmpeg";
import { type Asset, type AssetLibrary, terms } from "./library";
import type { MediaHub, MediaLane } from "./media";

/**
 * The GPU lane (Stage 18, D-060): AI video clips where a shot list asks for them, free first.
 * Approved scripts queue their "ai-video" shots here with a deadline. A local worker (ComfyUI on
 * the laptop's GPU) runs them in quiet hours or while the GPU is idle; Modal is the burst lane
 * under a hard monthly cap; paid APIs (fal) are wired but off. A shot that isn't done by its
 * deadline expires, and the Edit Bay uses footage or a camera move on a still instead, so the
 * video still finishes on time.
 */

export const gpuConfigSchema = z.object({
  /** Local hours [from, to) when the local GPU may always work (wraps past midnight). */
  quietHours: z
    .tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)])
    .default([23, 7]),
  /** Outside quiet hours, the GPU must sit under this load for this long first. */
  idle: z
    .object({
      minutes: z.number().int().min(1).max(240).default(10),
      belowPercent: z.number().min(1).max(100).default(15),
    })
    .default({ minutes: 10, belowPercent: 15 }),
  /** How long an approved script waits for its AI clips before the cut starts without them. */
  deadlineHours: z.number().min(0).max(72).default(12),
  /** Burst to remote generators when a deadline is this close and the local GPU isn't free. */
  burstWithinHours: z.number().min(0).max(72).default(3),
  /** At most this many AI clips per script. */
  perScript: z
    .object({
      short: z.number().int().min(0).max(10).default(2),
      long: z.number().int().min(0).max(30).default(6),
    })
    .default({ short: 2, long: 6 }),
  clip: z
    .object({
      seconds: z.number().min(1).max(10).default(5),
      fps: z.number().int().min(8).max(60).default(24),
      portrait: z.tuple([z.number().int(), z.number().int()]).default([480, 832]),
      landscape: z.tuple([z.number().int(), z.number().int()]).default([832, 480]),
    })
    .default({ seconds: 5, fps: 24, portrait: [480, 832], landscape: [832, 480] }),
  negative: z
    .string()
    .default(
      "blurry, low quality, distorted, flicker, text, letters, watermark, logo, people, faces, hands",
    ),
  /** Generators in the order they're tried (media provider ids in config/media.yaml). */
  order: z.array(z.string()).default(["comfyui-video", "modal-video", "fal-video"]),
  comfyui: z
    .object({
      url: z.string().default("http://127.0.0.1:8188"),
      /** A workflow exported from ComfyUI in API format, with {{placeholders}}. */
      workflow: z.string().default("config/gpu/wan22-ti2v-5b.api.json"),
      timeoutMinutes: z.number().min(1).max(240).default(45),
    })
    .default({
      url: "http://127.0.0.1:8188",
      workflow: "config/gpu/wan22-ti2v-5b.api.json",
      timeoutMinutes: 45,
    }),
  modal: z
    .object({
      urlEnv: z.string().default("MODAL_VIDEO_URL"),
      /** Hard monthly cap, below Modal's $30 of free credit. */
      monthlyCapUsd: z.number().min(0).max(29).default(25),
      /** USD per GPU-second (L40S; see modal.com/pricing). */
      costPerSecond: z.number().min(0).default(0.000542),
      /** A clip's expected wall time, cold start included, for the budget check. */
      estimateSeconds: z.number().min(1).default(240),
    })
    .default({
      urlEnv: "MODAL_VIDEO_URL",
      monthlyCapUsd: 25,
      costPerSecond: 0.000542,
      estimateSeconds: 240,
    }),
  fal: z
    .object({
      model: z.string().default("fal-ai/kling-video/v2.1/standard/text-to-video"),
      costPerClip: z.number().min(0).default(0.25),
      monthlyCapUsd: z.number().min(0).default(0),
    })
    .default({
      model: "fal-ai/kling-video/v2.1/standard/text-to-video",
      costPerClip: 0.25,
      monthlyCapUsd: 0,
    }),
});
export type GpuConfig = z.infer<typeof gpuConfigSchema>;

export function loadGpuConfig(file = path.join(CONFIG_DIR, "gpu.yaml")): GpuConfig {
  if (!fs.existsSync(file)) return gpuConfigSchema.parse({});
  return gpuConfigSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
}

/** Wan and LTX want 4n+1 frames. */
export function frameCount(seconds: number, fps: number): number {
  return Math.round((seconds * fps) / 4) * 4 + 1;
}

export interface VideoGenRequest {
  job: string;
  prompt: string;
  negative: string;
  seconds: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  seed: number;
  /** Where the MP4 goes. */
  out: string;
}

export interface VideoGenerator {
  /** Its media provider id in config/media.yaml (lanes, gates, the call log, budgets). */
  readonly id: string;
  readonly local: boolean;
  /** Whether it can take a job now (a server answering, a key set). */
  ready(): Promise<boolean>;
  /** USD a clip is expected to cost (0 for local). */
  estimate(req: VideoGenRequest): number;
  generate(req: VideoGenRequest): Promise<{ file: string; costUsd: number }>;
}

/** Fills {{name}} placeholders: a whole-string placeholder takes the typed value. */
export function fillTemplate(node: unknown, values: Record<string, string | number>): unknown {
  if (typeof node === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(node);
    if (whole?.[1] && whole[1] in values) return values[whole[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
  }
  if (Array.isArray(node)) return node.map((n) => fillTemplate(n, values));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, fillTemplate(v, values)]),
    );
  }
  return node;
}

const VIDEO_FILE = /\.(mp4|webm|mov|mkv|gif)$/i;

/** ComfyUI's HTTP API on this laptop: queue the workflow, wait for its history, fetch the file. */
export class ComfyUIGenerator implements VideoGenerator {
  readonly id = "comfyui-video";
  readonly local = true;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly opts: {
      url: string;
      workflow: string;
      timeoutMinutes: number;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get workflowFile(): string {
    return path.isAbsolute(this.opts.workflow)
      ? this.opts.workflow
      : path.join(REPO_ROOT, this.opts.workflow);
  }

  async ready(): Promise<boolean> {
    if (!fs.existsSync(this.workflowFile)) return false;
    try {
      const res = await this.fetchImpl(`${this.opts.url}/system_stats`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  estimate(): number {
    return 0;
  }

  async generate(req: VideoGenRequest): Promise<{ file: string; costUsd: number }> {
    const template = JSON.parse(fs.readFileSync(this.workflowFile, "utf8")) as unknown;
    const prompt = fillTemplate(template, {
      prompt: req.prompt,
      negative: req.negative,
      width: req.width,
      height: req.height,
      frames: req.frames,
      fps: req.fps,
      seconds: req.seconds,
      seed: req.seed,
      job: req.job,
    });
    const queued = await this.fetchImpl(`${this.opts.url}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, client_id: "orbital-foundry" }),
    });
    const body = (await queued.json().catch(() => ({}))) as {
      prompt_id?: string;
      error?: { message?: string };
      node_errors?: Record<string, unknown>;
    };
    if (!queued.ok || !body.prompt_id) {
      const why = body.error?.message ?? JSON.stringify(body.node_errors ?? {}).slice(0, 300);
      throw new Error(`ComfyUI refused the workflow: ${why}`);
    }
    const until = Date.now() + this.opts.timeoutMinutes * 60_000;
    for (;;) {
      const res = await this.fetchImpl(`${this.opts.url}/history/${body.prompt_id}`);
      const history = (await res.json().catch(() => ({}))) as Record<
        string,
        {
          outputs?: Record<string, Record<string, unknown>>;
          status?: { completed?: boolean; status_str?: string };
        }
      >;
      const entry = history[body.prompt_id];
      if (entry?.status?.status_str === "error") throw new Error("ComfyUI's run failed.");
      const files = Object.values(entry?.outputs ?? {})
        .flatMap((o) => Object.values(o))
        .flatMap((v) => (Array.isArray(v) ? v : []))
        .filter(
          (f): f is { filename: string; subfolder?: string; type?: string } =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as { filename?: unknown }).filename === "string" &&
            VIDEO_FILE.test((f as { filename: string }).filename),
        );
      const first = files[0];
      if (first) {
        const q = new URLSearchParams({
          filename: first.filename,
          subfolder: first.subfolder ?? "",
          type: first.type ?? "output",
        });
        const video = await this.fetchImpl(`${this.opts.url}/view?${q}`);
        if (!video.ok) throw new Error(`ComfyUI's file didn't download (${video.status}).`);
        fs.mkdirSync(path.dirname(req.out), { recursive: true });
        fs.writeFileSync(req.out, Buffer.from(await video.arrayBuffer()));
        return { file: req.out, costUsd: 0 };
      }
      if (entry?.status?.completed) throw new Error("ComfyUI finished without a video output.");
      if (Date.now() > until) throw new Error("ComfyUI took too long.");
      await this.sleep(5_000);
    }
  }
}

/** Our Modal app (infra/modal/video.py): POST JSON, get an MP4 back. Billed by GPU time. */
export class ModalGenerator implements VideoGenerator {
  readonly id = "modal-video";
  readonly local = false;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      url?: string;
      key?: string;
      secret?: string;
      costPerSecond: number;
      estimateSeconds: number;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ready(): Promise<boolean> {
    return Boolean(this.opts.url && this.opts.key && this.opts.secret);
  }

  estimate(): number {
    return this.opts.estimateSeconds * this.opts.costPerSecond;
  }

  async generate(req: VideoGenRequest): Promise<{ file: string; costUsd: number }> {
    const now = this.opts.now ?? Date.now;
    const started = now();
    const res = await this.fetchImpl(this.opts.url ?? "", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Modal-Key": this.opts.key ?? "",
        "Modal-Secret": this.opts.secret ?? "",
      },
      body: JSON.stringify({
        prompt: req.prompt,
        negative: req.negative,
        width: req.width,
        height: req.height,
        frames: req.frames,
        fps: req.fps,
        seed: req.seed,
      }),
      signal: AbortSignal.timeout(20 * 60_000),
    });
    // Wall time covers a cold start too, so the spend we count is on the high side.
    const costUsd = ((now() - started) / 1000) * this.opts.costPerSecond;
    if (!res.ok)
      throw new Error(`Modal answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    fs.mkdirSync(path.dirname(req.out), { recursive: true });
    fs.writeFileSync(req.out, Buffer.from(await res.arrayBuffer()));
    return { file: req.out, costUsd };
  }
}

/** fal's queue API (Kling, Seedance, Veo, Wan and others). Paid: off unless enabled. */
export class FalGenerator implements VideoGenerator {
  readonly id = "fal-video";
  readonly local = false;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly opts: {
      key?: string;
      model: string;
      costPerClip: number;
      enabled: boolean;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async ready(): Promise<boolean> {
    return this.opts.enabled && Boolean(this.opts.key);
  }

  estimate(): number {
    return this.opts.costPerClip;
  }

  async generate(req: VideoGenRequest): Promise<{ file: string; costUsd: number }> {
    const auth = { authorization: `Key ${this.opts.key ?? ""}` };
    const submit = await this.fetchImpl(`https://queue.fal.run/${this.opts.model}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: req.prompt,
        negative_prompt: req.negative,
        aspect_ratio: req.height > req.width ? "9:16" : "16:9",
        duration: String(Math.round(req.seconds)),
      }),
    });
    const job = (await submit.json().catch(() => ({}))) as {
      status_url?: string;
      response_url?: string;
      detail?: unknown;
    };
    if (!submit.ok || !job.status_url || !job.response_url) {
      throw new Error(`fal refused the job (${submit.status}).`);
    }
    for (let i = 0; i < 240; i++) {
      const s = (await (await this.fetchImpl(job.status_url, { headers: auth })).json()) as {
        status?: string;
      };
      if (s.status === "COMPLETED") break;
      if (i === 239) throw new Error("fal took too long.");
      await this.sleep(5_000);
    }
    const out = (await (await this.fetchImpl(job.response_url, { headers: auth })).json()) as {
      video?: { url?: string };
    };
    if (!out.video?.url) throw new Error("fal returned no video.");
    const video = await this.fetchImpl(out.video.url);
    fs.mkdirSync(path.dirname(req.out), { recursive: true });
    fs.writeFileSync(req.out, Buffer.from(await video.arrayBuffer()));
    return { file: req.out, costUsd: this.opts.costPerClip };
  }
}

/** The GPU's load in percent from nvidia-smi, or null without one. */
export function gpuUtilization(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const pct = Number.parseFloat(String(stdout).split(",")[0] ?? "");
        resolve(Number.isFinite(pct) ? pct : null);
      },
    );
  });
}

export const GPU_JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "expired",
  "cancelled",
] as const;
export type GpuJobStatus = (typeof GPU_JOB_STATUSES)[number];

export interface GpuJob {
  id: string;
  scriptId: string;
  beat: number;
  prompt: string;
  orientation: "portrait" | "landscape";
  lane: MediaLane;
  status: GpuJobStatus;
  deadline: string;
  attempts: number;
  provider?: string;
  assetId?: string;
  seconds?: number;
  costUsd?: number;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GpuStatus {
  window: { quiet: boolean; idle: boolean; utilization: number | null; open: boolean };
  generators: { id: string; local: boolean; ready: boolean; enabled: boolean }[];
  counts: Record<GpuJobStatus, number>;
  spend: { modal: number; modalCap: number; fal: number; falCap: number };
  jobs: GpuJob[];
}

export interface GpuDeps {
  db: Database.Database;
  hub: MediaHub;
  library: AssetLibrary;
  store: WorkStore;
  generators: VideoGenerator[];
  config: GpuConfig;
  /** data/artifacts/gpu */
  dir: string;
  /** True while something else (a render) uses the GPU. */
  busy?: () => boolean;
  utilization?: () => Promise<number | null>;
  /** All of a script's AI clips are done, failed or past their deadline. */
  onSettled?: (scriptId: string) => void | Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

export class GpuQueue {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private idleSince: number | null = null;
  private lastUtil: number | null = null;

  constructor(private readonly deps: GpuDeps) {
    this.now = deps.now ?? Date.now;
    fs.mkdirSync(deps.dir, { recursive: true });
    // A restart cuts a job off; it goes back in the queue.
    deps.db
      .prepare(
        "UPDATE gpu_jobs SET status = 'queued', data = json_set(data, '$.status', 'queued', '$.detail', 'Requeued after a restart.') WHERE status = 'running'",
      )
      .run();
  }

  get config(): GpuConfig {
    return this.deps.config;
  }

  /** The deadline for clips requested now. */
  deadline(): string {
    return new Date(this.now() + this.deps.config.deadlineHours * 3_600_000).toISOString();
  }

  /** Queues the AI clip for one beat of a script (once: a repeat returns the same job). */
  request(
    scriptId: string,
    beat: number,
    shot: { prompt: string; orientation: "portrait" | "landscape"; lane: MediaLane },
  ): GpuJob {
    const existing = this.jobs({ scriptId }).find((j) => j.beat === beat);
    if (existing && existing.status !== "cancelled") return existing;
    const at = new Date(this.now()).toISOString();
    const job: GpuJob = {
      id: this.deps.store.nextId("G"),
      scriptId,
      beat,
      prompt: shot.prompt.slice(0, 600),
      orientation: shot.orientation,
      lane: shot.lane,
      status: "queued",
      deadline: this.deadline(),
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.save(job);
    this.deps.store.setKv(`gpu.settled.${scriptId}`, "");
    return job;
  }

  jobs(filter: { scriptId?: string; status?: GpuJobStatus } = {}): GpuJob[] {
    const rows = this.deps.db
      .prepare(
        "SELECT data FROM gpu_jobs WHERE (? IS NULL OR script_id = ?) AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT 500",
      )
      .all(
        filter.scriptId ?? null,
        filter.scriptId ?? null,
        filter.status ?? null,
        filter.status ?? null,
      ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as GpuJob);
  }

  /** The finished clip for a shot, matched by its prompt (cutdowns renumber the beats). */
  clip(scriptId: string, prompt: string): Asset | null {
    const job = this.jobs({ scriptId, status: "done" }).find(
      (j) => j.prompt === prompt.slice(0, 600),
    );
    return job?.assetId ? this.deps.library.get(job.assetId) : null;
  }

  /** No queued or running clips left for the script. */
  settled(scriptId: string): boolean {
    return !this.jobs({ scriptId }).some((j) => j.status === "queued" || j.status === "running");
  }

  /** Quiet hours, or the GPU idle long enough, and nothing else using it. */
  async windowOpen(): Promise<{ quiet: boolean; idle: boolean; open: boolean }> {
    const quiet = isQuiet(new Date(this.now()), this.deps.config.quietHours);
    const util = await (this.deps.utilization ?? gpuUtilization)();
    this.lastUtil = util;
    if (util !== null && util < this.deps.config.idle.belowPercent) {
      this.idleSince ??= this.now();
    } else {
      this.idleSince = null;
    }
    const idle =
      this.idleSince !== null &&
      this.now() - this.idleSince >= this.deps.config.idle.minutes * 60_000;
    const free = !this.deps.busy?.();
    return { quiet, idle, open: free && (quiet || idle) };
  }

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

  /** Expires late jobs, runs at most one, and reports scripts whose clips are settled. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      for (const j of this.jobs({ status: "queued" })) {
        if (Date.parse(j.deadline) <= now) {
          this.mark(j, "expired", "Not done by its deadline; the shot uses footage or a still.");
        }
      }
      const next = this.jobs({ status: "queued" }).sort(
        (a, b) => Date.parse(a.deadline) - Date.parse(b.deadline),
      )[0];
      if (next) await this.runJob(next);
      await this.reportSettled();
    } catch (err) {
      this.deps.log?.(`gpu tick: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  async status(): Promise<GpuStatus> {
    const window = await this.windowOpen();
    const generators = await Promise.all(
      this.deps.generators.map(async (g) => ({
        id: g.id,
        local: g.local,
        ready: await g.ready().catch(() => false),
        enabled: this.deps.hub.has(g.id),
      })),
    );
    const counts = Object.fromEntries(GPU_JOB_STATUSES.map((s) => [s, 0])) as Record<
      GpuJobStatus,
      number
    >;
    const jobs = this.jobs();
    for (const j of jobs) counts[j.status] += 1;
    return {
      window: { ...window, utilization: this.lastUtil },
      generators,
      counts,
      spend: {
        modal: this.spentUsd("modal-video"),
        modalCap: this.deps.config.modal.monthlyCapUsd,
        fal: this.spentUsd("fal-video"),
        falCap: this.deps.config.fal.monthlyCapUsd,
      },
      jobs: jobs.slice(0, 40),
    };
  }

  /** USD spent this month on a remote generator (from the media call log). */
  spentUsd(id: string): number {
    if (!this.deps.hub.has(id)) return 0;
    return this.deps.hub.usage.monthUnits(id);
  }

  private capUsd(id: string): number {
    if (id === "modal-video") return this.deps.config.modal.monthlyCapUsd;
    if (id === "fal-video") return this.deps.config.fal.monthlyCapUsd;
    return Number.POSITIVE_INFINITY;
  }

  private async pick(job: GpuJob, req: VideoGenRequest): Promise<VideoGenerator | null> {
    const window = await this.windowOpen();
    const urgent =
      Date.parse(job.deadline) - this.now() <= this.deps.config.burstWithinHours * 3_600_000;
    const byOrder = this.deps.config.order
      .map((id) => this.deps.generators.find((g) => g.id === id))
      .filter((g): g is VideoGenerator => Boolean(g));
    let localReady = false;
    for (const g of byOrder) {
      if (!g.local) continue;
      if (!this.deps.hub.available(g.id, job.lane)) continue;
      if (!(await g.ready().catch(() => false))) continue;
      localReady = true;
      if (window.open) return g;
    }
    // Remote generators burst only when the local GPU can't do it in time.
    if (localReady && !urgent) return null;
    for (const g of byOrder) {
      if (g.local) continue;
      if (!this.deps.hub.available(g.id, job.lane)) continue;
      if (!(await g.ready().catch(() => false))) continue;
      if (this.spentUsd(g.id) + g.estimate(req) > this.capUsd(g.id)) continue;
      return g;
    }
    return null;
  }

  private async runJob(job: GpuJob): Promise<void> {
    const [w, h] =
      job.orientation === "portrait"
        ? this.deps.config.clip.portrait
        : this.deps.config.clip.landscape;
    const { seconds, fps } = this.deps.config.clip;
    const req: VideoGenRequest = {
      job: job.id,
      prompt: job.prompt,
      negative: this.deps.config.negative,
      seconds,
      fps,
      frames: frameCount(seconds, fps),
      width: w,
      height: h,
      seed: randomInt(1, 2 ** 31 - 1),
      out: path.join(this.deps.dir, `${job.id}.mp4`),
    };
    const gen = await this.pick(job, req);
    if (!gen) return;
    job.attempts += 1;
    job.provider = gen.id;
    this.mark(job, "running", `Generating on ${gen.id}…`);
    const started = this.now();
    try {
      const out = await this.deps.hub.run(gen.id, job.lane, async () => {
        const r = await gen.generate(req);
        return {
          value: r,
          ...(gen.local ? {} : { units: r.costUsd, unit: "usd" }),
          ref: job.id,
        };
      });
      const info = await probeMedia(out.file).catch(() => null);
      const provider = this.deps.hub.provider(gen.id);
      const asset = this.deps.library.add({
        id: `gen-${job.id}`,
        kind: "video",
        source: "generated",
        sourceId: gen.id,
        title: job.prompt.slice(0, 120),
        tags: terms(job.prompt).slice(0, 12),
        licence: provider.licence,
        credit: "",
        path: out.file,
        bytes: fs.statSync(out.file).size,
        ...(info?.duration ? { duration: info.duration } : {}),
        ...(info?.width ? { width: info.width } : {}),
        ...(info?.height ? { height: info.height } : {}),
      });
      job.assetId = asset.id;
      job.seconds = Math.round((this.now() - started) / 1000);
      job.costUsd = out.costUsd;
      this.mark(job, "done", `Made on ${gen.id} in ${job.seconds} s.`);
      this.deps.log?.(`${job.id} done on ${gen.id} in ${job.seconds} s`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // One retry; after that the shot falls back like a late one.
      this.mark(job, job.attempts >= 2 ? "failed" : "queued", why.slice(0, 300));
      this.deps.log?.(`${job.id} on ${gen.id}: ${why}`);
    }
  }

  private async reportSettled(): Promise<void> {
    const scripts = new Set(this.jobs().map((j) => j.scriptId));
    for (const id of scripts) {
      if (!this.settled(id) || this.deps.store.getKv(`gpu.settled.${id}`) === "yes") continue;
      this.deps.store.setKv(`gpu.settled.${id}`, "yes");
      try {
        await this.deps.onSettled?.(id);
      } catch (err) {
        this.deps.log?.(`after ${id}'s clips: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private mark(job: GpuJob, status: GpuJobStatus, detail: string): void {
    job.status = status;
    job.detail = detail;
    this.save(job);
  }

  private save(job: GpuJob): void {
    job.updatedAt = new Date(this.now()).toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO gpu_jobs (id, script_id, status, deadline, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, deadline = excluded.deadline,
           data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        job.id,
        job.scriptId,
        job.status,
        job.deadline,
        JSON.stringify(job),
        job.createdAt,
        job.updatedAt,
      );
  }
}
