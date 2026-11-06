import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../paths";
import { distributeWords, sentences, type WordTiming, wordsFromAlignment } from "./captions";
import { concatAudio, probeDuration, writeWav } from "./ffmpeg";
import { MediaBudgetError, type MediaHub, type MediaLane } from "./media";

/**
 * Voice-over (Stage 13): ElevenLabs first (the owner's Creator plan, word-exact timings), Kokoro-82M
 * on this laptop behind it. ElevenLabs never runs past our monthly budget or the plan's own
 * remaining credits (D-050), and a failure there falls back to Kokoro rather than stopping a video.
 */

export type VoiceProvider = "elevenlabs" | "kokoro";

export interface VoiceRequest {
  text: string;
  lane: MediaLane;
  /** Output path without extension (".mp3" or ".wav" is added). */
  out: string;
  prefer?: VoiceProvider;
  /** Drafts always use the free local voice. */
  draft?: boolean;
  /** Fail instead of falling back to Kokoro. */
  strict?: boolean;
  /** Whole-word spelling fixes for the voice, e.g. { "GIF": "jif" }. */
  pronounce?: Record<string, string>;
  /** Overrides the configured voice (an ElevenLabs voice id or a Kokoro voice name). */
  voice?: string;
}

export interface VoiceResult {
  file: string;
  duration: number;
  words: WordTiming[];
  provider: VoiceProvider;
  voice: string;
  /** Credits (ElevenLabs) or characters (Kokoro) used. */
  units: number;
  /** Why ElevenLabs was skipped, when Kokoro spoke instead. */
  fallback?: string;
}

export function applyPronunciation(text: string, map: Record<string, string> = {}): string {
  let out = text;
  for (const [word, say] of Object.entries(map)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), say);
  }
  return out;
}

/** Paragraphs, then sentences grouped into chunks of at most `max` characters. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  for (const para of text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    let current = "";
    for (const s of sentences(para)) {
      if (current && current.length + s.length + 1 > max) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current} ${s}` : s;
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const ELEVEN = "https://api.elevenlabs.io/v1";

export class ElevenLabsVoice {
  private readonly fetchImpl: typeof fetch;

  constructor(readonly opts: ElevenLabsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The plan's characters used and allowed this period (they are the credits). */
  async subscription(): Promise<{ used: number; limit: number; resetsAt: number | null }> {
    const res = await this.fetchImpl(`${ELEVEN}/user/subscription`, {
      headers: { "xi-api-key": this.opts.apiKey },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`ElevenLabs: ${detail(body) ?? `HTTP ${res.status}`}`);
    return {
      used: Number(body.character_count ?? 0),
      limit: Number(body.character_limit ?? 0),
      resetsAt: body.next_character_count_reset_unix
        ? Number(body.next_character_count_reset_unix) * 1000
        : null,
    };
  }

  async synth(
    text: string,
    context: { previous?: string; next?: string } = {},
  ): Promise<{ audio: Buffer; chars: string[]; starts: number[]; ends: number[] }> {
    const res = await this.fetchImpl(
      `${ELEVEN}/text-to-speech/${encodeURIComponent(this.opts.voiceId)}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": this.opts.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: this.opts.model,
          ...(context.previous ? { previous_text: context.previous.slice(-500) } : {}),
          ...(context.next ? { next_text: context.next.slice(0, 500) } : {}),
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      audio_base64?: string;
      alignment?: {
        characters?: string[];
        character_start_times_seconds?: number[];
        character_end_times_seconds?: number[];
      };
    } & Record<string, unknown>;
    if (!res.ok || !body.audio_base64) {
      throw new Error(`ElevenLabs: ${detail(body) ?? `HTTP ${res.status}`}`);
    }
    return {
      audio: Buffer.from(body.audio_base64, "base64"),
      chars: body.alignment?.characters ?? [],
      starts: body.alignment?.character_start_times_seconds ?? [],
      ends: body.alignment?.character_end_times_seconds ?? [],
    };
  }
}

function detail(body: Record<string, unknown>): string | undefined {
  const d = body.detail as { message?: string; status?: string } | string | undefined;
  if (typeof d === "string") return d;
  return d?.message ?? d?.status;
}

/** What kokoro-js gives back for one piece of text. */
export interface KokoroAudio {
  audio: Float32Array;
  sampling_rate: number;
}

export interface KokoroEngine {
  generate(text: string, opts: { voice: string; speed?: number }): Promise<KokoroAudio>;
}

/** Loads Kokoro-82M once (about 90 MB, cached under data/models/hf). */
export async function loadKokoro(model: string, dtype: string): Promise<KokoroEngine> {
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = path.join(DATA_DIR, "models", "hf");
  const { KokoroTTS } = await import("kokoro-js");
  const tts = await KokoroTTS.from_pretrained(model, {
    dtype: dtype as "fp32" | "fp16" | "q8" | "q4" | "q4f16",
    device: "cpu",
  });
  return {
    generate: async (text, opts) => {
      const out = await tts.generate(text, {
        voice: opts.voice as Parameters<typeof tts.generate>[1] extends { voice?: infer V }
          ? V
          : never,
        ...(opts.speed ? { speed: opts.speed } : {}),
      });
      return { audio: out.audio as Float32Array, sampling_rate: out.sampling_rate };
    },
  };
}

/** Where speech starts and ends in a clip (seconds), ignoring the quiet edges. */
export function speechSpan(samples: Float32Array, rate: number): { start: number; end: number } {
  const frame = Math.max(1, Math.round(rate * 0.01));
  const energies: number[] = [];
  let peak = 0;
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const n = Math.min(frame, samples.length - i);
    for (let j = 0; j < n; j++) sum += (samples[i + j] ?? 0) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, n));
    energies.push(rms);
    peak = Math.max(peak, rms);
  }
  const threshold = Math.max(0.005, peak * 0.06);
  const first = energies.findIndex((e) => e >= threshold);
  let last = energies.length - 1;
  while (last > 0 && (energies[last] ?? 0) < threshold) last--;
  if (first < 0) return { start: 0, end: samples.length / rate };
  return {
    start: Math.max(0, (first * frame) / rate - 0.02),
    end: Math.min(samples.length / rate, ((last + 1) * frame) / rate + 0.03),
  };
}

export interface VoiceServiceOptions {
  hub: MediaHub;
  /** Injected in tests; built from config and .env otherwise. */
  eleven?: ElevenLabsVoice | null;
  kokoro?: () => Promise<KokoroEngine>;
  /** Waits between ElevenLabs retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/** A dropped connection or a busy server, worth another try (not a refusal or a spent budget). */
export function transientError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network error|HTTP 5\d\d|HTTP 429/i.test(
    text,
  );
}

export class VoiceService {
  readonly eleven: ElevenLabsVoice | null;
  private kokoroEngine: Promise<KokoroEngine> | null = null;
  private readonly loadKokoroEngine: () => Promise<KokoroEngine>;

  constructor(private readonly opts: VoiceServiceOptions) {
    const hub = opts.hub;
    if (opts.eleven !== undefined) this.eleven = opts.eleven;
    else {
      const apiKey = hub.has("elevenlabs") ? hub.key("elevenlabs") : undefined;
      const voiceId = hub.has("elevenlabs") ? hub.envSetting("elevenlabs", "voiceEnv") : undefined;
      this.eleven =
        apiKey && voiceId
          ? new ElevenLabsVoice({
              apiKey,
              voiceId,
              model: hub.setting("elevenlabs", "model", "eleven_multilingual_v2"),
            })
          : null;
    }
    this.loadKokoroEngine =
      opts.kokoro ??
      (() =>
        loadKokoro(
          hub.setting("kokoro", "model", "onnx-community/Kokoro-82M-v1.0-ONNX"),
          hub.setting("kokoro", "dtype", "q8"),
        ));
  }

  /** ElevenLabs credits left: our budget and the plan's own count, whichever is lower. */
  async elevenCreditsLeft(): Promise<number> {
    if (!this.eleven) return 0;
    const reserve = this.opts.hub.setting("elevenlabs", "reserve", 3000);
    const sub = await this.eleven.subscription();
    return Math.max(
      0,
      Math.min(sub.limit - sub.used - reserve, this.opts.hub.monthlyLeft("elevenlabs")),
    );
  }

  async speak(req: VoiceRequest): Promise<VoiceResult> {
    const text = applyPronunciation(req.text.trim(), req.pronounce);
    if (!text) throw new Error("There is nothing to say.");
    let fallback: string | undefined;
    const wantEleven = req.prefer !== "kokoro" && !req.draft;
    if (wantEleven) {
      if (!this.eleven) fallback = "ElevenLabs isn't configured (key and voice id in .env).";
      else if (!this.opts.hub.available("elevenlabs", req.lane))
        fallback = `ElevenLabs can't serve the ${req.lane} lane.`;
      else {
        // A real video keeps its channel voice through a brief outage: three tries, 20 s and 60 s
        // apart, before Kokoro steps in (D-061).
        const waits = [20_000, 60_000];
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.speakEleven(text, req);
          } catch (err) {
            fallback = err instanceof Error ? err.message : String(err);
            const wait = waits[attempt];
            if (req.strict && (wait === undefined || !transientError(err))) throw err;
            if (wait === undefined || !transientError(err)) break;
            this.opts.log?.(`voice: ElevenLabs failed (${fallback}); trying again`);
            await (this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
          }
        }
      }
      if (req.strict && fallback) throw new Error(fallback);
      this.opts.log?.(`voice: Kokoro instead of ElevenLabs (${fallback})`);
    }
    const result = await this.speakKokoro(text, req);
    return fallback ? { ...result, fallback } : result;
  }

  private async speakEleven(text: string, req: VoiceRequest): Promise<VoiceResult> {
    const eleven = this.eleven;
    if (!eleven) throw new Error("ElevenLabs isn't configured.");
    const hub = this.opts.hub;
    const rate = hub.setting("elevenlabs", "creditsPerChar", 1);
    const cost = Math.ceil(text.length * rate);
    const left = await this.elevenCreditsLeft();
    if (cost > left) {
      throw new MediaBudgetError(
        `ElevenLabs needs ${cost} credits but only ${Math.floor(left)} are left this month after the reserve.`,
      );
    }
    const chunks = chunkText(text, 2400);
    const dir = path.dirname(req.out);
    fs.mkdirSync(dir, { recursive: true });
    const parts: string[] = [];
    const words: WordTiming[] = [];
    let offset = 0;
    let units = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? "";
      const part = `${req.out}.part${i}.mp3`;
      const r = await hub.run("elevenlabs", req.lane, async () => {
        const value = await eleven.synth(chunk, {
          ...(chunks[i - 1] ? { previous: chunks[i - 1] } : {}),
          ...(chunks[i + 1] ? { next: chunks[i + 1] } : {}),
        });
        return { value, units: Math.ceil(chunk.length * rate), unit: "credits" };
      });
      fs.writeFileSync(part, r.audio);
      units += Math.ceil(chunk.length * rate);
      words.push(...wordsFromAlignment(r.chars, r.starts, r.ends, offset));
      offset += await probeDuration(part);
      parts.push(part);
    }
    const file = `${req.out}.mp3`;
    await concatAudio(parts, file);
    for (const p of parts) if (p !== file) fs.rmSync(p, { force: true });
    return {
      file,
      duration: await probeDuration(file),
      words,
      provider: "elevenlabs",
      voice: eleven.opts.voiceId,
      units,
    };
  }

  private async speakKokoro(text: string, req: VoiceRequest): Promise<VoiceResult> {
    const hub = this.opts.hub;
    if (!this.kokoroEngine) {
      this.opts.log?.("voice: loading Kokoro-82M");
      this.kokoroEngine = this.loadKokoroEngine();
    }
    const engine = await this.kokoroEngine;
    const voice = req.voice ?? hub.setting("kokoro", "voice", "am_michael");
    const speed = hub.setting("kokoro", "speed", 1);
    const pieces: Float32Array[] = [];
    const words: WordTiming[] = [];
    let rate = 24_000;
    let offset = 0;
    let units = 0;
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const [pi, para] of paragraphs.entries()) {
      const list = sentences(para);
      for (const [si, s] of list.entries()) {
        const out = await hub.run("kokoro", req.lane, async () => ({
          value: await engine.generate(s, { voice, speed }),
          units: s.length,
          unit: "chars",
        }));
        rate = out.sampling_rate;
        const span = speechSpan(out.audio, rate);
        words.push(...distributeWords(s, offset + span.start, offset + span.end));
        pieces.push(out.audio);
        offset += out.audio.length / rate;
        units += s.length;
        const last = pi === paragraphs.length - 1 && si === list.length - 1;
        if (!last) {
          const gap = new Float32Array(Math.round(rate * (si === list.length - 1 ? 0.35 : 0.12)));
          pieces.push(gap);
          offset += gap.length / rate;
        }
      }
    }
    const total = pieces.reduce((n, p) => n + p.length, 0);
    const samples = new Float32Array(total);
    let at = 0;
    for (const p of pieces) {
      samples.set(p, at);
      at += p.length;
    }
    const file = `${req.out}.wav`;
    writeWav(file, samples, rate);
    return { file, duration: total / rate, words, provider: "kokoro", voice, units };
  }
}
