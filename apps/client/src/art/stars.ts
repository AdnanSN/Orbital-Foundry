import { hash2 } from "./pen";

/** Tileable starfield textures, drawn once. `layer` 0 is far and dim, 1 is near and bright. */
export function paintStars(ctx: CanvasRenderingContext2D, size: number, layer: 0 | 1): void {
  ctx.clearRect(0, 0, size, size);
  if (layer === 0) {
    // A faint nebula wash under the far stars.
    for (let i = 0; i < 3; i++) {
      const x = hash2(i, 1, 40) * size;
      const y = hash2(i, 2, 40) * size;
      const r = size * (0.25 + hash2(i, 3, 40) * 0.2);
      for (const [dx, dy] of [
        [0, 0],
        [size, 0],
        [-size, 0],
        [0, size],
        [0, -size],
      ] as const) {
        const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        const hue = [
          "rgba(90, 60, 160, 0.10)",
          "rgba(40, 90, 170, 0.08)",
          "rgba(150, 50, 120, 0.07)",
        ][i];
        g.addColorStop(0, hue as string);
        g.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    }
  }
  const count = layer === 0 ? 260 : 70;
  for (let i = 0; i < count; i++) {
    const x = Math.floor(hash2(i, layer, 1) * size);
    const y = Math.floor(hash2(i, layer, 2) * size);
    const b = hash2(i, layer, 3);
    const tint = hash2(i, layer, 4);
    const color =
      tint < 0.15 ? "#9fc7ff" : tint < 0.25 ? "#ffd9a8" : tint < 0.3 ? "#ffb3d1" : "#ffffff";
    ctx.globalAlpha = layer === 0 ? 0.25 + b * 0.45 : 0.55 + b * 0.45;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
    if (layer === 1 && b > 0.86) {
      // A few bright stars with a small cross glint.
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x, y + 1, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}
