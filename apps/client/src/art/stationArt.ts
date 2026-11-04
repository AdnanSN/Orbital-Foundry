import type { StationMap, TileKind } from "@orbital/shared";
import { shade, withAlpha } from "./color";
import { drawText, measureText } from "./font";
import { paintObject } from "./furniture";
import { hash2, Pen } from "./pen";
import { CORRIDOR_THEME, MAT, type Theme, themeFor } from "./themes";

/**
 * Paints the static station: floors, walls, windows, door frames, furniture and floor labels.
 * Void and window glass stay transparent so the starfield behind shows through. Animated parts
 * (screens, racks, doors, holograms) are separate sprites layered on top by the scene.
 */

const T = 16;
const WALKABLE: ReadonlySet<TileKind> = new Set(["floor", "corridor", "door"]);

export function paintStation(ctx: CanvasRenderingContext2D, map: StationMap): void {
  const pen = new Pen(ctx);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const kind = map.kindAt(x, y);
      if (kind === "void") continue;
      if (WALKABLE.has(kind)) paintFloor(pen.at(x * T, y * T), map, x, y);
    }
  }
  paintRoomLight(ctx, map);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const kind = map.kindAt(x, y);
      if (kind === "wall" || kind === "window") paintWall(pen.at(x * T, y * T), map, x, y);
    }
  }
  paintShadows(pen, map);
  paintDoorFrames(pen, map);
  paintLabels(pen, map);
  for (const o of map.objects) {
    const theme = themeFor(map.room(o.room).theme);
    if (!o.wall) paintObjectShadow(pen, o.x, o.y, o.w, o.h);
    paintObject(pen.at(o.x * T, o.y * T), o, theme);
  }
}

function themeAt(map: StationMap, x: number, y: number): Theme {
  if (map.kindAt(x, y) === "corridor") return CORRIDOR_THEME;
  const room = map.roomAt(x, y);
  return room ? themeFor(room.theme) : CORRIDOR_THEME;
}

function paintFloor(p: Pen, map: StationMap, x: number, y: number): void {
  const th = themeAt(map, x, y);
  const kind = map.kindAt(x, y);
  const pattern = kind === "door" ? "plate" : th.floor;
  p.rect(0, 0, T, T, th.base);
  switch (pattern) {
    case "plate": {
      p.hline(0, 0, T, th.light).vline(0, 0, T, th.light);
      p.hline(0, T - 1, T, th.seam).vline(T - 1, 0, T, th.seam);
      if (hash2(x, y) < 0.35) {
        for (const [rx, ry] of [
          [2, 2],
          [13, 2],
          [2, 13],
          [13, 13],
        ] as const)
          p.px(rx, ry, th.seam);
      }
      if (hash2(x, y, 3) < 0.12) p.rect(5, 5, 6, 6, shade(th.base, -0.06));
      break;
    }
    case "grate": {
      for (let i = 0; i < T; i++) {
        for (let j = 0; j < T; j++) {
          if (i % 4 === 3 || j % 4 === 3) p.px(i, j, th.seam);
          else if (hash2(x * T + i, y * T + j) < 0.04) p.px(i, j, th.light);
        }
      }
      break;
    }
    case "carpet": {
      for (let i = 0; i < T; i++) {
        for (let j = 0; j < T; j++) {
          const n = hash2(x * T + i, y * T + j, 7);
          if (n < 0.07) p.px(i, j, th.light);
          else if (n < 0.13) p.px(i, j, th.seam);
        }
      }
      break;
    }
    case "wood": {
      for (let row = 0; row < 4; row++) {
        const tone = hash2(x, y * 4 + row, 5);
        const c = tone < 0.33 ? th.light : tone < 0.66 ? th.base : shade(th.base, -0.08);
        p.rect(0, row * 4, T, 3, c);
        p.hline(0, row * 4 + 3, T, th.seam);
        const cut = Math.floor(hash2(x, y * 4 + row, 9) * T);
        if (hash2(x, y * 4 + row, 11) < 0.5) p.vline(cut, row * 4, 3, th.seam);
      }
      break;
    }
    case "check": {
      for (let i = 0; i < T; i++) {
        for (let j = 0; j < T; j++) {
          const on = (Math.floor((x * T + i) / 8) + Math.floor((y * T + j) / 8)) % 2 === 0;
          if (on) p.px(i, j, th.light);
        }
      }
      p.hline(0, T - 1, T, th.seam).vline(T - 1, 0, T, th.seam);
      break;
    }
    case "hazard": {
      p.hline(0, 0, T, th.light).vline(0, 0, T, th.light);
      p.hline(0, T - 1, T, th.seam).vline(T - 1, 0, T, th.seam);
      const room = map.roomAt(x, y);
      if (room) {
        const edge =
          x === room.x + 1 ||
          x === room.x + room.w - 2 ||
          y === room.y + 1 ||
          y === room.y + room.h - 2;
        if (edge) hazardStripes(p, 0, 0, T, T, th.accent);
      }
      break;
    }
  }
  if (kind === "corridor") {
    // Guide lights along the walls of corridors.
    for (const [dx, dy, lx, ly] of [
      [0, -1, 7, 1],
      [0, 1, 7, 14],
      [-1, 0, 1, 7],
      [1, 0, 14, 7],
    ] as const) {
      const n = map.kindAt(x + dx, y + dy);
      if ((n === "wall" || n === "window") && (x + y) % 2 === 0) {
        p.rect(lx, ly, dx === 0 ? 2 : 1, dx === 0 ? 1 : 2, withAlpha(CORRIDOR_THEME.accent, 0.8));
      }
    }
  }
}

function hazardStripes(p: Pen, x: number, y: number, w: number, h: number, color: string): void {
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      if ((i + j) % 6 < 3) p.px(x + i, y + j, withAlpha(color, 0.38));
    }
  }
}

/** Soft light in the middle of each room, darker towards the walls. */
function paintRoomLight(ctx: CanvasRenderingContext2D, map: StationMap): void {
  for (const r of map.rooms) {
    const x = (r.x + 1) * T;
    const y = (r.y + 1) * T;
    const w = (r.w - 2) * T;
    const h = (r.h - 2) * T;
    const g = ctx.createRadialGradient(
      x + w / 2,
      y + h / 2,
      Math.min(w, h) * 0.15,
      x + w / 2,
      y + h / 2,
      Math.max(w, h) * 0.7,
    );
    g.addColorStop(0, "rgba(255, 244, 220, 0.07)");
    g.addColorStop(1, "rgba(5, 4, 20, 0.22)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
}

function isWallish(kind: TileKind): boolean {
  return kind === "wall" || kind === "window";
}

/** A wall with open floor to its south shows its front face; others show only their top. */
function paintWall(p: Pen, map: StationMap, x: number, y: number): void {
  const south = map.kindAt(x, y + 1);
  const face = WALKABLE.has(south);
  const window = map.kindAt(x, y) === "window";
  const below = face ? themeAt(map, x, y + 1) : undefined;

  if (!face) {
    p.rect(0, 0, T, T, MAT.cap);
    // Bevel towards floors, rim towards space.
    const edges: [number, number, (q: Pen) => void][] = [
      [0, -1, (q) => q.hline(0, 0, T, MAT.capEdge)],
      [-1, 0, (q) => q.vline(0, 0, T, MAT.capEdge)],
      [1, 0, (q) => q.vline(T - 1, 0, T, MAT.capEdge)],
    ];
    for (const [dx, dy, draw] of edges) {
      const n = map.kindAt(x + dx, y + dy);
      if (WALKABLE.has(n) || n === "void") draw(p);
    }
    if (map.kindAt(x, y + 1) === "void")
      p.hline(0, T - 2, T, MAT.hull).hline(0, T - 1, T, MAT.outline);
    if (window) {
      p.rect(2, 5, 12, 6, MAT.metal);
      p.clear(3, 6, 10, 4);
      p.rect(3, 6, 10, 4, MAT.glass);
      p.hline(4, 6, 3, MAT.glassShine);
    }
    return;
  }

  // Front-facing wall: a 4px cap, then a 12px panelled face.
  p.rect(0, 0, T, 4, MAT.cap);
  p.hline(0, 3, T, MAT.capEdge);
  const westOpen = !isWallish(map.kindAt(x - 1, y));
  const eastOpen = !isWallish(map.kindAt(x + 1, y));
  if (map.kindAt(x, y - 1) === "void") p.hline(0, 0, T, MAT.hull);
  if (window) {
    p.rect(0, 4, T, 12, MAT.faceDark);
    p.rect(0, 4, T, 1, MAT.faceLight);
    p.clear(1, 5, 14, 8);
    p.rect(1, 5, 14, 8, MAT.glass);
    // Mullions between panes and a diagonal glint.
    if (!isWindowAt(map, x - 1, y)) p.vline(0, 5, 8, MAT.faceLight);
    if (!isWindowAt(map, x + 1, y)) p.vline(T - 1, 5, 8, MAT.faceDark);
    p.vline(0, 5, 8, MAT.faceDark);
    for (let i = 0; i < 4; i++) p.px(3 + i, 11 - i, MAT.glassShine);
    p.rect(0, 13, T, 3, MAT.faceDark);
    p.hline(0, 13, T, MAT.faceLight);
    p.hline(0, 15, T, MAT.base);
  } else {
    p.rect(0, 4, T, 12, MAT.face);
    p.hline(0, 4, T, MAT.faceLight);
    p.vline(7, 5, 6, MAT.faceDark);
    const trim = below ? shade(below.accent, -0.35) : MAT.faceDark;
    p.rect(0, 11, T, 2, trim);
    p.rect(0, 13, T, 3, MAT.faceDark);
    p.hline(0, 15, T, MAT.base);
    const n = hash2(x, y, 21);
    if (n < 0.18) {
      // A little wall light.
      p.rect(3, 6, 3, 2, withAlpha(below?.accent ?? "#ffffff", 0.85));
    } else if (n < 0.3) {
      // A vent.
      p.rect(9, 6, 5, 4, MAT.faceDark);
      p.hline(10, 7, 3, MAT.base).hline(10, 9, 3, MAT.base);
    }
  }
  if (westOpen) p.vline(0, 4, 12, MAT.faceLight);
  if (eastOpen) p.vline(T - 1, 4, 12, MAT.faceDark);
}

function isWindowAt(map: StationMap, x: number, y: number): boolean {
  return map.kindAt(x, y) === "window";
}

/** Dark gradients under north walls and beside west walls give the rooms depth. */
function paintShadows(p: Pen, map: StationMap): void {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!WALKABLE.has(map.kindAt(x, y))) continue;
      const q = p.at(x * T, y * T);
      if (isWallish(map.kindAt(x, y - 1))) {
        q.hline(0, 0, T, "rgba(4, 3, 14, 0.38)");
        q.hline(0, 1, T, "rgba(4, 3, 14, 0.22)");
        q.hline(0, 2, T, "rgba(4, 3, 14, 0.1)");
      }
      if (isWallish(map.kindAt(x - 1, y))) q.vline(0, 0, T, "rgba(4, 3, 14, 0.18)");
    }
  }
}

/** Static door parts: a threshold and the frame posts. The sliding panels are sprites. */
function paintDoorFrames(p: Pen, map: StationMap): void {
  for (const d of map.doorways()) {
    const q = p.at(d.x * T, d.y * T);
    if (d.orientation === "horizontal") {
      const w = d.w * T;
      q.rect(0, 6, w, 4, MAT.metalDark);
      q.hline(0, 6, w, MAT.metal);
      hazardStripes(q, 0, 7, w, 2, "#ffd23f");
      q.rect(-2, 0, 2, T, MAT.metalLight).rect(w, 0, 2, T, MAT.metalLight);
      q.vline(-2, 0, T, MAT.outline).vline(w + 1, 0, T, MAT.outline);
    } else {
      const h = d.h * T;
      q.rect(6, 0, 4, h, MAT.metalDark);
      q.vline(6, 0, h, MAT.metal);
      hazardStripes(q, 7, 0, 2, h, "#ffd23f");
      q.rect(0, -2, T, 2, MAT.metalLight).rect(0, h, T, 2, MAT.metalLight);
      q.hline(0, -2, T, MAT.outline).hline(0, h + 1, T, MAT.outline);
    }
  }
}

function paintObjectShadow(p: Pen, x: number, y: number, w: number, h: number): void {
  const q = p.at(x * T, (y + h) * T);
  q.rect(1, 0, w * T - 1, 2, "rgba(4, 3, 14, 0.3)");
  q.rect(2, 2, w * T - 3, 1, "rgba(4, 3, 14, 0.12)");
}

function paintLabels(p: Pen, map: StationMap): void {
  for (const r of map.rooms) {
    const th = themeFor(r.theme);
    const scale = 2;
    const width = measureText(r.label) * scale;
    const cx = (r.x + r.w / 2) * T;
    const y = (r.y + r.h - 2) * T + 3;
    drawText(p.ctx, r.label, Math.round(cx - width / 2), y, withAlpha(th.accent, 0.42), scale);
    if (r.sublabel) {
      const sw = measureText(r.sublabel);
      drawText(p.ctx, r.sublabel, Math.round(cx - sw / 2), y - 8, withAlpha(th.accent, 0.5), 1);
    }
  }
  for (const l of map.labels) {
    const room = map.roomAt(l.x, l.y);
    const th = themeFor(room?.theme);
    const width = measureText(l.text);
    const x = Math.round((l.x + l.w / 2) * T - width / 2);
    drawText(p.ctx, l.text, x, l.y * T + 6, withAlpha(th.accent, 0.62), 1);
  }
}
