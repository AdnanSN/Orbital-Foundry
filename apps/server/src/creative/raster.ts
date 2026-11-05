import {
  type Canvas,
  createCanvas,
  GlobalFonts,
  type Image,
  ImageData,
  loadImage,
} from "@napi-rs/canvas";

/**
 * Pixel operations for the creative toolchain (ROADMAP Stage 5). Everything runs in-process on
 * @napi-rs/canvas (Skia): decoding, resampling, keying, cutouts, palette quantization, sprite
 * sheets and text layout. External tools (Real-ESRGAN, rembg) are optional upgrades.
 */

export type Rgb = [number, number, number];

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
}

export async function decode(bytes: Buffer): Promise<Canvas> {
  const img = await loadImage(bytes);
  return canvasOf(img);
}

export function canvasOf(img: Image | Canvas): Canvas {
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext("2d").drawImage(img, 0, 0);
  return canvas;
}

export function pixels(canvas: Canvas): Pixels {
  const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

export function fromPixels(p: Pixels): Canvas {
  const canvas = createCanvas(p.width, p.height);
  canvas.getContext("2d").putImageData(new ImageData(p.data, p.width, p.height), 0, 0);
  return canvas;
}

export function encodePng(canvas: Canvas): Promise<Buffer> {
  return canvas.encode("png");
}

/** A flattened JPEG for vision models: transparent areas become mid-grey so edges stay visible. */
export async function previewJpeg(canvas: Canvas, maxSide: number): Promise<Buffer> {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const out = createCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#7f7f7f";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, w, h);
  return out.encode("jpeg", 85);
}

// -- Geometry ----------------------------------------------------------------------------------

/** Scale to exactly width × height: `cover` crops the overflow (centred), `contain` letterboxes. */
export function fitTo(
  src: Canvas,
  width: number,
  height: number,
  mode: "cover" | "contain" = "cover",
  background: string | null = null,
): Canvas {
  const out = createCanvas(width, height);
  const ctx = out.getContext("2d");
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  const scale =
    mode === "cover"
      ? Math.max(width / src.width, height / src.height)
      : Math.min(width / src.width, height / src.height);
  const w = src.width * scale;
  const h = src.height * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, (width - w) / 2, (height - h) / 2, w, h);
  return out;
}

/** Resample up by `factor` in steps of at most 2×, with high-quality smoothing. */
export function resampleUp(src: Canvas, factor: number): Canvas {
  let current = src;
  let remaining = factor;
  while (remaining > 1.001) {
    const step = Math.min(2, remaining);
    const next = createCanvas(Math.round(current.width * step), Math.round(current.height * step));
    const ctx = next.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, 0, 0, next.width, next.height);
    current = next;
    remaining /= step;
  }
  return current;
}

/** Nearest-neighbour scaling by an integer factor (pixel art previews). */
export function scaleNearest(src: Canvas, factor: number): Canvas {
  const out = createCanvas(src.width * factor, src.height * factor);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

// -- Colour ------------------------------------------------------------------------------------

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const h =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function dist(d: Uint8ClampedArray, i: number, c: Rgb): number {
  const dr = (d[i] ?? 0) - c[0];
  const dg = (d[i + 1] ?? 0) - c[1];
  const db = (d[i + 2] ?? 0) - c[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** The background colour: the median of the opaque pixels along the border. */
export function detectBackground(p: Pixels): Rgb {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * p.width + x) * 4;
    if ((p.data[i + 3] ?? 0) < 128) return;
    rs.push(p.data[i] ?? 0);
    gs.push(p.data[i + 1] ?? 0);
    bs.push(p.data[i + 2] ?? 0);
  };
  const step = Math.max(1, Math.floor(Math.max(p.width, p.height) / 256));
  for (let x = 0; x < p.width; x += step) {
    take(x, 0);
    take(x, p.height - 1);
  }
  for (let y = 0; y < p.height; y += step) {
    take(0, y);
    take(p.width - 1, y);
  }
  const median = (v: number[]) => {
    if (v.length === 0) return 255;
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] ?? 255;
  };
  return [median(rs), median(gs), median(bs)];
}

export interface KeyOptions {
  /** The colour to remove; detected from the border when omitted. */
  color?: Rgb;
  /** RGB distance that counts as background (default 48). */
  tolerance?: number;
  /** Width of the soft edge after the tolerance (default 24). */
  feather?: number;
}

/** Chroma key: every pixel near the key colour becomes transparent, wherever it is. */
export function chromaKey(p: Pixels, opts: KeyOptions = {}): { pixels: Pixels; key: Rgb } {
  const key = opts.color ?? detectBackground(p);
  const tol = opts.tolerance ?? 48;
  const feather = Math.max(1, opts.feather ?? 24);
  const out = new Uint8ClampedArray(p.data);
  for (let i = 0; i < out.length; i += 4) {
    const d = dist(out, i, key);
    if (d <= tol) out[i + 3] = 0;
    else if (d < tol + feather) out[i + 3] = Math.round((out[i + 3] ?? 0) * ((d - tol) / feather));
  }
  despill(out, key);
  return { pixels: { width: p.width, height: p.height, data: out }, key };
}

/**
 * Edge flood fill: background is whatever is connected to the border and close to the border's
 * colour. Unlike a chroma key, it keeps matching colours inside the subject (white eyes on a
 * white background, say).
 */
export function removeBackgroundEdges(
  p: Pixels,
  opts: KeyOptions = {},
): { pixels: Pixels; key: Rgb; removed: number } {
  const { width, height } = p;
  const key = opts.color ?? detectBackground(p);
  const tol = opts.tolerance ?? 48;
  const feather = Math.max(1, opts.feather ?? 24);
  const data = new Uint8ClampedArray(p.data);
  const n = width * height;
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (idx: number) => {
    if (bg[idx]) return;
    if (dist(data, idx * 4, key) > tol && (data[idx * 4 + 3] ?? 0) > 16) return;
    bg[idx] = 1;
    queue[tail++] = idx;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const idx = queue[head++] ?? 0;
    const x = idx % width;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (idx >= width) push(idx - width);
    if (idx < n - width) push(idx + width);
  }
  let removed = 0;
  for (let idx = 0; idx < n; idx++) {
    const i = idx * 4;
    if (bg[idx]) {
      data[i + 3] = 0;
      removed += 1;
      continue;
    }
    // Soften the subject's rim: pixels next to the background that are still close to it.
    const x = idx % width;
    const touches =
      (x > 0 && bg[idx - 1]) ||
      (x < width - 1 && bg[idx + 1]) ||
      (idx >= width && bg[idx - width]) ||
      (idx < n - width && bg[idx + width]);
    if (touches) {
      const d = dist(data, i, key);
      if (d < tol + feather) data[i + 3] = Math.round((data[i + 3] ?? 0) * ((d - tol) / feather));
    }
  }
  despill(data, key);
  return { pixels: { width, height, data }, key, removed };
}

/** Pull the key colour's tint out of semi-transparent edge pixels. */
function despill(data: Uint8ClampedArray, key: Rgb): void {
  const max = Math.max(...key);
  const dominant = key.indexOf(max);
  const others = [0, 1, 2].filter((c) => c !== dominant);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 0 || a === 255) continue;
    const limit = Math.max(...others.map((c) => data[i + c] ?? 0));
    if ((data[i + dominant] ?? 0) > limit) data[i + dominant] = limit;
  }
}

// -- Pixel art ----------------------------------------------------------------------------------

/** Downscale so the longest side is `size`: area-average (default) or nearest-neighbour. */
export function downscale(src: Canvas, size: number, method: "average" | "nearest"): Pixels {
  const scale = size / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const s = pixels(src);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * s.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * s.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * s.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * s.width) / w));
      const o = (y * w + x) * 4;
      if (method === "nearest") {
        const i = (Math.floor((y0 + y1) / 2) * s.width + Math.floor((x0 + x1) / 2)) * 4;
        for (let c = 0; c < 4; c++) out[o + c] = s.data[i + c] ?? 0;
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * s.width + xx) * 4;
          const alpha = s.data[i + 3] ?? 0;
          r += (s.data[i] ?? 0) * alpha;
          g += (s.data[i + 1] ?? 0) * alpha;
          b += (s.data[i + 2] ?? 0) * alpha;
          a += alpha;
          count += 1;
        }
      }
      out[o] = a > 0 ? r / a : 0;
      out[o + 1] = a > 0 ? g / a : 0;
      out[o + 2] = a > 0 ? b / a : 0;
      out[o + 3] = count > 0 ? a / count : 0;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Median-cut palette quantization. Pixels at least half transparent become fully transparent;
 * the rest snap to the nearest palette colour and become fully opaque (crisp pixel art).
 */
export function quantize(p: Pixels, colors: number): { pixels: Pixels; palette: Rgb[] } {
  const opaque: Rgb[] = [];
  for (let i = 0; i < p.data.length; i += 4) {
    if ((p.data[i + 3] ?? 0) >= 128)
      opaque.push([p.data[i] ?? 0, p.data[i + 1] ?? 0, p.data[i + 2] ?? 0]);
  }
  const palette = medianCut(opaque, Math.max(1, Math.min(256, colors)));
  const out = new Uint8ClampedArray(p.data.length);
  for (let i = 0; i < p.data.length; i += 4) {
    if ((p.data[i + 3] ?? 0) < 128 || palette.length === 0) continue;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (const [k, c] of palette.entries()) {
      const d = dist(p.data, i, c);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    const c = palette[best] ?? [0, 0, 0];
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = 255;
  }
  return { pixels: { width: p.width, height: p.height, data: out }, palette };
}

function medianCut(colors: Rgb[], target: number): Rgb[] {
  if (colors.length === 0) return [];
  let boxes: Rgb[][] = [colors];
  while (boxes.length < target) {
    // Split the box with the widest channel range.
    let pick = -1;
    let pickRange = 0;
    let pickChannel = 0;
    for (const [bi, box] of boxes.entries()) {
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const col of box) {
          lo = Math.min(lo, col[c] ?? 0);
          hi = Math.max(hi, col[c] ?? 0);
        }
        if (hi - lo > pickRange) {
          pickRange = hi - lo;
          pick = bi;
          pickChannel = c;
        }
      }
    }
    if (pick < 0 || pickRange === 0) break;
    const box = boxes[pick] ?? [];
    box.sort((a, b) => (a[pickChannel] ?? 0) - (b[pickChannel] ?? 0));
    const mid = Math.floor(box.length / 2);
    boxes = [...boxes.slice(0, pick), box.slice(0, mid), box.slice(mid), ...boxes.slice(pick + 1)];
  }
  return boxes.map((box) => {
    const sum = box.reduce<Rgb>(
      (acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]],
      [0, 0, 0],
    );
    return [
      Math.round(sum[0] / box.length),
      Math.round(sum[1] / box.length),
      Math.round(sum[2] / box.length),
    ];
  });
}

// -- Sprite sheets -------------------------------------------------------------------------------

export interface Atlas {
  cell: { w: number; h: number };
  columns: number;
  rows: number;
  padding: number;
  frames: { name: string; x: number; y: number; w: number; h: number }[];
}

/** Pack frames into a uniform grid (each cell sized to the largest frame, frames centred). */
export function packSheet(
  frames: { name: string; canvas: Canvas }[],
  opts: { columns?: number; padding?: number } = {},
): { canvas: Canvas; atlas: Atlas } {
  const padding = Math.max(0, opts.padding ?? 0);
  const cw = Math.max(1, ...frames.map((f) => f.canvas.width));
  const ch = Math.max(1, ...frames.map((f) => f.canvas.height));
  const columns = Math.max(1, opts.columns ?? Math.ceil(Math.sqrt(frames.length)));
  const rows = Math.max(1, Math.ceil(frames.length / columns));
  const canvas = createCanvas(
    columns * cw + (columns + 1) * padding,
    rows * ch + (rows + 1) * padding,
  );
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const atlas: Atlas = { cell: { w: cw, h: ch }, columns, rows, padding, frames: [] };
  for (const [i, f] of frames.entries()) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = padding + col * (cw + padding);
    const y = padding + row * (ch + padding);
    const ox = Math.floor((cw - f.canvas.width) / 2);
    const oy = Math.floor((ch - f.canvas.height) / 2);
    ctx.drawImage(f.canvas, x + ox, y + oy);
    atlas.frames.push({ name: f.name, x, y, w: cw, h: ch });
  }
  return { canvas, atlas };
}

// -- Checks --------------------------------------------------------------------------------------

export interface BasicChecks {
  width: number;
  height: number;
  /** Share of pixels that are visible (alpha > 16). */
  coverage: number;
  /** Share of border pixels that are opaque (a clean cutout has almost none). */
  edgeOpaque: number;
  /** Standard deviation of luminance over visible pixels: near 0 means a blank image. */
  contrast: number;
  blank: boolean;
}

export function basicChecks(p: Pixels): BasicChecks {
  const { width, height, data } = p;
  let visible = 0;
  let sum = 0;
  let sumSq = 0;
  const step = Math.max(1, Math.floor((width * height) / 250_000));
  let sampled = 0;
  for (let idx = 0; idx < width * height; idx += step) {
    const i = idx * 4;
    sampled += 1;
    if ((data[i + 3] ?? 0) <= 16) continue;
    visible += 1;
    const l = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
    sum += l;
    sumSq += l * l;
  }
  let edge = 0;
  let edgeOpaque = 0;
  const check = (x: number, y: number) => {
    edge += 1;
    if ((data[(y * width + x) * 4 + 3] ?? 0) > 200) edgeOpaque += 1;
  };
  for (let x = 0; x < width; x++) {
    check(x, 0);
    check(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    check(0, y);
    check(width - 1, y);
  }
  const mean = visible > 0 ? sum / visible : 0;
  const contrast = visible > 0 ? Math.sqrt(Math.max(0, sumSq / visible - mean * mean)) : 0;
  const coverage = sampled > 0 ? visible / sampled : 0;
  return {
    width,
    height,
    coverage: round3(coverage),
    edgeOpaque: round3(edge > 0 ? edgeOpaque / edge : 0),
    contrast: round3(contrast),
    blank: coverage < 0.005 || contrast < 3,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The first installed family from a list (system fonts), or the last entry as a fallback. */
export function pickFont(families: readonly string[]): string {
  for (const f of families) if (GlobalFonts.has(f)) return f;
  return families.at(-1) ?? "sans-serif";
}
