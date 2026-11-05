import fs from "node:fs";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { Theme } from "./timeline";

/**
 * The video's thumbnail (Stage 16): its strongest frame with the script's thumbnail text, set big
 * with a heavy outline so it reads at phone size. 1280×720 for long-form, 1080×1920 for shorts.
 */

function wrap(g: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function makeThumbnail(opts: {
  frame: string;
  out: string;
  text: string;
  format: "short" | "long";
  theme: Theme;
}): Promise<void> {
  const [W, H] = opts.format === "long" ? [1280, 720] : [1080, 1920];
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  const img = await loadImage(fs.readFileSync(opts.frame));
  const scale = Math.max(W / img.width, H / img.height);
  g.drawImage(
    img,
    (W - img.width * scale) / 2,
    (H - img.height * scale) / 2,
    img.width * scale,
    img.height * scale,
  );
  const shade = g.createLinearGradient(
    0,
    0,
    opts.format === "long" ? W : 0,
    opts.format === "long" ? 0 : H,
  );
  shade.addColorStop(0, "rgba(0,0,0,0.7)");
  shade.addColorStop(0.6, "rgba(0,0,0,0.15)");
  shade.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);
  const text = opts.text.toUpperCase();
  let size = opts.format === "long" ? 118 : 132;
  const maxWidth = opts.format === "long" ? W * 0.62 : W * 0.86;
  let lines: string[] = [];
  for (; size > 48; size -= 6) {
    g.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    lines = wrap(g, text, maxWidth);
    if (lines.length <= 3) break;
  }
  const lineH = size * 1.02;
  const top =
    opts.format === "long" ? (H - lines.length * lineH) / 2 + size * 0.8 : H * 0.18 + size;
  const left = opts.format === "long" ? W * 0.06 : W * 0.07;
  g.lineJoin = "round";
  lines.forEach((l, i) => {
    const y = top + i * lineH;
    g.lineWidth = size * 0.16;
    g.strokeStyle = "#000";
    g.strokeText(l, left, y);
    g.fillStyle = i === lines.length - 1 ? opts.theme.accent : opts.theme.ink;
    g.fillText(l, left, y);
  });
  fs.writeFileSync(opts.out, c.toBuffer("image/png"));
}
