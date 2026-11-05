import type { Blocklist } from "../creative/config";
import { blocklistHits } from "../creative/qa";
import { FFMPEG, measureLoudness, runTool } from "./ffmpeg";

/**
 * The Screening Room (Stage 16): technical checks on the finished file (black frames, frozen
 * frames, silence, loudness) and the policy screens on its words (the IP blocklist), plus the
 * AI-disclosure decision. Problems block the Desk item's "ready" label, not the owner's choice.
 */

export interface Interval {
  start: number;
  end: number;
}

export interface ScreeningReport {
  black: Interval[];
  frozen: Interval[];
  silent: Interval[];
  lufs: number;
  truePeak: number;
  ipHits: string[];
  /** Realistic AI imagery means YouTube's altered-or-synthetic flag and TikTok's AI label. */
  syntheticMedia: boolean;
  problems: string[];
  ok: boolean;
}

/** Reads FFmpeg detector lines like `black_start:1.2 black_end:2.3`. */
export function parseIntervals(log: string, kind: "black" | "freeze" | "silence"): Interval[] {
  const out: Interval[] = [];
  if (kind === "black") {
    for (const m of log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
      out.push({ start: Number(m[1]), end: Number(m[2]) });
    }
    return out;
  }
  const key = kind === "freeze" ? "freeze" : "silence";
  let start: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = new RegExp(`${key}_start: ?([\\d.]+)`).exec(line);
    if (s) start = Number(s[1]);
    const e = new RegExp(`${key}_end: ?([\\d.]+)`).exec(line);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return out;
}

export async function detect(
  file: string,
): Promise<{ black: Interval[]; frozen: Interval[]; silent: Interval[] }> {
  const { stderr } = await runTool(FFMPEG, [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-vf",
    "blackdetect=d=0.6:pix_th=0.10,freezedetect=n=0.003:d=4",
    "-af",
    "silencedetect=n=-45dB:d=1.5",
    "-f",
    "null",
    "-",
  ]);
  return {
    black: parseIntervals(stderr, "black"),
    frozen: parseIntervals(stderr, "freeze"),
    silent: parseIntervals(stderr, "silence"),
  };
}

export interface ScreenInput {
  file: string;
  duration: number;
  /** Everything said or written: narration, titles, description, on-screen text. */
  words: string;
  blocklist?: Blocklist;
  /** Whether any shot is a realistic AI image (not an obvious illustration or chart). */
  realisticAi: boolean;
}

export function judge(
  input: Omit<ScreenInput, "file" | "blocklist">,
  found: {
    black: Interval[];
    frozen: Interval[];
    silent: Interval[];
    lufs: number;
    truePeak: number;
  },
  ipHits: string[],
): ScreeningReport {
  const problems: string[] = [];
  const len = (xs: Interval[]) => xs.reduce((n, x) => n + (x.end - x.start), 0);
  // Fades in and out are fine; black in the middle is not.
  const midBlack = found.black.filter((b) => b.start > 0.5 && b.end < input.duration - 0.5);
  if (midBlack.length > 0)
    problems.push(`Black frames at ${midBlack.map((b) => `${b.start.toFixed(1)}s`).join(", ")}.`);
  if (len(found.frozen) > 6)
    problems.push(`The picture stands still for ${len(found.frozen).toFixed(0)} s in all.`);
  const longSilence = found.silent.filter((s) => s.end - s.start > 2.5 && s.start > 0.5);
  if (longSilence.length > 0)
    problems.push(`Silence at ${longSilence.map((s) => `${s.start.toFixed(1)}s`).join(", ")}.`);
  if (Number.isFinite(found.lufs) && Math.abs(found.lufs + 14) > 2)
    problems.push(`Loudness ${found.lufs.toFixed(1)} LUFS (target -14).`);
  if (Number.isFinite(found.truePeak) && found.truePeak > -0.5)
    problems.push(`Peaks at ${found.truePeak.toFixed(1)} dB may clip.`);
  if (ipHits.length > 0) problems.push(`Names protected IP: ${ipHits.join(", ")}.`);
  return {
    black: found.black,
    frozen: found.frozen,
    silent: found.silent,
    lufs: found.lufs,
    truePeak: found.truePeak,
    ipHits,
    syntheticMedia: input.realisticAi,
    problems,
    ok: problems.length === 0,
  };
}

export async function screen(input: ScreenInput): Promise<ScreeningReport> {
  const [found, loud] = await Promise.all([detect(input.file), measureLoudness(input.file)]);
  const ipHits = input.blocklist
    ? [...new Set(blocklistHits(input.words, input.blocklist).map((h) => h.term))]
    : [];
  return judge(input, { ...found, ...loud }, ipHits);
}
