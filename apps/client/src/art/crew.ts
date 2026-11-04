import type { CarryItem, CrewLook, Direction } from "@orbital/shared";
import { shade } from "./color";

/**
 * Original 16×16 crew sprites, drawn in code. Every frame is composed from layers written as
 * run-length rows ("3. o 8h o 3." means 3 transparent, 1 outline, 8 hair, 1 outline, 3
 * transparent). Letters are palette keys, so one set of matrices serves every crew member:
 *
 *   o outline   s/S skin   h/H hair   e/w eyes   c/C suit   a accent   b boots
 *   k/K/g accessory   x/X/y crate   p/q datapad   u/U cup
 *
 * Right-facing frames mirror the left-facing ones.
 */

export const SPRITE_SIZE = 16;
export const ANIMS = ["idle", "walk", "type", "carry", "hold"] as const;
export type Anim = (typeof ANIMS)[number];
export const FRAME_COUNT: Record<Anim, number> = { idle: 4, walk: 4, type: 2, carry: 4, hold: 1 };

type View = "down" | "up" | "side";
type Rows = readonly string[];

/** Expands one run-length row and checks its width. */
export function expandRow(spec: string): string {
  let out = "";
  for (const token of spec.trim().split(/\s+/)) {
    const m = /^(\d*)(.)$/.exec(token);
    if (!m) throw new Error(`Bad sprite token "${token}" in "${spec}"`);
    out += (m[2] as string).repeat(m[1] ? Number(m[1]) : 1);
  }
  if (out.length !== SPRITE_SIZE) throw new Error(`Sprite row is ${out.length} wide: "${spec}"`);
  return out;
}

/** A layer: rows placed from `top` down. "." is transparent. */
interface Layer {
  top: number;
  rows: Rows;
}
const layer = (top: number, ...rows: string[]): Layer => ({ top, rows: rows.map(expandRow) });

// -- Heads (rows 0-8) ---------------------------------------------------------------------

const FACE_DOWN = [
  "3. o h 6s h o 3.",
  "3. o s w 4s w s o 3.",
  "3. o s e 4s e s o 3.",
  "4. o S 4s S o 4.",
];
const FACE_SIDE = [
  "3. o h 3s 4h o 3.",
  "2. o 2s w s S 4h o 3.",
  "3. o s e s S 4h o 3.",
  "4. o S 2s 3H o 4.",
];

const HEADS: Record<View, Record<CrewLook["hairStyle"], Layer>> = {
  down: {
    short: layer(1, "5. 6o 5.", "4. o 6h o 4.", "3. o 8h o 3.", "3. o H 6h H o 3.", ...FACE_DOWN),
    long: layer(
      1,
      "5. 6o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "2. o H 8h H o 2.",
      "2. o 2h 6s 2h o 2.",
      "2. o h s w 4s w s h o 2.",
      "2. o h s e 4s e s h o 2.",
      "2. o h o S 4s S o h o 2.",
    ),
    bun: layer(
      0,
      "6. 4o 6.",
      "5. o 4h o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o H 6h H o 3.",
      ...FACE_DOWN,
    ),
    spiky: layer(
      0,
      "4. o 2. o 2. o 5.",
      "3. o h o 2h o 2h o 4.",
      "3. o h 6h h o 3.",
      "3. o 8h o 3.",
      "3. o H 6h H o 3.",
      ...FACE_DOWN,
    ),
    swept: layer(
      1,
      "5. 6o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 5h 2s h o 3.",
      "3. o s w 4s w s o 3.",
      "3. o s e 4s e s o 3.",
      "4. o S 4s S o 4.",
    ),
  },
  up: {
    short: layer(
      1,
      "5. 6o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o H 6h H o 3.",
      "4. o S 4H S o 4.",
    ),
    long: layer(
      1,
      "5. 6o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "2. o 10h o 2.",
      "2. o 10h o 2.",
      "2. o 10h o 2.",
      "2. o 10h o 2.",
      "2. o H 8h H o 2.",
    ),
    bun: layer(
      0,
      "6. 4o 6.",
      "5. o 4h o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o H 6h H o 3.",
      "4. o S 4H S o 4.",
    ),
    spiky: layer(
      0,
      "4. o 2. o 2. o 5.",
      "3. o h o 2h o 2h o 4.",
      "3. o h 6h h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o H 6h H o 3.",
      "4. o S 4H S o 4.",
    ),
    swept: layer(
      1,
      "5. 6o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o H 6h H o 3.",
      "4. o S 4H S o 4.",
    ),
  },
  side: {
    short: layer(1, "5. 6o 5.", "4. o 6h o 4.", "3. o 8h o 3.", "3. o 8h o 3.", ...FACE_SIDE),
    long: layer(
      1,
      "5. 6o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 9h o 2.",
      "3. o h 3s 5h o 2.",
      "2. o 2s w s S 5h o 2.",
      "3. o s e s S 5h o 2.",
      "4. o S 2s 5h o 2.",
    ),
    bun: layer(
      0,
      "6. 4o 6.",
      "5. o 4h o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      ...FACE_SIDE,
    ),
    spiky: layer(
      0,
      "5. o 2. o 2. o 4.",
      "4. o h o 2h o 2h o 3.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      ...FACE_SIDE,
    ),
    swept: layer(
      1,
      "5. 6o 5.",
      "4. o 6h o 4.",
      "3. o 8h o 3.",
      "3. o 8h o 3.",
      "3. o 2h 2s 4h o 3.",
      "2. o 2s w s S 4h o 3.",
      "3. o s e s S 4h o 3.",
      "4. o S 2s 3H o 4.",
    ),
  },
};

/** Long hair falls over the shoulders. */
const HAIR_TAIL: Record<View, Partial<Record<CrewLook["hairStyle"], Layer>>> = {
  down: { long: layer(9, "2. o h 8. h o 2.", "2. o H 8. H o 2.") },
  up: { long: layer(9, "2. o 10h o 2.", "3. o 8H o 3.") },
  side: { long: layer(9, "8. o 4h o 2.", "9. o 3H o 2.") },
};

// -- Accessories (drawn over the head) ----------------------------------------------------

const ACCESSORIES: Record<View, Partial<Record<CrewLook["accessory"], Layer>>> = {
  down: {
    cap: layer(0, "16.", "4. 8o 4.", "3. o 8k o 3.", "3. o 3k 2a 3k o 3.", "2. o 10K o 2."),
    headset: layer(
      1,
      "5. 6k 5.",
      "16.",
      "16.",
      "16.",
      "2. o k 8. k o 2.",
      "2. o K 8. K o 2.",
      "16.",
      "3. 2k 11.",
    ),
    goggles: layer(4, "3. o k 2g 2k 2g k o 3."),
    glasses: layer(6, "4. k 2g 2k 2g k 4."),
    visor: layer(3, "3. o 8k o 3.", "2. o 10K o 2."),
  },
  up: {
    cap: layer(0, "16.", "4. 8o 4.", "3. o 8k o 3.", "3. o 8k o 3.", "3. o 8K o 3."),
    headset: layer(1, "5. 6k 5.", "16.", "16.", "16.", "2. o k 8. k o 2.", "2. o K 8. K o 2."),
    goggles: layer(4, "3. o 8k o 3."),
    glasses: layer(6, "3. k 8. k 3."),
    visor: layer(3, "3. o 8k o 3."),
  },
  side: {
    cap: layer(0, "16.", "4. 8o 4.", "3. o 8k o 3.", "3. o a 7k o 3.", "1. o 10K o 3."),
    headset: layer(1, "5. 6k 5.", "16.", "16.", "16.", "8. 2k 6.", "8. 2K 6.", "5. 3k 8."),
    goggles: layer(4, "3. o 2g 6k o 3."),
    glasses: layer(6, "4. k g 3k 7."),
    visor: layer(3, "3. o 8k o 3.", "1. o 4K 10."),
  },
};

// -- Bodies (rows 9-12) --------------------------------------------------------------------

type BodyPose = "idle" | "walk1" | "walk3" | "type0" | "type1" | "carry";
type LegPose = "stand" | "stride1" | "stride3";

const BODY_DOWN_IDLE = [
  "3. o 2c 4a 2c o 3.",
  "2. o C 8c C o 2.",
  "2. o C 8c C o 2.",
  "2. o s 8a s o 2.",
];
const BODY_UP_IDLE = [
  "3. o 8c o 3.",
  "2. o C 2c 4C 2c C o 2.",
  "2. o C 8c C o 2.",
  "2. o s 8a s o 2.",
];
const BODY_SIDE_IDLE = [
  "4. o 2a 4c o 4.",
  "4. o c 2C 3c o 4.",
  "4. o c 2C 3c o 4.",
  "4. o a s 4a o 4.",
];

const BODY_SPEC: Record<View, Record<BodyPose, Rows>> = {
  down: {
    idle: BODY_DOWN_IDLE,
    walk1: ["3. o 2c 4a 2c o 3.", "2. o C 8c C o 2.", "2. o s 8c C o 2.", "3. o 8a s o 2."],
    walk3: ["3. o 2c 4a 2c o 3.", "2. o C 8c C o 2.", "2. o C 8c s o 2.", "2. o s 8a o 3."],
    type0: ["3. o 2c 4a 2c o 3.", "2. o C 8c C o 2.", "2. o C s 7c C o 2.", "3. o 8a s o 2."],
    type1: ["3. o 2c 4a 2c o 3.", "2. o C 8c C o 2.", "2. o C 7c s C o 2.", "2. o s 8a o 3."],
    carry: ["3. o 2c 4a 2c o 3.", "2. o C 8c C o 2.", "2. o C 8c C o 2.", "3. o 8a o 3."],
  },
  up: {
    idle: BODY_UP_IDLE,
    walk1: ["3. o 8c o 3.", "2. o C 2c 4C 2c C o 2.", "2. o s 8c C o 2.", "3. o 8a s o 2."],
    walk3: ["3. o 8c o 3.", "2. o C 2c 4C 2c C o 2.", "2. o C 8c s o 2.", "2. o s 8a o 3."],
    type0: ["2. o C 8c o 3.", "2. o C 2c 4C 2c C o 2.", "3. o 8c C o 2.", "3. o 8a o 3."],
    type1: ["3. o 8c C o 2.", "2. o C 2c 4C 2c C o 2.", "2. o C 8c o 3.", "3. o 8a o 3."],
    carry: ["3. o 8c o 3.", "2. o C 2c 4C 2c C o 2.", "3. o 8c o 3.", "3. o 8a o 3."],
  },
  side: {
    idle: BODY_SIDE_IDLE,
    walk1: ["4. o 2a 4c o 4.", "3. o C C 5c o 4.", "3. o s 6c o 4.", "4. o 6a o 4."],
    walk3: ["4. o 2a 4c o 4.", "4. o 4c 2C o 4.", "4. o 4c C s o 4.", "4. o 6a o 4."],
    type0: ["4. o 2a 4c o 4.", "2. o s 3C 4c o 4.", "4. o 6c o 4.", "4. o 6a o 4."],
    type1: ["4. o 2a 4c o 4.", "3. o 4C 3c o 4.", "2. o s o 6c o 4.", "4. o 6a o 4."],
    carry: ["4. o 2a 4c o 4.", "4. o c 2C 3c o 4.", "4. o c 2C 3c o 4.", "4. o 6a o 4."],
  },
};

// -- Legs (rows 12-15; row 12 shows only when the body bobs up) ----------------------------

const LEGS_SPEC: Record<View, Record<LegPose, Rows>> = {
  down: {
    stand: ["4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2b 2o 2b o 4."],
    stride1: ["4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2b 2o 2C o 4.", "8. o 2b o 4."],
    stride3: ["4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2C 2o 2b o 4.", "4. o 2b o 8."],
  },
  up: {
    stand: ["4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2b 2o 2b o 4."],
    stride1: ["4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2b 2o 2C o 4.", "8. o 2b o 4."],
    stride3: ["4. o 2C 2o 2C o 4.", "4. o 2C 2o 2C o 4.", "4. o 2C 2o 2b o 4.", "4. o 2b o 8."],
  },
  side: {
    stand: ["5. o 4C o 5.", "5. o 4C o 5.", "5. o 4C o 5.", "4. o 5b o 5."],
    stride1: ["5. o 4C o 5.", "5. o 4C o 5.", "4. o 2c 2o 2C o 4.", "3. o 2b o 2. o 2b o 3."],
    stride3: ["5. o 4C o 5.", "5. o 4C o 5.", "4. o 2C 2o 2c o 4.", "3. o 2b o 2. o 2b o 3."],
  },
};

/** Expands every run-length row of a pose table. */
function expandTable<K extends string>(
  table: Record<View, Record<K, Rows>>,
): Record<View, Record<K, Rows>> {
  const out = {} as Record<View, Record<K, Rows>>;
  for (const view of Object.keys(table) as View[]) {
    const poses = {} as Record<K, Rows>;
    for (const pose of Object.keys(table[view]) as K[])
      poses[pose] = table[view][pose].map(expandRow);
    out[view] = poses;
  }
  return out;
}

const BODY = expandTable(BODY_SPEC);
const LEGS = expandTable(LEGS_SPEC);

// -- Carried items ---------------------------------------------------------------------------

const ITEMS: Record<View, Record<CarryItem, Layer | null>> = {
  down: {
    crate: layer(9, "4. 8o 4.", "3. s o 6x o s 3.", "4. o x 4y x o 4.", "4. o 6X o 4.", "4. 8o 4."),
    datapad: layer(10, "5. 6o 5.", "4. s o 4q o s 4.", "5. 6o 5."),
    cup: layer(10, "1. o 2U o 11.", "1. o 2u o 11.", "1. 4o 11."),
  },
  up: {
    crate: layer(10, "2. x 10. x 2.", "2. X 10. X 2."),
    datapad: null,
    cup: null,
  },
  side: {
    crate: layer(9, "6o 10.", "o 4x o 10.", "o x 2y x o 10.", "o 4X o 10.", "6o 10."),
    datapad: layer(10, "1. 4o 11.", "1. o 2q o 11.", "1. 4o 11."),
    cup: layer(10, "1. 4o 11.", "1. o 2u o 11.", "1. 4o 11."),
  },
};

// -- Composition ---------------------------------------------------------------------------

export interface FrameSpec {
  facing: Direction;
  anim: Anim;
  index: number;
  item?: CarryItem;
}

/** Palette keys for one frame, 16 strings of 16 characters; "." is transparent. */
export function composeFrame(look: CrewLook, spec: FrameSpec): string[] {
  const view: View = spec.facing === "down" ? "down" : spec.facing === "up" ? "up" : "side";
  const grid = Array.from({ length: SPRITE_SIZE }, () => Array<string>(SPRITE_SIZE).fill("."));
  const put = (l: Layer | null | undefined, dy = 0) => {
    if (!l) return;
    l.rows.forEach((row, i) => {
      const y = l.top + i + dy;
      if (y < 0 || y >= SPRITE_SIZE) return;
      for (let x = 0; x < SPRITE_SIZE; x++) {
        const ch = row[x] as string;
        if (ch !== ".") (grid[y] as string[])[x] = ch;
      }
    });
  };

  const walking = spec.anim === "walk" || spec.anim === "carry";
  const stride = walking && spec.index % 2 === 1;
  // Passing frames lift the body a pixel; the idle cycle dips it on its "breath" frame.
  let bob = 0;
  if (walking && !stride) bob = -1;
  if (spec.anim === "idle" && spec.index === 2) bob = 1;

  const legs = LEGS[view];
  put({ top: 12, rows: stride ? (spec.index === 1 ? legs.stride1 : legs.stride3) : legs.stand });

  const bodies = BODY[view];
  let body = bodies.idle;
  if (spec.anim === "walk" && spec.index === 1) body = bodies.walk1;
  if (spec.anim === "walk" && spec.index === 3) body = bodies.walk3;
  if (spec.anim === "type") body = spec.index === 0 ? bodies.type0 : bodies.type1;
  if (spec.anim === "carry" || spec.anim === "hold")
    body = spec.item === "crate" || view === "up" ? bodies.carry : bodies.idle;
  put({ top: 9, rows: body }, bob);

  put(HEADS[view][look.hairStyle], bob);
  put(HAIR_TAIL[view][look.hairStyle], bob);
  put(ACCESSORIES[view][look.accessory], bob);
  if ((spec.anim === "carry" || spec.anim === "hold") && spec.item)
    put(ITEMS[view][spec.item], bob);

  // Blink on the last idle frame: the eye glints close, leaving a dark lid line.
  if (spec.anim === "idle" && spec.index === 3) {
    for (const row of grid) for (let x = 0; x < SPRITE_SIZE; x++) if (row[x] === "w") row[x] = "s";
  }

  const rows = grid.map((r) => r.join(""));
  return spec.facing === "right" ? rows.map((r) => [...r].reverse().join("")) : rows;
}

/** Concrete colours for every palette key of a crew member's look. */
export function crewPalette(look: CrewLook): Record<string, string> {
  const accessory: Record<CrewLook["accessory"], { k: string; K: string; g: string }> = {
    none: { k: "#2b2f3d", K: "#1d2030", g: "#bfefff" },
    cap: { k: shade(look.suit, -0.25), K: shade(look.suit, -0.55), g: look.accent },
    headset: { k: "#2b2f3d", K: look.accent, g: look.accent },
    goggles: { k: "#5a4030", K: "#3a281c", g: "#ffb347" },
    glasses: { k: "#2b2f3d", K: "#1d2030", g: "#bfefff" },
    visor: { k: "#3fbf7f", K: "#2b8f5e", g: "#9fffd0" },
  };
  const acc = accessory[look.accessory];
  return {
    o: "#191427",
    s: look.skin,
    S: shade(look.skin, -0.22),
    h: look.hair,
    H: shade(look.hair, -0.3),
    e: look.eyes ?? "#231a2e",
    w: "#ffffff",
    c: look.suit,
    C: shade(look.suit, -0.28),
    a: look.accent,
    A: shade(look.accent, -0.25),
    b: "#3b3448",
    k: acc.k,
    K: acc.K,
    g: acc.g,
    x: "#c98a4b",
    X: "#8a5a2e",
    y: "#5ff2ff",
    p: "#2c3345",
    q: "#62e6ff",
    u: "#f3efe8",
    U: "#7a4a2a",
  };
}

/** Every frame name in a crew sheet, in sheet order. */
export function frameSpecs(): FrameSpec[] {
  const out: FrameSpec[] = [];
  for (const facing of ["down", "left", "right", "up"] as const) {
    for (const anim of ["idle", "walk", "type"] as const) {
      for (let i = 0; i < FRAME_COUNT[anim]; i++) out.push({ facing, anim, index: i });
    }
    for (const item of ["crate", "datapad", "cup"] as const) {
      for (let i = 0; i < FRAME_COUNT.carry; i++)
        out.push({ facing, anim: "carry", index: i, item });
      out.push({ facing, anim: "hold", index: 0, item });
    }
  }
  return out;
}

export function frameName(spec: FrameSpec): string {
  return `${spec.facing}-${spec.anim}${spec.item ? `-${spec.item}` : ""}-${spec.index}`;
}

/** Paints a composed frame at (x, y) with `scale`×`scale` pixels. */
export function paintFrame(
  ctx: CanvasRenderingContext2D,
  rows: readonly string[],
  palette: Record<string, string>,
  x: number,
  y: number,
  scale = 1,
): void {
  rows.forEach((row, py) => {
    for (let px = 0; px < row.length; px++) {
      const key = row[px] as string;
      if (key === ".") continue;
      ctx.fillStyle = palette[key] ?? "#ff00ff";
      ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
    }
  });
}
