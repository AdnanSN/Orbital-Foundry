import { type Canvas, createCanvas } from "@napi-rs/canvas";
import { z } from "zod";
import type { CreativeConfig } from "./config";
import { pickFont } from "./raster";

/**
 * `compose`: lay out text, shapes and images on a canvas (thumbnails, previews, listing
 * images). The spec is plain JSON so agents can write it; images are referenced by artifact id.
 */

const colorSchema = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, "a #hex colour");
const num = z.coerce.number();

const imageLayer = z.object({
  type: z.literal("image"),
  imageId: z.string(),
  x: num.default(0),
  y: num.default(0),
  width: num.optional(),
  height: num.optional(),
  fit: z.enum(["cover", "contain", "stretch"]).default("contain"),
  opacity: num.min(0).max(1).default(1),
});

const textLayer = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(200),
  x: num,
  y: num,
  /** Wrap within this width; also the box that autoFit shrinks the text to fit. */
  maxWidth: num.optional(),
  maxLines: num.int().min(1).max(6).default(3),
  size: num.min(6).max(600).default(96),
  /** "display", "body" or "mono" (config/creative.yaml), or a font family name. */
  font: z.string().default("display"),
  weight: z.enum(["normal", "bold", "900"]).default("bold"),
  color: colorSchema.default("#ffffff"),
  stroke: z.object({ color: colorSchema, width: num.min(0).max(60) }).optional(),
  shadow: z
    .object({ color: colorSchema, blur: num.min(0).max(80), x: num.default(0), y: num.default(0) })
    .optional(),
  align: z.enum(["left", "center", "right"]).default("left"),
  uppercase: z.boolean().default(false),
  autoFit: z.boolean().default(true),
  lineHeight: num.min(0.6).max(2).default(1.05),
});

const rectLayer = z.object({
  type: z.literal("rect"),
  x: num,
  y: num,
  width: num,
  height: num,
  color: colorSchema,
  radius: num.min(0).default(0),
});

export const composeSpecSchema = z.object({
  width: num.int().min(16).max(4096),
  height: num.int().min(16).max(4096),
  background: z
    .union([
      z.object({ color: colorSchema }),
      z.object({ gradient: z.tuple([colorSchema, colorSchema]), angle: num.default(90) }),
      z.object({ imageId: z.string(), fit: z.enum(["cover", "contain"]).default("cover") }),
    ])
    .optional(),
  layers: z.array(z.discriminatedUnion("type", [imageLayer, textLayer, rectLayer])).max(24),
});
export type ComposeSpec = z.infer<typeof composeSpecSchema>;
export type TextLayer = z.infer<typeof textLayer>;

/** Image ids in a spec, so the caller can load them first. */
export function imageIds(spec: ComposeSpec): string[] {
  const ids = spec.layers.flatMap((l) => (l.type === "image" ? [l.imageId] : []));
  if (spec.background && "imageId" in spec.background) ids.unshift(spec.background.imageId);
  return [...new Set(ids)];
}

export function render(
  spec: ComposeSpec,
  images: Map<string, Canvas>,
  fonts: CreativeConfig["fonts"],
): Canvas {
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const bg = spec.background;
  if (bg && "color" in bg) {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, spec.width, spec.height);
  } else if (bg && "gradient" in bg) {
    const rad = (bg.angle * Math.PI) / 180;
    const cx = spec.width / 2;
    const cy = spec.height / 2;
    const r = Math.hypot(spec.width, spec.height) / 2;
    const g = ctx.createLinearGradient(
      cx - Math.sin(rad) * r,
      cy + Math.cos(rad) * r,
      cx + Math.sin(rad) * r,
      cy - Math.cos(rad) * r,
    );
    g.addColorStop(0, bg.gradient[0]);
    g.addColorStop(1, bg.gradient[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, spec.width, spec.height);
  } else if (bg && "imageId" in bg) {
    const img = images.get(bg.imageId);
    if (img) drawFitted(ctx, img, 0, 0, spec.width, spec.height, bg.fit);
  }

  for (const layer of spec.layers) {
    ctx.save();
    if (layer.type === "rect") {
      ctx.fillStyle = layer.color;
      roundRect(ctx, layer.x, layer.y, layer.width, layer.height, layer.radius);
      ctx.fill();
    } else if (layer.type === "image") {
      const img = images.get(layer.imageId);
      if (img) {
        ctx.globalAlpha = layer.opacity;
        const w = layer.width ?? img.width;
        const h = layer.height ?? img.height;
        drawFitted(ctx, img, layer.x, layer.y, w, h, layer.fit);
      }
    } else {
      drawText(ctx, layer, fonts);
    }
    ctx.restore();
  }
  return canvas;
}

type Ctx = ReturnType<Canvas["getContext"]>;

function drawFitted(
  ctx: Ctx,
  img: Canvas,
  x: number,
  y: number,
  w: number,
  h: number,
  fit: "cover" | "contain" | "stretch",
): void {
  if (fit === "stretch") {
    ctx.drawImage(img, x, y, w, h);
    return;
  }
  const scale =
    fit === "cover"
      ? Math.max(w / img.width, h / img.height)
      : Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function fontFamily(name: string, fonts: CreativeConfig["fonts"]): string {
  if (name === "display" || name === "body" || name === "mono") return pickFont(fonts[name]);
  return name;
}

/** Greedy word wrap. Words longer than the line are kept whole (and shrink the size instead). */
export function wrap(measure: (s: string) => number, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Lay out a text layer: the size shrinks (autoFit) until the lines fit maxWidth and maxLines. */
export function layoutText(
  ctx: Ctx,
  layer: TextLayer,
  fonts: CreativeConfig["fonts"],
): { lines: string[]; size: number; font: string } {
  const family = fontFamily(layer.font, fonts);
  const text = layer.uppercase ? layer.text.toUpperCase() : layer.text;
  let size = layer.size;
  for (;;) {
    ctx.font = `${layer.weight} ${size}px "${family}"`;
    const measure = (s: string) => ctx.measureText(s).width;
    const lines = layer.maxWidth ? wrap(measure, text, layer.maxWidth) : [text];
    const fits =
      !layer.maxWidth ||
      (lines.length <= layer.maxLines && lines.every((l) => measure(l) <= (layer.maxWidth ?? 0)));
    if (fits || !layer.autoFit || size <= 8) {
      return { lines: lines.slice(0, layer.maxLines), size, font: ctx.font };
    }
    size = Math.max(8, Math.floor(size * 0.92));
  }
}

function drawText(ctx: Ctx, layer: TextLayer, fonts: CreativeConfig["fonts"]): void {
  const { lines, size, font } = layoutText(ctx, layer, fonts);
  ctx.font = font;
  ctx.textAlign = layer.align;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const step = size * layer.lineHeight;
  for (const [i, line] of lines.entries()) {
    const y = layer.y + i * step;
    if (layer.shadow) {
      ctx.save();
      ctx.shadowColor = layer.shadow.color;
      ctx.shadowBlur = layer.shadow.blur;
      ctx.shadowOffsetX = layer.shadow.x;
      ctx.shadowOffsetY = layer.shadow.y;
      ctx.fillStyle = layer.shadow.color;
      ctx.fillText(line, layer.x, y);
      ctx.restore();
    }
    if (layer.stroke && layer.stroke.width > 0) {
      ctx.strokeStyle = layer.stroke.color;
      ctx.lineWidth = layer.stroke.width;
      ctx.strokeText(line, layer.x, y);
    }
    ctx.fillStyle = layer.color;
    ctx.fillText(line, layer.x, y);
  }
}
