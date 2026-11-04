import type { StationObject } from "@orbital/shared";
import { shade, withAlpha } from "./color";
import { hash2, type Pen } from "./pen";
import { MAT, type Theme } from "./themes";

/**
 * Static furniture, drawn into the station background. Each painter draws inside the object's
 * footprint (w×h tiles) with its pen at the footprint's top-left. Screens, LEDs and other moving
 * parts are left dark here and animated by sprites (see fx.ts and SCREEN_SLOTS).
 */

const T = 16;
type Painter = (p: Pen, o: StationObject, th: Theme) => void;

/** Where animated screens sit on each kind, relative to the object's top-left (px). */
export const SCREEN_SLOTS: Record<string, { x: number; y: number }[]> = {
  desk: [{ x: 3, y: 1 }],
  deskwide: [
    { x: 3, y: 1 },
    { x: 19, y: 1 },
  ],
  console: [{ x: 3, y: 1 }],
  bench: [{ x: 3, y: 1 }],
  execdesk: [{ x: 27, y: 15 }],
};

function monitor(p: Pen, x: number, y: number): void {
  p.box(x, y, 12, 9, MAT.metalDark, MAT.outline);
  p.rect(x + 1, y + 1, 10, 7, MAT.screen);
  p.rect(x + 5, y + 9, 2, 2, MAT.metal);
}

function deskBody(p: Pen, w: number): void {
  p.rect(0, 9, w, 4, MAT.metalLight);
  p.hline(0, 9, w, MAT.steel);
  p.rect(0, 13, w, 3, MAT.metal);
  p.hline(0, 15, w, MAT.outline);
  p.vline(0, 9, 7, MAT.outline).vline(w - 1, 9, 7, MAT.outline);
}

function keyboard(p: Pen, x: number): void {
  p.rect(x, 11, 10, 2, MAT.metalDark);
  for (let i = 0; i < 5; i++) p.px(x + 1 + i * 2, 11, MAT.steel);
}

function deskItem(p: Pen, variant: string | undefined, th: Theme): void {
  switch (variant) {
    case "candles":
      p.box(4, 4, 7, 7, "#e9dcc4", MAT.outline);
      p.rect(5, 6, 5, 2, th.accent);
      p.vline(7, 2, 2, MAT.outline);
      p.px(7, 1, "#ffcf5a").px(7, 0, "#fff3b0");
      break;
    case "gifts":
      p.box(3, 4, 9, 7, "#c9487a", MAT.outline);
      p.vline(7, 4, 7, "#7fe0c2");
      p.hline(3, 7, 9, "#7fe0c2");
      p.px(6, 3, "#7fe0c2").px(8, 3, "#7fe0c2");
      break;
    case "wallart":
      p.box(2, 1, 11, 9, "#d8c08a", MAT.outline);
      p.rect(3, 2, 9, 7, "#2a2f55");
      p.disc(9, 4, 1, "#ffd166");
      p.hline(3, 7, 9, "#5c4d8a").hline(4, 6, 4, "#5c4d8a");
      break;
    default:
      p.box(2, 5, 8, 6, MAT.white, MAT.outline);
      p.hline(3, 7, 5, "#b9c2d6").hline(3, 9, 4, "#b9c2d6");
      p.box(11, 6, 4, 4, "#d9e1ee", MAT.outline);
      p.px(12, 7, "#6b4a32");
  }
}

const PAINTERS: Record<string, Painter> = {
  desk: (p, o, th) => {
    deskBody(p, o.w * T);
    monitor(p, 2, 0);
    keyboard(p, 3);
    deskItem(p.at(16, 0), o.variant, th);
  },
  deskwide: (p, o) => {
    deskBody(p, o.w * T);
    monitor(p, 2, 0);
    monitor(p, 18, 0);
    keyboard(p, 3);
    keyboard(p, 19);
    p.box(34, 6, 12, 6, MAT.metalDark, MAT.outline);
    p.rect(35, 7, 10, 4, "#2b3550");
    p.vline(43, 4, 4, MAT.steel);
  },
  console: (p) => {
    p.box(4, 8, 8, 8, MAT.metal, MAT.outline);
    p.hline(5, 9, 6, MAT.metalLight);
    monitor(p, 2, 0);
  },
  bench: (p, o) => {
    deskBody(p, o.w * T);
    monitor(p, 2, 0);
    // Tools on the right half.
    p.rect(19, 9, 9, 2, MAT.steel);
    p.rect(27, 7, 2, 4, MAT.metalDark);
    p.box(20, 3, 6, 6, "#a8452f", MAT.outline);
    p.rect(21, 4, 4, 2, "#ff9f6b");
  },
  holotable: (p, o, th) => {
    const w = o.w * T;
    const h = o.h * T;
    p.rect(2, h - 12, w - 4, 10, MAT.metal);
    p.hline(2, h - 12, w - 4, MAT.metalLight);
    p.rect(2, h - 4, w - 4, 3, MAT.metalDark);
    p.hline(2, h - 1, w - 4, MAT.outline);
    p.vline(1, h - 12, 12, MAT.outline).vline(w - 2, h - 12, 12, MAT.outline);
    p.rect(6, h - 10, w - 12, 5, shade(th.accent, -0.55));
    p.hline(6, h - 10, w - 12, withAlpha(th.accent, 0.8));
    p.rect(w / 2 - 3, h - 9, 6, 3, withAlpha(th.accent, 0.9));
  },
  shelf: (p, o) => {
    const w = o.w * T;
    p.box(1, 0, w - 2, 15, MAT.metalDark, MAT.outline);
    for (const sy of [5, 10]) p.hline(2, sy, w - 4, MAT.metalLight);
    const colors = ["#c9487a", "#5ff2d0", "#ffd166", "#7a55c7", "#ff9f43", "#6fa8ff"];
    for (let row = 0; row < 3; row++) {
      let x = 3;
      while (x < w - 4) {
        const n = hash2(o.x * 7 + x, o.y * 5 + row, 3);
        const bw = 2 + Math.floor(n * 3);
        const bh = 3 + Math.floor(hash2(x, row, 1) * 2);
        if (x + bw > w - 3) break;
        p.rect(x, 1 + row * 5 + (4 - bh), bw, bh, colors[Math.floor(n * colors.length)] as string);
        x += bw + 1;
      }
    }
  },
  databank: (p) => {
    p.box(2, 0, 12, 32, MAT.metalDark, MAT.outline);
    p.hline(3, 1, 10, MAT.metalLight);
    for (let i = 0; i < 6; i++) p.rect(4, 4 + i * 4, 8, 2, MAT.screen);
  },
  rack: (p) => {
    p.box(1, 0, 14, 32, "#1a1e29", MAT.outline);
    p.hline(2, 1, 12, MAT.metal);
    p.rect(3, 3, 10, 26, MAT.screen);
    for (let i = 0; i < 8; i++) p.hline(3, 5 + i * 3, 10, "#222838");
    p.rect(2, 29, 12, 2, MAT.metalDark);
  },
  plant: (p, o) => {
    p.box(5, 10, 6, 6, MAT.pot, MAT.outline);
    p.hline(6, 11, 4, shade(MAT.pot, 0.2));
    const leaves: [number, number, string][] = [
      [7, 2, MAT.leafLight],
      [5, 4, MAT.leaf],
      [9, 3, MAT.leaf],
      [3, 6, MAT.leafDark],
      [11, 6, MAT.leafDark],
      [7, 6, MAT.leaf],
      [5, 8, MAT.leafDark],
      [9, 8, MAT.leaf],
    ];
    const flip = hash2(o.x, o.y) < 0.5;
    for (const [lx, ly, c] of leaves) {
      const x = flip ? 15 - lx - 2 : lx;
      p.rect(x, ly, 3, 2, c);
      p.px(x + 1, ly - 1, c);
    }
    p.vline(7, 5, 5, MAT.leafDark).vline(8, 4, 6, MAT.leafDark);
  },
  crates: (p, o) => {
    if (o.variant === "bin") {
      p.box(3, 5, 10, 11, "#3a4a52", MAT.outline);
      p.hline(3, 5, 10, "#56707a");
      p.rect(5, 8, 6, 1, "#8affc1");
      return;
    }
    if (o.variant === "gold") {
      for (const [bx, by] of [
        [1, 10],
        [8, 10],
        [4, 5],
      ] as const) {
        p.box(bx, by, 7, 5, MAT.gold, MAT.outline);
        p.hline(bx + 1, by + 1, 5, "#ffe58a");
      }
      return;
    }
    p.box(1, 3, 14, 13, MAT.wood, MAT.outline);
    p.hline(2, 4, 12, MAT.woodLight);
    p.hline(2, 9, 12, MAT.woodDark);
    p.vline(2, 4, 11, MAT.woodDark).vline(13, 4, 11, MAT.woodDark);
    for (let i = 0; i < 10; i++) p.px(3 + i, 4 + i, MAT.woodDark);
  },
  press: (p, o, th) => {
    const w = o.w * T;
    p.box(0, 4, w, 28, MAT.metal, MAT.outline);
    p.hline(1, 5, w - 2, MAT.metalLight);
    p.box(4, 8, w - 8, 10, "#f1ede4", MAT.outline);
    p.rect(8, 10, 12, 5, th.accent);
    p.rect(22, 11, 12, 3, "#7a55c7");
    p.rect(2, 20, w - 4, 4, MAT.metalDark);
    for (let i = 0; i < 6; i++) p.vline(4 + i * 7, 20, 4, MAT.steel);
    p.box(w - 12, 25, 9, 5, MAT.screen, MAT.outline);
    p.px(w - 10, 27, "#69cf74").px(w - 7, 27, th.accent);
  },
  table: (p, o) => {
    const w = o.w * T;
    p.rect(1, 4, w - 2, 7, MAT.woodLight);
    p.hline(1, 4, w - 2, shade(MAT.woodLight, 0.2));
    p.rect(1, 11, w - 2, 3, MAT.wood);
    p.hline(1, 14, w - 2, MAT.outline);
    p.vline(0, 4, 11, MAT.outline).vline(w - 1, 4, 11, MAT.outline);
    if (o.variant === "coins") {
      for (const [cx, cy, n] of [
        [7, 8, 3],
        [14, 7, 4],
        [22, 8, 2],
      ] as const) {
        for (let i = 0; i < n; i++) p.rect(cx - 2, cy - i, 5, 1, i % 2 ? MAT.goldDark : MAT.gold);
      }
    } else {
      p.box(6, 5, 8, 5, "#c9a26b", MAT.outline);
      p.box(17, 6, 9, 4, "#e9edf5", MAT.outline);
    }
  },
  counter: (p) => counterBody(p),
  coffee: (p) => {
    counterBody(p);
    p.box(3, 0, 10, 10, "#b8323a", MAT.outline);
    p.rect(4, 1, 8, 2, "#e04a52");
    p.rect(5, 5, 6, 4, MAT.outline);
    p.rect(7, 7, 2, 2, MAT.white);
    p.px(10, 2, "#69cf74");
  },
  cafetable: (p) => {
    p.rect(7, 9, 2, 6, MAT.metalDark);
    p.rect(5, 14, 6, 2, MAT.metal);
    p.pill(2, 3, 12, 7, MAT.woodLight, MAT.outline);
    p.hline(4, 4, 8, shade(MAT.woodLight, 0.2));
    p.box(6, 4, 4, 3, MAT.white, MAT.outline);
    p.px(7, 4, "#7a4a2a").px(8, 4, "#7a4a2a");
  },
  vending: (p) => {
    p.box(1, 0, 14, 16, "#2f6fd1", MAT.outline);
    p.rect(3, 2, 7, 10, "#0d1822");
    for (let i = 0; i < 3; i++) {
      p.rect(4, 3 + i * 3, 2, 2, ["#ff5fa2", "#ffd166", "#5ff2d0"][i] as string);
      p.rect(7, 3 + i * 3, 2, 2, ["#69cf74", "#ff9f43", "#c9487a"][i] as string);
    }
    p.rect(11, 3, 2, 2, "#ffd166");
    p.rect(11, 6, 2, 1, MAT.steel);
    p.rect(3, 13, 10, 2, MAT.outline);
  },
  sofa: (p, o) => {
    const w = o.w * T;
    p.box(0, 2, w, 8, "#6b3fa0", MAT.outline);
    p.box(0, 8, w, 7, "#7d4fb5", MAT.outline);
    for (let i = 1; i < o.w; i++) p.vline(i * T, 9, 5, "#5a3388");
    p.box(0, 4, 4, 11, "#5a3388", MAT.outline);
    p.box(w - 4, 4, 4, 11, "#5a3388", MAT.outline);
  },
  execdesk: (p, o, th) => {
    const w = o.w * T;
    // Chair behind the desk.
    p.box(w / 2 - 7, 0, 14, 12, "#5b2c4a", MAT.outline);
    p.rect(w / 2 - 5, 2, 10, 2, "#7b3c62");
    // Desk.
    p.rect(0, 12, w, 12, MAT.woodLight);
    p.hline(0, 12, w, shade(MAT.woodLight, 0.25));
    p.rect(0, 24, w, 8, MAT.wood);
    p.hline(0, 31, w, MAT.outline);
    p.vline(0, 12, 20, MAT.outline).vline(w - 1, 12, 20, MAT.outline);
    // Inbox tray, nameplate and a monitor.
    p.box(4, 14, 14, 7, MAT.metalDark, MAT.outline);
    p.rect(6, 15, 10, 2, "#f3efe8");
    p.rect(6, 17, 10, 2, "#e3dccb");
    monitor(p, 26, 14);
    p.box(w / 2 - 8, 26, 16, 5, MAT.gold, MAT.outline);
    p.hline(w / 2 - 6, 28, 12, shade(th.accent, -0.2));
  },
  safe: (p, o) => {
    const w = o.w * T;
    p.box(0, 0, w, 32, MAT.metal, MAT.outline);
    p.hline(1, 1, w - 2, MAT.metalLight);
    p.disc(w / 2, 15, 12, MAT.outline);
    p.disc(w / 2, 15, 11, MAT.steel);
    p.disc(w / 2, 15, 9, MAT.metalLight);
    p.disc(w / 2, 15, 3, MAT.metalDark);
    for (const [dx, dy] of [
      [0, -6],
      [0, 6],
      [-6, 0],
      [6, 0],
    ] as const)
      p.rect(w / 2 + dx - 1, 15 + dy - 1, 2, 2, MAT.metalDark);
    for (const [bx, by] of [
      [4, 4],
      [w - 6, 4],
      [4, 26],
      [w - 6, 26],
    ] as const)
      p.rect(bx, by, 2, 2, MAT.gold);
  },
  coins: (p) => {
    for (const [cx, cy] of [
      [5, 12],
      [10, 12],
      [8, 9],
      [4, 8],
      [11, 7],
      [7, 5],
    ] as const) {
      p.rect(cx - 2, cy, 5, 2, MAT.outline);
      p.rect(cx - 2, cy - 1, 5, 2, MAT.gold);
      p.px(cx - 1, cy - 1, "#ffe58a");
    }
  },
  forge: (p, o) => {
    const w = o.w * T;
    p.box(1, 2, w - 2, 30, "#4a3a33", MAT.outline);
    p.rect(3, 4, w - 6, 3, "#5e4a41");
    p.box(6, 12, w - 12, 12, "#1a1210", MAT.outline);
    p.rect(2, 26, w - 4, 4, "#33261f");
    p.rect(12, 0, 8, 3, "#33261f");
  },
  scanner: (p, o, th) => {
    const w = o.w * T;
    p.rect(2, 26, w - 4, 5, MAT.metalDark);
    p.hline(2, 26, w - 4, MAT.metalLight);
    p.rect(4, 27, w - 8, 3, shade(th.accent, -0.5));
    p.box(1, 2, 4, 26, MAT.metal, MAT.outline);
    p.box(w - 5, 2, 4, 26, MAT.metal, MAT.outline);
    p.box(1, 0, w - 2, 5, MAT.metalLight, MAT.outline);
    p.rect(5, 2, w - 10, 1, th.accent);
  },
  intake: (p, o, th) => {
    const w = o.w * T;
    p.rect(0, 6, w, 7, MAT.metalLight);
    p.hline(0, 6, w, MAT.steel);
    p.rect(0, 13, w, 3, MAT.metal);
    p.hline(0, 15, w, MAT.outline);
    p.vline(0, 6, 10, MAT.outline).vline(w - 1, 6, 10, MAT.outline);
    for (let i = 0; i < w; i += 4) p.rect(i, 13, 2, 2, withAlpha(th.accent, 0.6));
  },
  greenscreen: (p, o) => {
    const w = o.w * T;
    p.vline(1, 0, 16, MAT.metalDark).vline(w - 2, 0, 16, MAT.metalDark);
    p.box(2, 0, w - 4, 13, "#36b85a", MAT.outline);
    p.hline(3, 1, w - 6, "#4fd673");
    p.rect(3, 13, w - 6, 3, "#2f9e4c");
  },
  lightstand: (p) => {
    p.vline(7, 6, 9, MAT.metalDark);
    p.hline(4, 15, 8, MAT.metalDark);
    p.box(3, 0, 10, 7, "#f6f1dc", MAT.outline);
    p.rect(4, 1, 8, 2, "#fffbe8");
  },
  tripod: (p) => {
    p.px(4, 15, MAT.outline).px(11, 15, MAT.outline);
    for (let i = 0; i < 6; i++) {
      p.px(7 - Math.floor(i / 2), 9 + i, MAT.metalDark);
      p.px(8 + Math.floor(i / 2), 9 + i, MAT.metalDark);
    }
    p.vline(7, 8, 7, MAT.metal);
    p.box(3, 2, 10, 7, "#2b2f3d", MAT.outline);
    p.disc(8, 5, 2, "#62e6ff");
    p.px(11, 3, "#ff5f5f");
  },
  locker: (p, o) => {
    p.box(2, 0, 12, 16, hash2(o.x, o.y) < 0.5 ? "#4a6fa5" : "#57609c", MAT.outline);
    p.vline(8, 1, 14, MAT.outline);
    for (const lx of [4, 10]) {
      p.hline(lx - 1, 3, 3, MAT.outline).hline(lx - 1, 5, 3, MAT.outline);
      p.px(lx, 9, MAT.steel);
    }
  },
  cooler: (p) => {
    p.box(1, 1, 14, 15, MAT.metalLight, MAT.outline);
    p.disc(8, 7, 5, MAT.outline);
    p.disc(8, 7, 4, MAT.metalDark);
    p.rect(3, 13, 10, 1, MAT.metal);
  },
  wallscreen: (p, o) => {
    const w = o.w * T;
    p.box(1, 4, w - 2, 9, MAT.metalDark, MAT.outline);
    p.rect(2, 5, w - 4, 7, MAT.screen);
  },
  hatch: (p, o) => {
    const h = o.h * T;
    p.rect(0, 0, T, h, MAT.metalDark);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < 4; i++) if ((i + j) % 6 < 3) p.px(i, j, "#ffd23f");
    }
    p.box(4, 2, 11, h - 4, MAT.metal, MAT.outline);
    p.disc(10, h / 2, 4, MAT.outline);
    p.disc(10, h / 2, 3, "#0d1822");
    p.px(9, h / 2 - 1, MAT.glassShine);
    p.rect(6, 6, 2, h - 12, MAT.steel);
  },
};

function counterBody(p: Pen): void {
  p.rect(0, 3, T, 7, "#c8a678");
  p.hline(0, 3, T, "#e6c999");
  p.rect(0, 10, T, 6, MAT.wood);
  p.hline(0, 15, T, MAT.outline);
  p.vline(4, 11, 4, MAT.woodDark).vline(11, 11, 4, MAT.woodDark);
}

export function paintObject(p: Pen, o: StationObject, th: Theme): void {
  const painter = PAINTERS[o.kind];
  if (painter) {
    painter(p, o, th);
    return;
  }
  // Unknown kinds still show up, as a labelled crate, so map edits are visible.
  p.box(1, 1, o.w * T - 2, o.h * T - 2, MAT.metal, MAT.outline);
  p.text(3, 3, "?", th.accent);
}

export function knownKinds(): string[] {
  return Object.keys(PAINTERS);
}
