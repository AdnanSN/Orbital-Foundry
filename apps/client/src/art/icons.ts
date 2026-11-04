import { expandRow } from "./crew";
import type { Pen } from "./pen";

/**
 * 9×9 status icons shown above crew heads, in the same run-length format as the sprites (rows
 * are 16 wide; only the first 9 columns are used).
 *   o outline   w white   y yellow   r red   g green   c cyan   b brown   k grey
 */

export const ICON_SIZE = 9;

const DOTS_BASE = [
  "16.",
  "1. 7o 8.",
  "o 7w o 7.",
  "o 7w o 7.",
  "o 7w o 7.",
  "1. 7o 8.",
  "1. o 14.",
  "16.",
  "16.",
];

const ICONS = {
  coffee: [
    "2. w . w 11.",
    "1. w . w 12.",
    "16.",
    "7o 9.",
    "o 5b o 9.",
    "o 5w o . o 7.",
    "o 5w 3o 7.",
    "1. 5o 10.",
    "16.",
  ],
  zzz: [
    "3. 6o 7.",
    "3. o 4w o 7.",
    "3. 3o w o 8.",
    "5. o w o 8.",
    "4. o w 2o 8.",
    "3. o 4w o 7.",
    "3. 6o 7.",
    "16.",
    "16.",
  ],
  alert: [
    "3. 3o 10.",
    "3. o y o 10.",
    "3. o y o 10.",
    "3. o y o 10.",
    "3. o y o 10.",
    "3. 3o 10.",
    "3. o y o 10.",
    "3. 3o 10.",
    "16.",
  ],
  check: [
    "16.",
    "6. 3o 7.",
    "5. o 2g o 7.",
    "o o 2. o g g o 8.",
    "o g g o g g o 9.",
    "1. o 3g o 10.",
    "2. o g o 11.",
    "3. o 12.",
    "16.",
  ],
  cross: [
    "16.",
    "o o 3. o o 9.",
    "o r o . o r o 9.",
    "1. o r o r o 10.",
    "2. o r o 11.",
    "1. o r o r o 10.",
    "o r o . o r o 9.",
    "o o 3. o o 9.",
    "16.",
  ],
  search: [
    "1. 4o 11.",
    "o c 2w c o 10.",
    "o w 2c w o 10.",
    "o w 2c w o 10.",
    "o c 2w c o 10.",
    "1. 4o o 10.",
    "5. o k o 8.",
    "6. o k o 7.",
    "7. 2o 7.",
  ],
} as const;

export type IconName = keyof typeof ICONS | "dots0" | "dots1" | "dots2";

const ICON_COLORS: Record<string, string> = {
  o: "#191427",
  w: "#f4f1ff",
  y: "#ffe066",
  r: "#ff5f6d",
  g: "#69e08a",
  c: "#8fe9ff",
  b: "#7a4a2a",
  k: "#8a8aa0",
};

/** Rows for an icon; dots0..dots2 animate a "typing" bubble with one dot lit per frame. */
export function iconRows(name: IconName): string[] {
  if (name === "dots0" || name === "dots1" || name === "dots2") {
    const lit = Number(name.slice(4));
    return DOTS_BASE.map(expandRow).map((row, y) => {
      if (y !== 3) return row;
      const chars = [...row];
      [2, 4, 6].forEach((x, i) => {
        chars[x] = i === lit ? "o" : "k";
      });
      return chars.join("");
    });
  }
  return (ICONS[name] as readonly string[]).map(expandRow);
}

export const ICON_NAMES: IconName[] = [
  ...(Object.keys(ICONS) as (keyof typeof ICONS)[]),
  "dots0",
  "dots1",
  "dots2",
];

export function paintIcon(p: Pen, name: IconName): void {
  iconRows(name).forEach((row, y) => {
    for (let x = 0; x < ICON_SIZE; x++) {
      const key = row[x] as string;
      if (key !== ".") p.px(x, y, ICON_COLORS[key] ?? "#ff00ff");
    }
  });
}
