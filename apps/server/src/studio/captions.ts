/**
 * Word timings and captions. ElevenLabs returns per-character timings; local voices are timed per
 * sentence and the words spread over each sentence's speech by length. Shorts get 2 to 4 word
 * captions highlighted as they are spoken; long-form gets an SRT file for the platform.
 */

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface CaptionChunk {
  start: number;
  end: number;
  words: WordTiming[];
}

/** Groups character timings into words (whitespace separates words). */
export function wordsFromAlignment(
  chars: string[],
  starts: number[],
  ends: number[],
  offset = 0,
): WordTiming[] {
  const words: WordTiming[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (text.trim()) words.push({ text: text.trim(), start: start + offset, end: end + offset });
    text = "";
  };
  chars.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      flush();
      return;
    }
    if (!text) start = starts[i] ?? end;
    text += ch;
    end = ends[i] ?? start;
  });
  flush();
  return words;
}

/** Splits text into words for timing (keeps punctuation on the word). */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/** Relative speaking weight of a word: its letters, plus a pause after punctuation. */
function weight(word: string): number {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, "").length || 1;
  const pause = /[.!?]$/.test(word) ? 3 : /[,;:—–-]$/.test(word) ? 1.5 : 0;
  return letters + 1.2 + pause;
}

/** Spreads the words of `text` across [start, end] by their weights. */
export function distributeWords(text: string, start: number, end: number): WordTiming[] {
  const words = splitWords(text);
  const total = words.reduce((s, w) => s + weight(w), 0);
  const span = Math.max(0.01, end - start);
  let t = start;
  return words.map((w) => {
    const share = (weight(w) / total) * span;
    const timing = { text: w, start: t, end: t + share * 0.92 };
    t += share;
    return timing;
  });
}

/** Sentences of a paragraph (keeps the end punctuation). */
export function sentences(text: string): string[] {
  return (text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [text])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ChunkOptions {
  maxWords?: number;
  maxChars?: number;
  maxDuration?: number;
  /** A silence this long starts a new caption. */
  maxGap?: number;
}

/** Short on-screen captions: a few words at a time, broken at punctuation and pauses. */
export function chunkCaptions(words: WordTiming[], opts: ChunkOptions = {}): CaptionChunk[] {
  const maxWords = opts.maxWords ?? 3;
  const maxChars = opts.maxChars ?? 18;
  const maxDuration = opts.maxDuration ?? 1.8;
  const maxGap = opts.maxGap ?? 0.5;
  const chunks: CaptionChunk[] = [];
  let current: WordTiming[] = [];
  const close = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first && last) chunks.push({ start: first.start, end: last.end, words: current });
    current = [];
  };
  for (const w of words) {
    const prev = current.at(-1);
    const chars = current.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const first = current[0];
    if (
      prev &&
      (current.length >= maxWords ||
        chars > maxChars ||
        w.start - prev.end > maxGap ||
        (first && w.end - first.start > maxDuration))
    ) {
      close();
    }
    current.push(w);
    if (/[.!?,;:]$/.test(w.text)) close();
  }
  close();
  // Each caption stays up until the next one starts (no flicker in short gaps).
  for (let i = 0; i < chunks.length - 1; i++) {
    const a = chunks[i];
    const b = chunks[i + 1];
    if (a && b && b.start - a.end < 0.35) a.end = b.start;
  }
  return chunks;
}

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** Subtitles for a platform: up to two lines of 42 characters, at most 6 seconds each. */
export function toSrt(words: WordTiming[], maxChars = 42, maxDuration = 6): string {
  const cues: { start: number; end: number; text: string }[] = [];
  let line: WordTiming[] = [];
  const close = () => {
    const first = line[0];
    const last = line.at(-1);
    if (!first || !last) return;
    const text = line.map((w) => w.text).join(" ");
    let wrapped = text;
    if (text.length > maxChars) {
      const mid = text.lastIndexOf(" ", Math.min(maxChars, Math.ceil(text.length / 2) + 6));
      wrapped = mid > 0 ? `${text.slice(0, mid)}\n${text.slice(mid + 1)}` : text;
    }
    cues.push({ start: first.start, end: last.end, text: wrapped });
    line = [];
  };
  for (const w of words) {
    const first = line[0];
    const len = line.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (first && (len > maxChars * 2 || w.end - first.start > maxDuration)) close();
    line.push(w);
    if (/[.!?]$/.test(w.text) && line.length >= 4) close();
  }
  close();
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");
}
