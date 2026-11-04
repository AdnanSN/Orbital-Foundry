import { drawText } from "./font";

/** A thin pixel-drawing wrapper around a 2D canvas context, with an origin offset. */
export class Pen {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    private ox = 0,
    private oy = 0,
  ) {}

  /** A pen whose (0, 0) is at (x, y) of this one. */
  at(x: number, y: number): Pen {
    return new Pen(this.ctx, this.ox + x, this.oy + y);
  }

  rect(x: number, y: number, w: number, h: number, color: string): this {
    if (w <= 0 || h <= 0) return this;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(this.ox + x, this.oy + y, w, h);
    return this;
  }

  px(x: number, y: number, color: string): this {
    return this.rect(x, y, 1, 1, color);
  }

  hline(x: number, y: number, w: number, color: string): this {
    return this.rect(x, y, w, 1, color);
  }

  vline(x: number, y: number, h: number, color: string): this {
    return this.rect(x, y, 1, h, color);
  }

  /** A 1px frame around a rectangle. */
  frame(x: number, y: number, w: number, h: number, color: string): this {
    this.hline(x, y, w, color);
    this.hline(x, y + h - 1, w, color);
    this.vline(x, y, h, color);
    this.vline(x + w - 1, y, h, color);
    return this;
  }

  /** A filled box with a 1px outline. */
  box(x: number, y: number, w: number, h: number, fill: string, outline: string): this {
    this.rect(x, y, w, h, outline);
    return this.rect(x + 1, y + 1, w - 2, h - 2, fill);
  }

  /** A filled box with rounded (cut) corners and a 1px outline. */
  pill(x: number, y: number, w: number, h: number, fill: string, outline: string): this {
    this.rect(x + 1, y, w - 2, h, outline);
    this.rect(x, y + 1, w, h - 2, outline);
    this.rect(x + 1, y + 1, w - 2, h - 2, fill);
    return this;
  }

  /** A filled circle drawn pixel by pixel. */
  disc(cx: number, cy: number, r: number, color: string): this {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y <= r * r + r * 0.6) this.px(cx + x, cy + y, color);
      }
    }
    return this;
  }

  /** Pixel-font text with its top-left at (x, y). */
  text(x: number, y: number, text: string, color: string, scale = 1): this {
    drawText(this.ctx, text, this.ox + x, this.oy + y, color, scale);
    return this;
  }

  clear(x: number, y: number, w: number, h: number): this {
    this.ctx.clearRect(this.ox + x, this.oy + y, w, h);
    return this;
  }
}

/** A canvas of a given size. Works in the browser; tests never call it. */
export function makeCanvas(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/** Deterministic per-tile noise in [0, 1), for texture variation. Avalanche-mixed (murmur3
 * finalizer), so neighbouring inputs give unrelated values and no lattice patterns appear. */
export function hash2(x: number, y: number, salt = 0): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
