import fs from "node:fs";
import path from "node:path";
import { writeWav } from "./ffmpeg";
import type { Asset, AssetLibrary } from "./library";

/**
 * Music beds and sound effects (Stage 14). The owner's library comes first: drop tracks (for
 * example from YouTube's Audio Library) into data/library/music with a `<name>.json` beside each
 * ({ "title", "licence", "credit", "mood" }). Without one, the station synthesizes an ambient bed
 * and its effects in code: free, deterministic, and nobody else's rights to clear.
 */

export const MOODS = ["calm", "space", "uplifting", "tense"] as const;
export type Mood = (typeof MOODS)[number];
export const SFX = ["whoosh", "pop", "riser", "hit"] as const;
export type SfxKind = (typeof SFX)[number];

const RATE = 44_100;
const CODE_LICENCE = "Synthesized by the station in code (no third-party rights)";

/** Chord roots and intervals (semitones above the root) per mood, one chord per 8 seconds. */
const PROGRESSIONS: Record<Mood, { root: number; chord: number[] }[]> = {
  calm: [
    { root: 48, chord: [0, 4, 7, 11] },
    { root: 45, chord: [0, 3, 7, 10] },
    { root: 41, chord: [0, 4, 7, 11] },
    { root: 43, chord: [0, 4, 7, 9] },
  ],
  space: [
    { root: 50, chord: [0, 2, 7, 14] },
    { root: 46, chord: [0, 4, 7, 14] },
    { root: 43, chord: [0, 2, 7, 12] },
    { root: 48, chord: [0, 4, 9, 14] },
  ],
  uplifting: [
    { root: 48, chord: [0, 4, 7, 12] },
    { root: 43, chord: [0, 4, 7, 11] },
    { root: 45, chord: [0, 3, 7, 10] },
    { root: 41, chord: [0, 4, 7, 12] },
  ],
  tense: [
    { root: 45, chord: [0, 3, 7, 10] },
    { root: 41, chord: [0, 4, 7, 11] },
    { root: 38, chord: [0, 3, 7, 10] },
    { root: 40, chord: [0, 4, 7, 10] },
  ],
};

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A slow ambient pad: detuned voices per chord with long crossfades, a sub note and a shimmer. */
export function synthBed(duration: number, mood: Mood = "calm"): Float32Array {
  const n = Math.ceil(duration * RATE);
  const out = new Float32Array(n);
  const prog = PROGRESSIONS[mood];
  const chordLen = 8;
  const fade = 2.5;
  const chords = Math.ceil(duration / chordLen) + 1;
  for (let c = 0; c < chords; c++) {
    const { root, chord } = prog[c % prog.length] ?? { root: 48, chord: [0, 4, 7] };
    const t0 = c * chordLen - fade / 2;
    const t1 = t0 + chordLen + fade;
    const s0 = Math.max(0, Math.floor(t0 * RATE));
    const s1 = Math.min(n, Math.ceil(t1 * RATE));
    const voices = [
      ...chord.map((iv, k) => ({
        f: hz(root + 12 + iv),
        amp: 0.16 / (1 + k * 0.25),
        det: 1 + (k % 2 ? 0.003 : -0.003),
      })),
      { f: hz(root), amp: 0.14, det: 1 },
      { f: hz(root + 31), amp: 0.025, det: 1.001 },
    ];
    for (let i = s0; i < s1; i++) {
      const t = i / RATE;
      const local = t - t0;
      const env = Math.min(1, local / fade, (t1 - t) / fade);
      const shaped = env * env * (3 - 2 * env);
      const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.13 * t + c);
      let s = 0;
      for (const v of voices) {
        const ph = 2 * Math.PI * v.f * t;
        s += v.amp * (Math.sin(ph) + 0.6 * Math.sin(ph * v.det) + 0.08 * Math.sin(2 * ph));
      }
      out[i] = (out[i] ?? 0) + s * shaped * lfo;
    }
  }
  // Fade the whole bed in and out, then normalize to -6 dBFS.
  const edge = Math.min(n / 4, RATE * 2);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, i / edge, (n - 1 - i) / edge);
    out[i] = (out[i] ?? 0) * g;
    peak = Math.max(peak, Math.abs(out[i] ?? 0));
  }
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = ((out[i] ?? 0) / peak) * 0.5;
  return out;
}

function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

/** Short effects for cuts and reveals. */
export function synthSfx(kind: SfxKind): Float32Array {
  const len = { whoosh: 0.7, pop: 0.15, riser: 1.6, hit: 0.5 }[kind];
  const n = Math.ceil(len * RATE);
  const out = new Float32Array(n);
  const rnd = noise(7 + kind.length);
  let lp = 0;
  let bp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const x = t / len;
    let s = 0;
    switch (kind) {
      case "whoosh": {
        // Noise through a resonant filter whose centre sweeps up and back down.
        const centre = 300 + 2500 * Math.sin(Math.PI * x);
        const f = 2 * Math.sin((Math.PI * centre) / RATE);
        lp += f * bp;
        bp += f * (rnd() - lp - 0.4 * bp);
        s = bp * Math.sin(Math.PI * x) ** 2 * 0.9;
        break;
      }
      case "pop": {
        const f = 900 - 500 * x;
        s = Math.sin(2 * Math.PI * f * t) * Math.exp(-x * 9);
        break;
      }
      case "riser": {
        const f = 180 + 1100 * x * x;
        lp += 0.05 * (rnd() - lp);
        s = (0.5 * Math.sin(2 * Math.PI * f * t) + 0.6 * lp) * x ** 1.5;
        break;
      }
      case "hit": {
        const f = 70 * (1 - 0.4 * x);
        s = Math.sin(2 * Math.PI * f * t) * Math.exp(-x * 7) + rnd() * Math.exp(-x * 30) * 0.3;
        break;
      }
    }
    out[i] = s;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = ((out[i] ?? 0) / peak) * 0.7;
  return out;
}

export interface MusicChoice {
  file: string;
  asset: Asset;
}

export class SoundKit {
  constructor(private readonly library: AssetLibrary) {}

  /** The owner's tracks with sidecars, for `mood` when given. */
  ownerTracks(mood?: Mood): Asset[] {
    const dir = path.join(this.library.dir, "music");
    if (!fs.existsSync(dir)) return [];
    const tracks: Asset[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp3|wav|m4a|ogg)$/i.test(f)) continue;
      const side = path.join(dir, `${f.replace(/\.[^.]+$/, "")}.json`);
      if (!fs.existsSync(side)) continue;
      const meta = JSON.parse(fs.readFileSync(side, "utf8")) as {
        title?: string;
        licence?: string;
        credit?: string;
        mood?: string;
      };
      if (!meta.licence) continue;
      if (mood && meta.mood && meta.mood !== mood) continue;
      const id = `music-${f.replace(/[^\w-]/g, "_")}`;
      tracks.push(
        this.library.get(id) ??
          this.library.add({
            id,
            kind: "audio",
            source: "owner",
            title: meta.title ?? f,
            tags: ["music", ...(meta.mood ? [meta.mood] : [])],
            licence: meta.licence,
            credit: meta.credit ?? "",
            path: path.join(dir, f),
            bytes: fs.statSync(path.join(dir, f)).size,
          }),
      );
    }
    return tracks;
  }

  /** A bed for `duration` seconds: the least used owner track, or a synthesized one. */
  music(duration: number, mood: Mood = "calm"): MusicChoice {
    const owned = this.ownerTracks(mood).sort((a, b) => a.uses - b.uses)[0];
    if (owned) return { file: owned.path, asset: owned };
    const seconds = Math.ceil(duration);
    const id = `bed-${mood}-${seconds}`;
    const existing = this.library.get(id);
    if (existing && fs.existsSync(existing.path)) return { file: existing.path, asset: existing };
    const file = this.library.fileFor("code", `${id}.wav`);
    writeWav(file, synthBed(seconds, mood), RATE);
    const asset = this.library.add({
      id,
      kind: "audio",
      source: "code",
      title: `Ambient bed (${mood})`,
      tags: ["music", mood],
      licence: CODE_LICENCE,
      credit: "",
      path: file,
      bytes: fs.statSync(file).size,
      duration: seconds,
    });
    return { file, asset };
  }

  /** One of the stock effects, made once and reused. */
  sfx(kind: SfxKind): { file: string; duration: number } {
    const id = `sfx-${kind}`;
    const existing = this.library.get(id);
    if (existing && fs.existsSync(existing.path))
      return { file: existing.path, duration: existing.duration ?? 0.5 };
    const samples = synthSfx(kind);
    const file = this.library.fileFor("code", `${id}.wav`);
    writeWav(file, samples, RATE);
    const duration = samples.length / RATE;
    this.library.add({
      id,
      kind: "audio",
      source: "code",
      title: `Effect: ${kind}`,
      tags: ["sfx", kind],
      licence: CODE_LICENCE,
      credit: "",
      path: file,
      bytes: fs.statSync(file).size,
      duration,
    });
    return { file, duration };
  }
}
