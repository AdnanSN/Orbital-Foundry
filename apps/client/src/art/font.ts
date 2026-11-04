/**
 * A tiny original bitmap font, 5 pixels tall with variable width, used for name tags, speech
 * bubbles and floor labels. Uppercase only: lowercase input is shown in capitals. Each glyph is
 * written as rows joined by "/", with "#" for an inked pixel.
 */

const GLYPHS: Record<string, string> = {
  A: ".#./#.#/###/#.#/#.#",
  B: "##./#.#/##./#.#/##.",
  C: ".##/#../#../#../.##",
  D: "##./#.#/#.#/#.#/##.",
  E: "###/#../##./#../###",
  F: "###/#../##./#../#..",
  G: ".##/#../#.#/#.#/.##",
  H: "#.#/#.#/###/#.#/#.#",
  I: "###/.#./.#./.#./###",
  J: "..#/..#/..#/#.#/.#.",
  K: "#.#/#.#/##./#.#/#.#",
  L: "#../#../#../#../###",
  M: "#...#/##.##/#.#.#/#...#/#...#",
  N: "#..#/##.#/#.##/#..#/#..#",
  O: ".#./#.#/#.#/#.#/.#.",
  P: "##./#.#/##./#../#..",
  Q: ".#./#.#/#.#/##./.##",
  R: "##./#.#/##./#.#/#.#",
  S: ".##/#../.#./..#/##.",
  T: "###/.#./.#./.#./.#.",
  U: "#.#/#.#/#.#/#.#/###",
  V: "#.#/#.#/#.#/#.#/.#.",
  W: "#...#/#...#/#.#.#/##.##/#...#",
  X: "#.#/#.#/.#./#.#/#.#",
  Y: "#.#/#.#/.#./.#./.#.",
  Z: "###/..#/.#./#../###",
  "0": "###/#.#/#.#/#.#/###",
  "1": ".#./##./.#./.#./###",
  "2": "##./..#/.#./#../###",
  "3": "##./..#/.#./..#/##.",
  "4": "#.#/#.#/###/..#/..#",
  "5": "###/#../##./..#/##.",
  "6": ".##/#../###/#.#/###",
  "7": "###/..#/.#./.#./.#.",
  "8": "###/#.#/###/#.#/###",
  "9": "###/#.#/###/..#/##.",
  " ": "../../../../..",
  ".": "././././#",
  ",": "../../../.#/#.",
  "!": "#/#/#/./#",
  "?": "##./..#/.#./.../.#.",
  ":": "./#/./#/.",
  ";": "../.#/../.#/#.",
  "'": "#/#/././.",
  '"': "#.#/#.#/.../.../...",
  "-": ".../.../###/.../...",
  "+": ".../.#./###/.#./...",
  "/": "..#/..#/.#./#../#..",
  "(": ".#/#./#./#./.#",
  ")": "#./.#/.#/.#/#.",
  "[": "##/#./#./#./##",
  "]": "##/.#/.#/.#/##",
  $: ".##/##./.#./.##/##.",
  "%": "#.#/..#/.#./#../#.#",
  "#": "#.#/###/#.#/###/#.#",
  "&": ".#./#.#/.#./#.#/.##",
  "*": ".../#.#/.#./#.#/...",
  "=": ".../###/.../###/...",
  "<": "..#/.#./#../.#./..#",
  ">": "#../.#./..#/.#./#..",
  _: ".../.../.../.../###",
  "·": "././#/./.",
  "…": "...../...../...../...../#.#.#",
  "✓": "...#/..#./#.#./.#../....",
  "→": "..../..#./####/..#./....",
  "↑": ".#./###/.#./.#./.#.",
  "↓": ".#./.#./.#./###/.#.",
};

export interface Glyph {
  rows: readonly string[];
  width: number;
}

export const GLYPH_HEIGHT = 5;
/** Distance between baselines of wrapped lines. */
export const LINE_HEIGHT = 7;
/** Blank columns between glyphs. */
export const LETTER_SPACING = 1;

const PARSED = new Map<string, Glyph>();
for (const [ch, spec] of Object.entries(GLYPHS)) {
  const rows = spec.split("/");
  const width = rows[0]?.length ?? 0;
  if (rows.length !== GLYPH_HEIGHT || rows.some((r) => r.length !== width)) {
    throw new Error(`Glyph "${ch}" is malformed`);
  }
  PARSED.set(ch, { rows, width });
}

const ALIASES: Record<string, string> = {
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "×": "*",
  "–": "-",
  "—": "-",
};

/** Uppercase, no diacritics, typographic quotes folded to plain ones. */
export function normalizeText(text: string): string {
  return [...text.normalize("NFD").replace(/[̀-ͯ]/g, "")]
    .map((ch) => ALIASES[ch] ?? ch.toUpperCase())
    .join("");
}

export function glyphFor(ch: string): Glyph {
  return PARSED.get(ch) ?? (PARSED.get("?") as Glyph);
}

export function hasGlyph(ch: string): boolean {
  return PARSED.has(ch);
}

/** Width in pixels of one line of (already normalized or raw) text. */
export function measureText(text: string): number {
  const chars = [...normalizeText(text)];
  if (chars.length === 0) return 0;
  return chars.reduce((w, ch) => w + glyphFor(ch).width, 0) + LETTER_SPACING * (chars.length - 1);
}

/** Greedy word wrap to `maxWidth` pixels. Words longer than a line are split. */
export function wrapText(text: string, maxWidth: number): string[] {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const push = (word: string) => {
    const candidate = line ? `${line} ${word}` : word;
    if (measureText(candidate) <= maxWidth) {
      line = candidate;
      return;
    }
    if (line) lines.push(line);
    line = "";
    if (measureText(word) <= maxWidth) {
      line = word;
      return;
    }
    // Hard-break a long word.
    let chunk = "";
    for (const ch of word) {
      if (measureText(chunk + ch) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = "";
      }
      chunk += ch;
    }
    line = chunk;
  };
  for (const w of words) push(w);
  if (line) lines.push(line);
  return lines;
}

/** Draws one line with its top-left at (x, y). `scale` makes each font pixel scale×scale. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale = 1,
): number {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of normalizeText(text)) {
    const g = glyphFor(ch);
    g.rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] === "#") ctx.fillRect(cx + rx * scale, y + ry * scale, scale, scale);
      }
    });
    cx += (g.width + LETTER_SPACING) * scale;
  }
  return cx - x - LETTER_SPACING * scale;
}
