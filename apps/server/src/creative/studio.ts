import fs from "node:fs";
import path from "node:path";
import type { Canvas } from "@napi-rs/canvas";
import type { ArtifactMeta, ArtifactReview, Lane } from "@orbital/shared";
import type { ImageRequest, ImageResult } from "../images/imageService";
import type { ModelRouter } from "../llm/router";
import type { WorkStore } from "../work/store";
import { type ComposeSpec, imageIds, render } from "./compose";
import {
  type Blocklist,
  type CreativeConfig,
  type Cutout,
  type Style,
  styledPrompt,
} from "./config";
import { realEsrgan, rembg } from "./external";
import { blocklistHits, type IpScreenResult, ipScreen, type QaVerdict, visionQa } from "./qa";
import {
  type Atlas,
  type BasicChecks,
  basicChecks,
  chromaKey,
  decode,
  downscale,
  encodePng,
  fitTo,
  fromPixels,
  packSheet,
  parseHex,
  pixels,
  previewJpeg,
  quantize,
  removeBackgroundEdges,
  resampleUp,
  scaleNearest,
  toHex,
} from "./raster";

/**
 * The creative studio (ROADMAP Stage 5): every image tool, backed by the artifact store. Each
 * operation writes a new PNG under `dir`, records it as an artifact (with the source image as
 * `parentId` and the tool's details in `info`) and announces it, so the room's gallery updates
 * live. Nothing here publishes anything: images stay in the station until the owner approves a
 * listing (Stage 7).
 */

export interface StudioDeps {
  images: { generate(lane: Lane, req: ImageRequest): Promise<ImageResult> } | null;
  router: ModelRouter | null;
  store: WorkStore;
  /** Where image files are written. */
  dir: string;
  lane: Lane;
  config: CreativeConfig;
  styles: Record<string, Style>;
  blocklist: Blocklist;
  /** Sim time, ms. */
  now(): number;
  onArtifact?(meta: ArtifactMeta, change: "created" | "updated"): void;
  /** A status line from whoever works in `room` (speech bubbles). */
  say?(room: string | null, text: string): void;
}

export interface Origin {
  createdBy: string;
  taskId?: string | null;
  objectiveId?: string | null;
  /** The gallery it shows up in; inherited from the source image when omitted. */
  room?: string | null;
}

export interface QaResult {
  id: string;
  checks: BasicChecks;
  vision: QaVerdict | null;
  score: number | null;
  pass: boolean;
  note: string | null;
}

export interface PipelineInput {
  prompt: string;
  style?: string;
  aspect?: string;
  seed?: number;
  title?: string;
  /** 0 skips the upscale. */
  upscale?: 0 | 2 | 4;
  /** "auto" uses the style's cutout setting. */
  cutout?: Cutout | "auto";
  qa?: boolean;
  /** What the image is for (QA context). */
  purpose?: string;
}

export interface PipelineResult {
  steps: ArtifactMeta[];
  final: ArtifactMeta;
  qa: QaResult | null;
}

export class CreativeStudio {
  constructor(private readonly deps: StudioDeps) {
    fs.mkdirSync(deps.dir, { recursive: true });
  }

  get config(): CreativeConfig {
    return this.deps.config;
  }

  styles(): { id: string; description: string; aspect: string; cutout: Cutout }[] {
    return Object.entries(this.deps.styles).map(([id, s]) => ({
      id,
      description: s.description,
      aspect: s.aspect,
      cutout: s.cutout,
    }));
  }

  aspects(): string[] {
    return Object.keys(this.deps.config.aspects);
  }

  // -- Tools -------------------------------------------------------------------------------------

  async generate(
    input: { prompt: string; style?: string; aspect?: string; seed?: number; title?: string },
    origin: Origin,
  ): Promise<ArtifactMeta> {
    const { images, lane, config } = this.deps;
    if (!images) throw new Error("Image generation is not configured on this station.");
    const style = input.style ? this.deps.styles[input.style] : undefined;
    if (input.style && !style) {
      throw new Error(
        `Unknown style "${input.style}". Styles: ${Object.keys(this.deps.styles).join(", ")}.`,
      );
    }
    const aspect = input.aspect ?? style?.aspect ?? "1:1";
    const size = config.aspects[aspect];
    if (!size)
      throw new Error(`Unknown aspect "${aspect}". Aspects: ${this.aspects().join(", ")}.`);
    const hits = blocklistHits(input.prompt, this.deps.blocklist);
    if (hits.length > 0) {
      throw new Error(
        `The prompt names protected IP (${hits.map((h) => h.term).join(", ")}). Rephrase it without them.`,
      );
    }
    const prompt = styledPrompt(input.prompt, style);
    this.deps.say?.(origin.room ?? null, `Generating: ${input.prompt.slice(0, 32)}…`);
    const res = await images.generate(lane, {
      prompt,
      width: size[0],
      height: size[1],
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      purpose: "generate_image",
    });
    let canvas = await decode(res.bytes);
    const native = { width: canvas.width, height: canvas.height };
    if (canvas.width !== size[0] || canvas.height !== size[1]) {
      canvas = fitTo(canvas, size[0], size[1], "cover");
    }
    return this.save(canvas, {
      title: input.title ?? titleFrom(input.prompt),
      origin,
      parentId: null,
      info: {
        op: "generate",
        prompt: input.prompt,
        fullPrompt: prompt,
        style: input.style ?? null,
        aspect,
        seed: res.seed ?? null,
        endpoint: res.endpoint,
        provider: res.provider,
        lane,
        native: `${native.width}×${native.height}`,
        latencyMs: res.latencyMs,
      },
    });
  }

  async upscale(id: string, factor: 2 | 4, origin: Origin): Promise<ArtifactMeta> {
    const { canvas, meta } = await this.load(id);
    const { realesrgan, model, maxSide } = this.deps.config.upscale;
    if (Math.max(canvas.width, canvas.height) * factor > maxSide) {
      throw new Error(
        `${id} is ${canvas.width}×${canvas.height}; ×${factor} would pass the ${maxSide}px limit.`,
      );
    }
    this.deps.say?.(this.roomOf(origin, meta), `Upscaling ${id} ×${factor}…`);
    let out: Canvas;
    let method = "resample";
    if (realesrgan) {
      try {
        out = await decode(await realEsrgan(realesrgan, await encodePng(canvas), factor, model));
        method = `realesrgan:${model}`;
      } catch (err) {
        out = resampleUp(canvas, factor);
        method = `resample (Real-ESRGAN failed: ${String(err).slice(0, 120)})`;
      }
    } else {
      out = resampleUp(canvas, factor);
    }
    return this.save(out, {
      title: `${meta.title} ×${factor}`,
      origin: this.inherit(origin, meta),
      parentId: id,
      info: { op: "upscale", factor, method },
    });
  }

  /**
   * Remove the background. "auto" picks rembg when configured, the chroma key when the source
   * style asked for a flat key colour, and the edge flood fill otherwise.
   */
  async cutout(
    id: string,
    method: Cutout | "auto",
    opts: { color?: string; tolerance?: number; feather?: number },
    origin: Origin,
  ): Promise<ArtifactMeta> {
    const { canvas, meta } = await this.load(id);
    const bgConfig = this.deps.config.background;
    const sourceStyle = this.sourceStyle(meta);
    let chosen: Cutout =
      method === "auto"
        ? bgConfig.rembg
          ? "rembg"
          : sourceStyle?.cutout === "chroma"
            ? "chroma"
            : "edges"
        : method;
    if (chosen === "none") throw new Error('Cutout method "none" does nothing.');
    if (chosen === "rembg" && !bgConfig.rembg) chosen = "edges";
    const color = opts.color ? parseHex(opts.color) : null;
    if (opts.color && !color) throw new Error(`"${opts.color}" is not a #rrggbb colour.`);
    const keyOpts = {
      ...(color ? { color } : {}),
      tolerance: opts.tolerance ?? bgConfig.tolerance,
      feather: opts.feather ?? bgConfig.feather,
    };
    this.deps.say?.(this.roomOf(origin, meta), `Cutting out ${id} (${chosen})…`);
    let out: Canvas;
    const info: Record<string, unknown> = { op: "cutout", method: chosen };
    if (chosen === "rembg") {
      try {
        out = await decode(await rembg(bgConfig.rembg, await encodePng(canvas)));
      } catch (err) {
        const r = removeBackgroundEdges(pixels(canvas), keyOpts);
        out = fromPixels(r.pixels);
        info.method = "edges";
        info.fallback = `rembg failed: ${String(err).slice(0, 120)}`;
        info.key = toHex(r.key);
      }
    } else if (chosen === "chroma") {
      const r = chromaKey(pixels(canvas), keyOpts);
      out = fromPixels(r.pixels);
      info.key = toHex(r.key);
    } else {
      const r = removeBackgroundEdges(pixels(canvas), keyOpts);
      out = fromPixels(r.pixels);
      info.key = toHex(r.key);
      info.removed = Math.round((r.removed / (canvas.width * canvas.height)) * 1000) / 1000;
    }
    return this.save(out, {
      title: `${meta.title} (cutout)`,
      origin: this.inherit(origin, meta),
      parentId: id,
      info,
    });
  }

  async compose(spec: ComposeSpec, title: string, origin: Origin): Promise<ArtifactMeta> {
    const images = new Map<string, Canvas>();
    let parent: ArtifactMeta | null = null;
    for (const ref of imageIds(spec)) {
      const loaded = await this.load(ref);
      images.set(ref, loaded.canvas);
      parent ??= loaded.meta;
    }
    const canvas = render(spec, images, this.deps.config.fonts);
    return this.save(canvas, {
      title,
      origin: parent ? this.inherit(origin, parent) : origin,
      parentId: parent?.id ?? null,
      info: { op: "compose", spec },
    });
  }

  async pixelate(
    id: string,
    opts: { size: number; colors: number; method?: "average" | "nearest"; scale?: number },
    origin: Origin,
  ): Promise<ArtifactMeta> {
    const { canvas, meta } = await this.load(id);
    const small = downscale(canvas, opts.size, opts.method ?? "average");
    const q = quantize(small, opts.colors);
    let out = fromPixels(q.pixels);
    const scale = Math.max(1, Math.min(32, Math.floor(opts.scale ?? 1)));
    if (scale > 1) out = scaleNearest(out, scale);
    return this.save(out, {
      title: `${meta.title} (${opts.size}px)`,
      origin: this.inherit(origin, meta),
      parentId: id,
      info: {
        op: "pixelate",
        size: opts.size,
        colors: opts.colors,
        method: opts.method ?? "average",
        scale,
        palette: q.palette.map(toHex),
        pixelArt: true,
      },
    });
  }

  async spritesheet(
    ids: string[],
    opts: { columns?: number; padding?: number; title?: string },
    origin: Origin,
  ): Promise<{ meta: ArtifactMeta; atlas: Atlas }> {
    if (ids.length === 0) throw new Error("A sprite sheet needs at least one image.");
    const frames: { name: string; canvas: Canvas }[] = [];
    let first: ArtifactMeta | null = null;
    for (const ref of ids) {
      const loaded = await this.load(ref);
      first ??= loaded.meta;
      frames.push({ name: ref, canvas: loaded.canvas });
    }
    const { canvas, atlas } = packSheet(frames, opts);
    const meta = await this.save(canvas, {
      title: opts.title ?? `Sprite sheet (${ids.length} frames)`,
      origin: first ? this.inherit(origin, first) : origin,
      parentId: first?.id ?? null,
      info: { op: "spritesheet", atlas, pixelArt: first?.info?.pixelArt === true },
    });
    return { meta, atlas };
  }

  /** Deterministic checks always; the vision rubric when a model is available. */
  async qa(id: string, purpose?: string, expectText?: string | null): Promise<QaResult> {
    const { canvas, meta } = await this.load(id);
    const checks = basicChecks(pixels(canvas));
    const transparent = checks.edgeOpaque < 0.5 && checks.coverage < 0.98;
    let vision: QaVerdict | null = null;
    let note: string | null = null;
    if (checks.blank) {
      note = "The image is blank.";
    } else if (this.deps.router) {
      this.deps.say?.(meta.room ?? null, `QA on ${id}…`);
      try {
        const jpeg = await previewJpeg(canvas, this.deps.config.qa.maxSide);
        vision = await visionQa(this.deps.router, this.deps.lane, jpeg, {
          purpose: purpose ?? this.purposeOf(meta),
          transparent,
          ...(expectText !== undefined ? { expectText } : {}),
        });
      } catch (err) {
        note = `Vision QA unavailable: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
      }
    } else {
      note = "No vision model; basic checks only.";
    }
    const score = vision ? vision.score : null;
    const pass =
      !checks.blank &&
      (vision ? vision.score >= this.deps.config.qa.passScore && !vision.garbledText : false);
    const result: QaResult = { id, checks, vision, score, pass, note };
    this.update(id, {
      info: {
        qa: {
          score,
          pass,
          defects: vision?.defects ?? [],
          garbledText: vision?.garbledText ?? null,
          legibility: vision?.legibility ?? null,
          notes: vision?.notes ?? note ?? "",
          checks,
        },
      },
    });
    return result;
  }

  /** The IP screen on text (and, when given, an image). The verdict is saved on the image. */
  async screen(text: string, imageId?: string): Promise<IpScreenResult> {
    let jpeg: Buffer | undefined;
    if (imageId) {
      const { canvas } = await this.load(imageId);
      jpeg = await previewJpeg(canvas, this.deps.config.qa.maxSide);
    }
    const result = await ipScreen(
      this.deps.router,
      this.deps.lane,
      this.deps.blocklist,
      text,
      jpeg,
    );
    if (imageId) {
      this.update(imageId, {
        info: {
          ip: { verdict: result.verdict, hits: result.hits, risk: result.llm?.risk ?? null },
        },
      });
    }
    return result;
  }

  /** Prompt → image → upscale → cutout → QA, as one job. */
  async pipeline(input: PipelineInput, origin: Origin): Promise<PipelineResult> {
    const steps: ArtifactMeta[] = [];
    const base = await this.generate(
      {
        prompt: input.prompt,
        ...(input.style ? { style: input.style } : {}),
        ...(input.aspect ? { aspect: input.aspect } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.title ? { title: input.title } : {}),
      },
      origin,
    );
    steps.push(base);
    let current = base;
    const style = input.style ? this.deps.styles[input.style] : undefined;
    const cutout =
      input.cutout === "auto" || input.cutout === undefined
        ? (style?.cutout ?? "none")
        : input.cutout;
    // Cut out at the generated size (cleaner key, 16× fewer pixels), then upscale with alpha.
    if (cutout !== "none") {
      current = await this.cutout(current.id, cutout, {}, origin);
      steps.push(current);
    }
    const factor = input.upscale ?? 4;
    if (factor === 2 || factor === 4) {
      current = await this.upscale(current.id, factor, origin);
      steps.push(current);
    }
    let qa: QaResult | null = null;
    if (input.qa !== false) {
      // QA the full-size result; the vision model sees a downscaled preview.
      qa = await this.qa(current.id, input.purpose ?? style?.description);
      current = this.deps.store.artifact(current.id)?.meta ?? current;
      steps[steps.length - 1] = current;
    }
    return { steps, final: current, qa };
  }

  review(id: string, decision: ArtifactReview, note?: string): ArtifactMeta {
    const meta = this.update(id, {
      review: decision,
      ...(note ? { info: { reviewNote: note } } : {}),
    });
    if (!meta) throw new Error(`No artifact "${id}"`);
    return meta;
  }

  /** The image file behind an artifact, if it lives in the studio folder. */
  file(id: string): { path: string; mime: string } | null {
    const a = this.deps.store.artifact(id);
    if (!a?.path) return null;
    const resolved = path.resolve(a.path);
    const root = path.resolve(this.deps.dir);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) return null;
    return { path: resolved, mime: a.meta.mime };
  }

  // -- Internals -----------------------------------------------------------------------------------

  private async load(id: string): Promise<{ canvas: Canvas; meta: ArtifactMeta }> {
    const file = this.file(id);
    const a = this.deps.store.artifact(id);
    if (!file || !a?.meta.mime.startsWith("image/")) throw new Error(`${id} is not an image.`);
    return { canvas: await decode(fs.readFileSync(file.path)), meta: a.meta };
  }

  private async save(
    canvas: Canvas,
    f: { title: string; origin: Origin; parentId: string | null; info: Record<string, unknown> },
  ): Promise<ArtifactMeta> {
    const id = this.deps.store.nextId("I");
    const bytes = await encodePng(canvas);
    const file = path.join(this.deps.dir, `${id}.png`);
    fs.writeFileSync(file, bytes);
    const meta: ArtifactMeta = {
      id,
      kind: "image",
      title: f.title.slice(0, 140),
      mime: "image/png",
      taskId: f.origin.taskId ?? null,
      objectiveId: f.origin.objectiveId ?? null,
      createdBy: f.origin.createdBy,
      createdAt: this.deps.now(),
      size: bytes.length,
      room: f.origin.room ?? null,
      review: "pending",
      parentId: f.parentId,
      info: { ...f.info, width: canvas.width, height: canvas.height },
    };
    this.deps.store.saveArtifact(meta, null, file);
    this.deps.onArtifact?.(meta, "created");
    return meta;
  }

  private update(
    id: string,
    patch: { review?: ArtifactReview; info?: Record<string, unknown> },
  ): ArtifactMeta | null {
    const meta = this.deps.store.updateArtifact(id, patch);
    if (meta) this.deps.onArtifact?.(meta, "updated");
    return meta;
  }

  private inherit(origin: Origin, parent: ArtifactMeta): Origin {
    return {
      ...origin,
      room: origin.room ?? parent.room ?? null,
      taskId: origin.taskId ?? parent.taskId,
      objectiveId: origin.objectiveId ?? parent.objectiveId,
    };
  }

  private roomOf(origin: Origin, meta: ArtifactMeta): string | null {
    return origin.room ?? meta.room ?? null;
  }

  /** The style of the image this one descends from (cutout choice, QA purpose). */
  private sourceStyle(meta: ArtifactMeta): Style | undefined {
    let current: ArtifactMeta | undefined = meta;
    for (let depth = 0; current && depth < 8; depth++) {
      const style = current.info?.style;
      if (typeof style === "string") return this.deps.styles[style];
      current = current.parentId ? this.deps.store.artifact(current.parentId)?.meta : undefined;
    }
    return undefined;
  }

  private purposeOf(meta: ArtifactMeta): string {
    return this.sourceStyle(meta)?.description ?? "a product image for an online shop";
  }
}

function titleFrom(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 7).join(" ");
  return words.length > 0 ? words[0]?.toUpperCase() + words.slice(1) : "Image";
}
