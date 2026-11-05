import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { Approval, Lane } from "@orbital/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Blocklist } from "../creative/config";
import type { ModelRouter } from "../llm/router";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";
import { chunkCaptions, splitWords, toSrt, type WordTiming } from "./captions";
import type { Channel } from "./channel";
import { writeProject } from "./compose";
import { frameAt } from "./ffmpeg";
import { type Asset, type AssetLibrary, creditsText, terms } from "./library";
import type { MediaLane } from "./media";
import { type RenderOptions, type RenderResult, renderProject } from "./render";
import { type ScreenInput, type ScreeningReport, screen } from "./screening";
import type { SoundKit } from "./sound";
import { mediaStartFor, type StockRequest } from "./stock";
import { makeThumbnail } from "./thumbnail";
import { type CameraMove, type Scene, type Timeline, timelineSchema } from "./timeline";
import { applyPronunciation, type VoiceRequest, type VoiceResult } from "./voice";
import type { Beat, ScriptDoc, WritersRoom } from "./writers";

/**
 * The Edit Bay (Stage 16): an approved script becomes finished videos. Voice first; every beat is
 * timed from the words; each shot comes from the cheapest source that fits, with a fallback
 * (footage, then a photo, then an AI still, then a code-drawn frame); music, effects and captions;
 * the render; then the Screening Room, the package and a Desk item with a player. Long-form also
 * yields three shorts with their own hooks (the waterfall, ROADMAP §7.2).
 */

export type VideoStatus = "producing" | "review" | "approved" | "rejected" | "failed" | "posted";

export interface ShotRecord {
  beat: number;
  start: number;
  duration: number;
  want: string;
  got: string;
  assetId?: string;
  fallback?: string;
}

export interface VideoDoc {
  id: string;
  scriptId: string;
  channel: string;
  format: "short" | "long";
  kind: "main" | "cutdown";
  parentId?: string;
  test: boolean;
  status: VideoStatus;
  stage: string;
  progress: number;
  title: string;
  titles: string[];
  description: string;
  tags: string[];
  file?: string;
  srt?: string;
  thumbnail?: string;
  metadata?: string;
  duration?: number;
  renderSeconds?: number;
  voice?: { provider: string; units: number; fallback?: string };
  shots: ShotRecord[];
  assets: string[];
  screening?: ScreeningReport;
  disclosure: { syntheticMedia: boolean; aiNarration: boolean };
  artifactId?: string;
  note?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EditBayDeps {
  writers: WritersRoom;
  router: ModelRouter;
  voices: { speak(req: VoiceRequest): Promise<VoiceResult> };
  stock: { fetch(req: StockRequest): Promise<Asset | null> };
  stills?: (prompt: string, orientation: "portrait" | "landscape") => Promise<Asset>;
  library: AssetLibrary;
  kit: SoundKit;
  store: WorkStore;
  db: Database.Database;
  director?: WorkDirector;
  lane: Lane;
  /** data/artifacts/studio/videos */
  dir: string;
  blocklist?: Blocklist;
  render?: (dir: string, out: string, opts: RenderOptions) => Promise<RenderResult>;
  screen?: (input: ScreenInput) => Promise<ScreeningReport>;
  frame?: (file: string, seconds: number, out: string) => Promise<void>;
  thumbnail?: typeof makeThumbnail;
  renderOptions?: Pick<RenderOptions, "workers" | "gpu" | "quality">;
  say?: (role: string, text: string) => void;
  log?: (message: string) => void;
  now?: () => number;
}

const cutdownSchema = z.object({
  cuts: z
    .array(
      z.object({
        from: z.number().int().min(0),
        to: z.number().int().min(0),
        hook: z.string().min(5).max(200),
        title: z.string().min(5).max(90),
      }),
    )
    .min(1)
    .max(3),
});

/** A code-drawn starfield in the channel's colours (varied by seed): the last-resort frame. */
export function drawStarfield(
  file: string,
  seed: number,
  format: "short" | "long",
  bg: string,
  bg2: string,
): void {
  const [W, H] = format === "short" ? [1080, 1920] : [1920, 1080];
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, W * 0.3, H);
  sky.addColorStop(0, bg);
  sky.addColorStop(1, bg2);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 1100; i++) {
    g.globalAlpha = 0.25 + rnd() * 0.75;
    g.fillStyle = rnd() < 0.12 ? "#ffd9a0" : "#ffffff";
    g.beginPath();
    g.arc(rnd() * W, rnd() * H, rnd() < 0.93 ? rnd() * 1.5 + 0.3 : rnd() * 3 + 1.2, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 0.18;
  const glow = g.createRadialGradient(
    W * rnd(),
    H * rnd(),
    10,
    W * 0.5,
    H * 0.5,
    Math.max(W, H) * 0.7,
  );
  glow.addColorStop(0, "#9ab8ff");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  g.globalAlpha = 1;
  fs.writeFileSync(file, c.toBuffer("image/png"));
}

/** Where each beat starts and ends, from the voice's word timings. */
export function beatTimes(
  beats: Beat[],
  words: WordTiming[],
  duration: number,
  pronounce: Record<string, string>,
): { start: number; end: number }[] {
  const counts = beats.map((b) => splitWords(applyPronunciation(b.narration, pronounce)).length);
  const starts: number[] = [];
  let w = 0;
  for (const n of counts) {
    starts.push(
      starts.length === 0 ? 0 : (words[Math.min(w, words.length - 1)]?.start ?? duration),
    );
    w += n;
  }
  return starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? duration }));
}

/** YouTube chapters (0:00 first, at least three, ten seconds apart) from the title cards. */
export function chapters(beats: Beat[], times: { start: number }[]): string {
  const marks = [{ t: 0, label: "Intro" }];
  beats.forEach((b, i) => {
    const t = times[i]?.start ?? 0;
    if (b.visual.kind === "title" && b.visual.text && t - (marks.at(-1)?.t ?? 0) >= 10)
      marks.push({ t, label: b.visual.text });
  });
  if (marks.length < 3) return "";
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return marks.map((m) => `${fmt(m.t)} ${m.label}`).join("\n");
}

const MOVES: CameraMove[] = [
  "push-in",
  "pan-left",
  "tilt-up",
  "pull-out",
  "pan-right",
  "drift",
  "tilt-down",
];

export class EditBay {
  private readonly now: () => number;
  private readonly running = new Set<string>();

  constructor(private readonly deps: EditBayDeps) {
    this.now = deps.now ?? Date.now;
    fs.mkdirSync(deps.dir, { recursive: true });
    deps.director?.onDecision((a) => this.onDecision(a));
    deps.db
      .prepare(
        "UPDATE videos SET status = 'failed', data = json_set(data, '$.status', 'failed', '$.error', 'The station restarted during production.') WHERE status = 'producing'",
      )
      .run();
  }

  videos(channel?: string, status?: VideoStatus): VideoDoc[] {
    const rows = this.deps.db
      .prepare(
        "SELECT data FROM videos WHERE (? IS NULL OR channel = ?) AND (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 200",
      )
      .all(channel ?? null, channel ?? null, status ?? null, status ?? null) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as VideoDoc);
  }

  video(id: string): VideoDoc | null {
    const row = this.deps.db.prepare("SELECT data FROM videos WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as VideoDoc) : null;
  }

  save(v: VideoDoc): void {
    v.updatedAt = new Date(this.now()).toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO videos (id, script_id, channel, format, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        v.id,
        v.scriptId,
        v.channel,
        v.format,
        v.status,
        JSON.stringify(v),
        v.createdAt,
        v.updatedAt,
      );
  }

  /**
   * Starts production. Approved scripts only, unless `test` (a test render of a script still under
   * review: it reaches the Desk labelled as a test, and it can never be posted).
   */
  produce(
    scriptId: string,
    opts: { test?: boolean; cutdowns?: number; note?: string; fresh?: boolean } = {},
  ): VideoDoc {
    const script = this.deps.writers.script(scriptId);
    if (!script) throw new Error(`No script ${scriptId}.`);
    if (script.status !== "approved" && !opts.test) {
      throw new Error(
        `Script ${scriptId} is ${script.status}; approve it at the Owner's Desk first.`,
      );
    }
    const channel = this.deps.writers.channel(script.channel);
    const video = this.newVideo(script, channel, {
      kind: "main",
      test: Boolean(opts.test) || channel.status === "draft",
      ...(opts.note ? { note: opts.note } : {}),
    });
    this.track(
      video.id,
      this.run(video, script, channel, script.beats, opts.fresh ?? false).then(async () => {
        if (script.format === "long" && (opts.cutdowns ?? 3) > 0)
          await this.waterfall(video, script, channel, opts.cutdowns ?? 3);
      }),
    );
    return video;
  }

  /** Waits for background work on a video (tests and scripts). */
  async settled(id: string, timeoutMs = 3 * 3_600_000): Promise<VideoDoc | null> {
    const until = Date.now() + timeoutMs;
    while (this.running.has(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return this.video(id);
  }

  private track(id: string, work: Promise<void>): void {
    this.running.add(id);
    void work
      .catch((err: unknown) => {
        const v = this.video(id);
        if (v) {
          v.status = "failed";
          v.error = err instanceof Error ? err.message : String(err);
          this.save(v);
        }
        this.deps.log?.(`video ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.deps.say?.("operator", "A render failed; it's marked on the board.");
      })
      .finally(() => this.running.delete(id));
  }

  private newVideo(
    script: ScriptDoc,
    channel: Channel,
    extra: Pick<VideoDoc, "kind" | "test"> & Partial<VideoDoc>,
  ): VideoDoc {
    const at = new Date(this.now()).toISOString();
    const v: VideoDoc = {
      id: this.deps.store.nextId("V"),
      scriptId: script.id,
      channel: channel.id,
      format: script.format,
      status: "producing",
      stage: "voice",
      progress: 0,
      title: script.titles[0] ?? script.idea.title,
      titles: script.titles,
      description: script.description,
      tags: script.tags,
      shots: [],
      assets: [],
      disclosure: { syntheticMedia: false, aiNarration: channel.disclosure.aiNarration },
      createdAt: at,
      updatedAt: at,
      ...extra,
    };
    this.save(v);
    return v;
  }

  private stage(v: VideoDoc, stage: string, progress: number): void {
    v.stage = stage;
    v.progress = Math.round(progress);
    this.save(v);
  }

  private async run(
    v: VideoDoc,
    script: ScriptDoc,
    channel: Channel,
    beats: Beat[],
    fresh: boolean,
  ): Promise<void> {
    const lane = this.deps.lane as MediaLane;
    const out = path.join(this.deps.dir, v.id);
    fs.mkdirSync(out, { recursive: true });
    const orientation = v.format === "short" ? "portrait" : "landscape";
    const pronounce = channel.voice.pronounce;
    this.deps.say?.("operator", `Voicing ${v.format === "long" ? "the long-form" : "a short"}…`);
    const voice = await this.deps.voices.speak({
      text: beats.map((b) => b.narration).join("\n\n"),
      lane,
      out: path.join(out, "voice"),
      pronounce,
      voice: channel.voice.kokoro,
    });
    v.voice = {
      provider: voice.provider,
      units: voice.units,
      ...(voice.fallback ? { fallback: voice.fallback } : {}),
    };
    const duration = Math.ceil((voice.duration + (v.format === "short" ? 0.6 : 1.5)) * 10) / 10;
    const times = beatTimes(beats, voice.words, duration, pronounce);
    this.stage(v, "shots", 10);

    const used: Asset[] = [];
    const scenes: Scene[] = [];
    const sfx: Timeline["sfx"] = [];
    let moveNo = 0;
    for (const [i, beat] of beats.entries()) {
      const t = times[i] ?? { start: 0, end: duration };
      const span = Math.max(0.6, t.end - t.start);
      const vis = beat.visual;
      const graphic = ["title", "list", "quote", "stat"].includes(vis.kind);
      // Motion graphics hold a beat up to 8 s; past that, footage takes over to keep it moving.
      const pieces: { start: number; dur: number; kind: string }[] = [];
      if (graphic) {
        const g = span > 8 ? 5 : span;
        pieces.push({ start: t.start, dur: g, kind: vis.kind });
        if (span > 8) pieces.push(...this.split(t.start + g, span - g, "stock-image"));
      } else pieces.push(...this.split(t.start, span, vis.kind));
      for (const [k, piece] of pieces.entries()) {
        let visual: Scene["visual"];
        const record: ShotRecord = {
          beat: i,
          start: piece.start,
          duration: piece.dur,
          want: piece.kind,
          got: piece.kind,
        };
        if (piece.kind === "title")
          visual = {
            type: "title",
            title: vis.text ?? script.titles[0] ?? "",
            ...(vis.detail ? { subtitle: vis.detail } : {}),
          };
        else if (piece.kind === "list")
          visual = {
            type: "list",
            item: vis.text ?? "",
            ...(vis.value !== undefined ? { index: Math.round(vis.value) } : {}),
            ...(vis.detail ? { detail: vis.detail } : {}),
          };
        else if (piece.kind === "quote")
          visual = {
            type: "quote",
            text: vis.text ?? beat.narration.slice(0, 200),
            ...(vis.by ? { by: vis.by } : {}),
          };
        else if (piece.kind === "stat" && vis.value !== undefined) {
          visual = {
            type: "stat",
            value: vis.value,
            decimals: Number.isInteger(vis.value) ? 0 : 1,
            label: vis.label ?? vis.text ?? "",
            ...(vis.prefix ? { prefix: vis.prefix } : {}),
            ...(vis.suffix ? { suffix: vis.suffix } : {}),
          };
        } else {
          const query =
            vis.query ??
            (vis.prompt ? terms(vis.prompt).slice(0, 4).join(" ") : vis.text) ??
            script.idea.title;
          const media = await this.media(
            piece.kind === "stat" ? "stock-image" : piece.kind,
            query,
            vis.prompt,
            piece.dur,
            orientation,
            channel,
            used,
            lane,
            fresh || k > 0,
          );
          record.got = media.got;
          if (media.fallback) record.fallback = media.fallback;
          if (media.asset) {
            used.push(media.asset);
            record.assetId = media.asset.id;
          }
          visual = media.visual ?? {
            type: "still",
            src: this.starfield(out, i * 10 + k, v.format, channel),
            move: MOVES[moveNo++ % MOVES.length] ?? "drift",
          };
          if (visual.type === "still" && !media.visual) record.got = "code";
          if (visual.type === "still" && media.visual)
            visual = { ...visual, move: vis.move ?? MOVES[moveNo++ % MOVES.length] ?? "push-in" };
        }
        v.shots.push(record);
        scenes.push({ start: piece.start, duration: piece.dur, visual, transition: "fade" });
        if (scenes.length > 1 && scenes.length % 2 === 0) {
          const fx = this.deps.kit.sfx("whoosh");
          sfx.push({
            src: fx.file,
            duration: fx.duration,
            start: Math.max(0, piece.start - 0.25),
            volume: 0.3,
          });
        }
        if (piece.kind === "stat" || piece.kind === "list") {
          const fx = this.deps.kit.sfx("pop");
          sfx.push({ src: fx.file, duration: fx.duration, start: piece.start + 0.1, volume: 0.45 });
        }
      }
      this.stage(v, "shots", 10 + (40 * (i + 1)) / beats.length);
    }
    // Scenes must cover the video exactly: snap each to the next one's start.
    scenes.sort((a, b) => a.start - b.start);
    scenes.forEach((s, i) => {
      const next = scenes[i + 1];
      s.duration = Math.max(0.3, (next ? next.start : duration) - s.start);
    });
    if (scenes[0]) scenes[0].start = 0;

    const music = this.deps.kit.music(duration, channel.music.mood);
    used.push(music.asset);
    const timeline: Timeline = timelineSchema.parse({
      format: v.format,
      duration,
      theme: channel.theme,
      voice: { src: voice.file },
      music: { src: music.file, volume: v.format === "short" ? 0.13 : 0.1 },
      sfx,
      scenes,
      ...(v.format === "short"
        ? { captions: { chunks: chunkCaptions(voice.words), style: "karaoke" } }
        : {}),
      progressBar: v.format === "short",
      ...(channel.handle ? { watermark: channel.handle } : {}),
    });
    this.stage(v, "render", 50);
    this.deps.say?.("operator", "Rendering…");
    writeProject(timeline, path.join(out, "project"));
    const render = this.deps.render ?? renderProject;
    const result = await render(path.join(out, "project"), path.join(out, `${v.id}.mp4`), {
      ...this.deps.renderOptions,
      onProgress: (pct) => {
        const p = 50 + pct * 0.4;
        if (p - v.progress >= 5) this.stage(v, "render", p);
      },
    });
    v.file = result.file;
    v.duration = result.duration;
    v.renderSeconds = result.seconds;
    v.srt = path.join(out, `${v.id}.srt`);
    fs.writeFileSync(v.srt, toSrt(voice.words));

    this.stage(v, "screening", 92);
    this.deps.say?.("reviewer", "Screening the cut…");
    const frame = path.join(out, "frame.png");
    const hookEnd = times[0]?.end ?? 2;
    await (this.deps.frame ?? frameAt)(
      result.file,
      Math.min(Math.max(1, hookEnd * 0.6), Math.max(0, result.duration - 0.5)),
      frame,
    );
    v.thumbnail = path.join(out, `${v.id}-thumb.png`);
    await (this.deps.thumbnail ?? makeThumbnail)({
      frame,
      out: v.thumbnail,
      text: script.thumbnails[0]?.text ?? v.title,
      format: v.format,
      theme: channel.theme,
    });
    const realisticAi = used.some((a) => a.source === "generated");
    v.screening = await (this.deps.screen ?? screen)({
      file: result.file,
      duration: result.duration,
      words: [v.title, ...v.titles, v.description, ...beats.map((b) => b.narration)].join(" "),
      ...(this.deps.blocklist ? { blocklist: this.deps.blocklist } : {}),
      realisticAi,
    });
    v.disclosure.syntheticMedia = v.screening.syntheticMedia;
    v.assets = used.map((a) => a.id);
    this.deps.library.markUsed(v.assets);

    const chapterText = v.format === "long" ? chapters(beats, times) : "";
    const sources = script.brief.sources.map((s) => `${s.title}: ${s.url}`).join("\n");
    v.description = [
      v.kind === "cutdown" ? v.description : script.description,
      chapterText,
      sources ? `Sources:\n${sources}` : "",
      creditsText(used),
      channel.disclosure.aiNarration && !/AI voice/i.test(script.description)
        ? "Narration: AI voice."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    v.metadata = path.join(out, "metadata.json");
    fs.writeFileSync(
      v.metadata,
      JSON.stringify(
        {
          youtube: {
            title: v.title,
            description: v.description,
            tags: v.tags,
            categoryId: "28",
            madeForKids: false,
            containsSyntheticMedia: v.disclosure.syntheticMedia,
          },
          tiktok: {
            caption: `${v.title} ${v.tags
              .slice(0, 4)
              .map((t) => `#${t.replace(/\s+/g, "")}`)
              .join(" ")}`.slice(0, 2200),
            isAigc: v.disclosure.syntheticMedia,
          },
          instagram: {
            caption: `${v.title}\n\n${v.tags
              .slice(0, 8)
              .map((t) => `#${t.replace(/\s+/g, "")}`)
              .join(" ")}\n\nNarration: AI voice.`,
          },
        },
        null,
        2,
      ),
    );
    v.status = "review";
    v.stage = "done";
    v.progress = 100;
    this.save(v);
    this.submit(v, channel);
  }

  /** Splits a span into shots of at most 7 s for media (footage and stills move on). */
  private split(
    start: number,
    dur: number,
    kind: string,
  ): { start: number; dur: number; kind: string }[] {
    const n = Math.max(1, Math.ceil(dur / 7));
    return Array.from({ length: n }, (_x, i) => ({
      start: start + (dur / n) * i,
      dur: dur / n,
      kind,
    }));
  }

  private starfield(dir: string, seed: number, format: "short" | "long", channel: Channel): string {
    const file = path.join(dir, `starfield-${seed}.png`);
    if (!fs.existsSync(file))
      drawStarfield(file, seed + 1, format, channel.theme.bg, channel.theme.bg2);
    return file;
  }

  /** Footage, a photo or an AI still for a shot, falling back down the chain. */
  private async media(
    kind: string,
    query: string,
    prompt: string | undefined,
    need: number,
    orientation: "portrait" | "landscape",
    channel: Channel,
    used: Asset[],
    lane: MediaLane,
    fresh: boolean,
  ): Promise<{ visual?: Scene["visual"]; asset?: Asset; got: string; fallback?: string }> {
    const exclude = used.map((a) => a.id);
    const chain =
      kind === "stock-video"
        ? ["stock-video", "stock-image", "ai-still"]
        : kind === "ai-still"
          ? ["ai-still", "stock-image", "stock-video"]
          : kind === "code"
            ? []
            : ["stock-image", "stock-video", "ai-still"];
    const notes: string[] = [];
    for (const step of chain) {
      try {
        if (step === "ai-still") {
          if (!this.deps.stills) continue;
          const asset = await this.deps.stills(prompt ?? query, orientation);
          return {
            visual: { type: "still", src: asset.path, move: "push-in" },
            asset,
            got: "ai-still",
            ...(notes.length ? { fallback: notes.join("; ") } : {}),
          };
        }
        const asset = await this.deps.stock.fetch({
          kind: step === "stock-video" ? "video" : "image",
          query,
          lane,
          orientation,
          prefer: channel.sources.prefer,
          exclude,
          fresh,
          ...(step === "stock-video" ? { minDuration: need + 1 } : {}),
        });
        if (!asset) {
          notes.push(`no ${step} for "${query}"`);
          continue;
        }
        const credit = asset.credit ? { credit: asset.credit } : {};
        const visual: Scene["visual"] =
          asset.kind === "video"
            ? { type: "video", src: asset.path, mediaStart: mediaStartFor(asset, need), ...credit }
            : { type: "still", src: asset.path, move: "push-in", ...credit };
        return {
          visual,
          asset,
          got: step,
          ...(notes.length ? { fallback: notes.join("; ") } : {}),
        };
      } catch (err) {
        notes.push(`${step}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      }
    }
    return { got: "code", ...(notes.length ? { fallback: notes.join("; ") } : {}) };
  }

  /** Three shorts from a long-form: the model picks self-contained stretches and new hooks. */
  private async waterfall(
    parent: VideoDoc,
    script: ScriptDoc,
    channel: Channel,
    count: number,
  ): Promise<void> {
    const numbered = script.beats
      .map((b, i) => `B${i} (${splitWords(b.narration).length} words): ${b.narration}`)
      .join("\n");
    const res = await this.deps.router.generate({
      tier: "creative",
      lane: this.deps.lane,
      system: `You cut long videos into vertical shorts for ${channel.name}. Each short must stand alone and make sense without the long video.`,
      prompt: `Pick ${count} non-overlapping stretches of consecutive beats (from B${0} to B${script.beats.length - 1}), each 60 to 130 words, that work as standalone shorts. For each give "from" and "to" beat numbers, a new one-sentence hook that opens the short with its most surprising true fact (taken from those beats), and a title under 70 characters.\n\n${numbered}`,
      schema: cutdownSchema,
      temperature: 0.6,
    });
    const cuts = (res.data?.cuts ?? [])
      .filter((c) => c.from <= c.to && c.to < script.beats.length)
      .slice(0, count);
    for (const cut of cuts) {
      const beats: Beat[] = [
        { narration: cut.hook, visual: { kind: "title", text: cut.title } },
        ...script.beats.slice(cut.from, cut.to + 1),
      ];
      const short: ScriptDoc = {
        ...script,
        format: "short",
        titles: [cut.title, ...script.titles.slice(0, 1)],
        beats,
      };
      const v = this.newVideo(short, channel, {
        kind: "cutdown",
        parentId: parent.id,
        test: parent.test,
        title: cut.title,
        titles: [cut.title],
        description: `${cut.hook} From our full video: ${parent.title}.`,
      });
      await this.run(v, short, channel, beats, true).catch((err: unknown) => {
        v.status = "failed";
        v.error = err instanceof Error ? err.message : String(err);
        this.save(v);
      });
    }
  }

  private submit(v: VideoDoc, channel: Channel): void {
    const s = v.screening;
    const lines = [
      `# ${v.title}`,
      "",
      `<!-- video:${v.id} -->`,
      "",
      `*${v.format === "long" ? "Long-form" : "Short"}${v.kind === "cutdown" ? ` (cut from ${v.parentId})` : ""} · ${(v.duration ?? 0).toFixed(1)} s · rendered in ${(v.renderSeconds ?? 0).toFixed(0)} s · voice: ${v.voice?.provider}${v.voice?.fallback ? ` (fallback: ${v.voice.fallback})` : ""}*`,
      "",
      v.test
        ? `> **Test render.** ${channel.status === "draft" ? "The channel is still a draft (pick its niche at the Desk)" : "The script wasn't approved yet"}, so this video can't be posted.`
        : "",
      "",
      "## Screening",
      "",
      s?.ok
        ? "- Clear: no black or frozen stretches, no long silences, loudness on target, no protected names."
        : (s?.problems ?? []).map((p) => `- ${p}`).join("\n"),
      `- Loudness ${s?.lufs.toFixed(1)} LUFS, true peak ${s?.truePeak.toFixed(1)} dB.`,
      `- AI disclosure: ${v.disclosure.syntheticMedia ? "realistic AI imagery, so the platforms' AI labels go on" : "no realistic AI imagery; AI narration noted in the description"}.`,
      "",
      "## Shots",
      "",
      ...v.shots.map(
        (r) =>
          `- ${r.start.toFixed(1)}s · ${r.want}${r.got !== r.want ? ` → ${r.got}` : ""}${r.fallback ? ` (${r.fallback})` : ""}`,
      ),
      "",
      "## Description",
      "",
      v.description,
      "",
    ];
    const content = lines.join("\n");
    const id = this.deps.store.nextId("D");
    this.deps.store.saveArtifact(
      {
        id,
        kind: "studio.video",
        title: `Video: ${v.title}`,
        mime: "text/markdown",
        taskId: null,
        objectiveId: null,
        createdBy: "frame",
        createdAt: this.now(),
        size: content.length,
        room: null,
        info: { videoId: v.id },
      },
      content,
    );
    v.artifactId = id;
    this.save(v);
    this.deps.director?.fileDeskItem({
      kind: "deliverable",
      title: `${v.test ? "[Test render] " : ""}Video ready: ${v.title.slice(0, 80)}`,
      summary: `${v.format === "long" ? "Long-form" : "Short"}, ${(v.duration ?? 0).toFixed(0)} s, ${s?.ok ? "screening clear" : `${s?.problems.length ?? 0} screening note(s)`}. ${v.test ? "Watch it; it can't be posted." : "Approve it for posting; send it back with a note to re-edit."}`,
      requestedBy: "frame",
      objectiveId: null,
      taskId: null,
      artifactId: id,
      action: null,
    });
    this.deps.say?.("operator", "A cut is ready at the Owner's Desk.");
  }

  private async onDecision(a: Approval): Promise<void> {
    if (!a.artifactId) return;
    const art = this.deps.store.artifact(a.artifactId);
    if (!art) return;
    if (art.meta.kind === "studio.script" && a.status === "approved") {
      const doc = this.deps.writers.scripts().find((s) => s.artifactId === a.artifactId);
      if (doc && this.deps.writers.script(doc.id)?.status === "approved") {
        try {
          this.produce(doc.id);
        } catch (err) {
          this.deps.log?.(`produce ${doc.id}: ${String(err)}`);
        }
      }
      return;
    }
    if (art.meta.kind !== "studio.video") return;
    const v = this.videos().find((x) => x.artifactId === a.artifactId);
    if (!v) return;
    if (a.status === "approved") {
      v.status = v.test ? "review" : "approved";
      this.save(v);
    } else if (a.status === "rejected") {
      v.status = "rejected";
      if (a.note) v.note = a.note;
      this.save(v);
      if (a.note?.trim() && v.kind === "main") {
        try {
          this.produce(v.scriptId, { test: v.test, note: a.note, fresh: true, cutdowns: 0 });
        } catch (err) {
          this.deps.log?.(`re-edit ${v.id}: ${String(err)}`);
        }
      }
    }
  }
}
