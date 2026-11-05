import { type Canvas, createCanvas } from "@napi-rs/canvas";
import { pickFont } from "../creative/raster";
import type { MockupKind, Product } from "./config";

/**
 * Honest mockups (ROADMAP §7.1 step 5): simple product shapes drawn in code with the actual print
 * file placed where it prints. No photo templates, so nothing implies a product we don't sell,
 * and every pixel of the design shown is the design the buyer gets.
 */

const SIZE = 1200;
type Ctx = ReturnType<Canvas["getContext"]>;

function backdrop(ctx: Ctx, top: string, bottom: string): void {
  const g = ctx.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

function shadow(ctx: Ctx, cx: number, cy: number, rx: number, ry: number): void {
  const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, rx);
  g.addColorStop(0, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw `src` (or its region sx,sy,sw,sh) inside a box, keeping its aspect ratio. */
function drawInto(
  ctx: Ctx,
  src: Canvas,
  x: number,
  y: number,
  w: number,
  h: number,
  region?: [number, number, number, number],
): void {
  const [sx, sy, sw, sh] = region ?? [0, 0, src.width, src.height];
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function frame(ctx: Ctx, design: Canvas): void {
  backdrop(ctx, "#efe9df", "#d8cfc1");
  ctx.fillStyle = "#c9bca8";
  ctx.fillRect(0, SIZE * 0.86, SIZE, SIZE * 0.14);
  const aspect = design.width / design.height;
  const h = SIZE * 0.66;
  const w = h * aspect;
  const x = (SIZE - w) / 2;
  const y = SIZE * 0.1;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = "#1d1d1f";
  ctx.fillRect(x - 26, y - 26, w + 52, h + 52);
  ctx.restore();
  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(x - 12, y - 12, w + 24, h + 24);
  drawInto(ctx, design, x, y, w, h);
}

function mug(ctx: Ctx, design: Canvas): void {
  backdrop(ctx, "#f4f1ec", "#dcd6cc");
  shadow(ctx, 560, 930, 330, 50);
  const x = 300;
  const y = 330;
  const w = 520;
  const h = 600;
  // Handle.
  ctx.strokeStyle = "#f2f2f2";
  ctx.lineWidth = 58;
  ctx.beginPath();
  ctx.ellipse(x + w + 20, y + h * 0.48, 120, 165, 0, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.strokeStyle = "#d9d9d9";
  ctx.lineWidth = 6;
  ctx.stroke();
  // Body with soft shading.
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, "#d9d9d9");
  g.addColorStop(0.18, "#ffffff");
  g.addColorStop(0.75, "#f7f7f7");
  g.addColorStop(1, "#cfcfcf");
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, 40);
  ctx.fill();
  // The front half of the wrap faces the camera.
  const visible = Math.min(design.width, design.height * (w / (h * 0.86)));
  const sx = (design.width - visible) / 2;
  drawInto(ctx, design, x + 30, y + 40, w - 60, h - 80, [sx, 0, visible, design.height]);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x + w * 0.12, y + 20, 26, h - 40);
}

function candle(ctx: Ctx, design: Canvas): void {
  backdrop(ctx, "#f3eee7", "#ddd3c6");
  shadow(ctx, 600, 960, 300, 46);
  const x = 340;
  const y = 330;
  const w = 520;
  const h = 620;
  // Lid.
  ctx.fillStyle = "#2b2b2e";
  roundRect(ctx, x - 6, y - 70, w + 12, 80, 18);
  ctx.fill();
  // Glass jar with wax inside.
  ctx.fillStyle = "rgba(235,240,243,0.92)";
  roundRect(ctx, x, y, w, h, 46);
  ctx.fill();
  ctx.fillStyle = "#f6efe2";
  roundRect(ctx, x + 18, y + 40, w - 36, h - 60, 34);
  ctx.fill();
  // Label with the design.
  const lw = w * 0.82;
  const lh = lw * (design.height / design.width);
  const lx = x + (w - lw) / 2;
  const ly = y + (h - lh) / 2 + 20;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, lx - 8, ly - 8, lw + 16, lh + 16, 10);
  ctx.fill();
  drawInto(ctx, design, lx, ly, lw, lh);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(x + 36, y + 30, 22, h - 70);
}

function tote(ctx: Ctx, design: Canvas): void {
  backdrop(ctx, "#eef0f2", "#d5d9de");
  ctx.strokeStyle = "#e6dcc6";
  ctx.lineWidth = 34;
  for (const cx of [470, 730]) {
    ctx.beginPath();
    ctx.ellipse(cx, 330, 90, 210, 0, Math.PI, 0);
    ctx.stroke();
  }
  ctx.fillStyle = "#efe6d2";
  ctx.beginPath();
  ctx.moveTo(300, 320);
  ctx.lineTo(900, 320);
  ctx.lineTo(930, 1080);
  ctx.lineTo(270, 1080);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = 3;
  ctx.stroke();
  drawInto(ctx, design, 380, 470, 440, 470);
}

function tshirt(ctx: Ctx, design: Canvas): void {
  backdrop(ctx, "#eceff3", "#d3d8df");
  ctx.fillStyle = "#fafafa";
  ctx.beginPath();
  ctx.moveTo(420, 170);
  ctx.quadraticCurveTo(600, 250, 780, 170);
  ctx.lineTo(1010, 290);
  ctx.lineTo(930, 470);
  ctx.lineTo(850, 430);
  ctx.lineTo(850, 1080);
  ctx.lineTo(350, 1080);
  ctx.lineTo(350, 430);
  ctx.lineTo(270, 470);
  ctx.lineTo(190, 290);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.1)";
  ctx.lineWidth = 3;
  ctx.stroke();
  drawInto(ctx, design, 430, 330, 340, 400);
}

const DRAW: Record<MockupKind, (ctx: Ctx, design: Canvas) => void> = {
  frame,
  mug,
  candle,
  tote,
  tshirt,
};

/** The product mockup: the print file on the product. */
export function productMockup(kind: MockupKind, design: Canvas): Canvas {
  const canvas = createCanvas(SIZE, SIZE);
  DRAW[kind](canvas.getContext("2d"), design);
  return canvas;
}

/** The design on its own, with the print file's facts (what the print partner receives). */
export function detailMockup(design: Canvas, product: Product, caption: string): Canvas {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  backdrop(ctx, "#ffffff", "#f0f0f0");
  // A light checkerboard shows which areas are transparent (not printed).
  const box = { x: 100, y: 90, w: 1000, h: 900 };
  const scale = Math.min(box.w / design.width, box.h / design.height);
  const dw = design.width * scale;
  const dh = design.height * scale;
  const dx = box.x + (box.w - dw) / 2;
  const dy = box.y + (box.h - dh) / 2;
  for (let yy = 0; yy < dh; yy += 24) {
    for (let xx = 0; xx < dw; xx += 24) {
      ctx.fillStyle = (Math.floor(xx / 24) + Math.floor(yy / 24)) % 2 === 0 ? "#f3f3f3" : "#e6e6e6";
      ctx.fillRect(dx + xx, dy + yy, Math.min(24, dw - xx), Math.min(24, dh - yy));
    }
  }
  drawInto(ctx, design, dx, dy, dw, dh);
  ctx.strokeStyle = "#bbbbbb";
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 2;
  ctx.strokeRect(dx, dy, dw, dh);
  ctx.setLineDash([]);
  ctx.fillStyle = "#555555";
  ctx.font = `28px "${pickFont(["Segoe UI", "Arial", "DejaVu Sans"])}"`;
  ctx.textAlign = "center";
  ctx.fillText(caption, SIZE / 2, 1060);
  ctx.font = `22px "${pickFont(["Segoe UI", "Arial", "DejaVu Sans"])}"`;
  ctx.fillText(
    `${product.title} · print area ${product.printArea[0]}×${product.printArea[1]} px at ${product.dpi} dpi`,
    SIZE / 2,
    1110,
  );
  return canvas;
}
