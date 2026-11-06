import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import {
  chunkCaptions,
  distributeWords,
  sentences,
  toSrt,
  wordsFromAlignment,
} from "../src/studio/captions";
import { composeTimeline } from "../src/studio/compose";
import { FFMPEG } from "../src/studio/ffmpeg";
import { loadMediaConfig, MediaHub, MediaUsage, mediaConfigSchema } from "../src/studio/media";
import { parseProgress } from "../src/studio/render";
import { timelineProblems, timelineSchema } from "../src/studio/timeline";
import {
  applyPronunciation,
  chunkText,
  ElevenLabsVoice,
  type KokoroEngine,
  speechSpan,
  VoiceService,
} from "../src/studio/voice";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-studio-"));
let silentMp3 = Buffer.alloc(0);

beforeAll(() => {
  const file = path.join(dir, "silence.mp3");
  execFileSync(FFMPEG, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-t",
    "1",
    "-c:a",
    "libmp3lame",
    file,
  ]);
  silentMp3 = fs.readFileSync(file);
});
const dbs: { close: () => void }[] = [];
afterAll(() => {
  for (const db of dbs) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function hub(env: NodeJS.ProcessEnv = {}) {
  const db = openDb(path.join(fs.mkdtempSync(path.join(dir, "db-")), "station.db"));
  dbs.push(db);
  return new MediaHub(loadMediaConfig(), new MediaUsage(db), env);
}

/** A fake Kokoro: a 0.1 s pause, then speech-like noise for 0.05 s per character. */
const fakeKokoro: KokoroEngine = {
  async generate(text) {
    const rate = 24_000;
    const lead = Math.round(rate * 0.1);
    const speech = Math.round(rate * 0.05 * text.length);
    const audio = new Float32Array(lead + speech + lead);
    for (let i = 0; i < speech; i++) audio[lead + i] = Math.sin(i / 7) * 0.4;
    return { audio, sampling_rate: rate };
  },
};

describe("media config and hub", () => {
  it("loads config/media.yaml and refuses the live lane without production: allowed", () => {
    const config = loadMediaConfig();
    expect(config.providers.elevenlabs?.lanes).toContain("live");
    const bad = mediaConfigSchema.safeParse({
      providers: {
        x: { name: "X", kind: "tts", lanes: ["live"], production: "unverified", licence: "?" },
      },
    });
    expect(bad.success).toBe(false);
  });

  it("needs a key for keyed providers and logs every call with its units", async () => {
    const h = hub({ ELEVENLABS_API_KEY: "k" });
    expect(h.available("elevenlabs", "live")).toBe(true);
    expect(hub({}).available("elevenlabs", "live")).toBe(false);
    expect(h.available("kokoro", "live")).toBe(true);
    await h.run("kokoro", "sandbox", async () => ({ value: 1, units: 40, unit: "chars" }));
    await expect(
      h.run("kokoro", "sandbox", async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(h.usage.monthUnits("kokoro")).toBe(40);
    expect(h.usage.callsToday("kokoro")).toBe(2);
    expect(h.monthlyLeft("elevenlabs")).toBe(110_000);
  });

  it("reads a voice id from either spelling of the variable", () => {
    expect(hub({ ELEVENLABSVOICE_ID: "v1" }).envSetting("elevenlabs", "voiceEnv")).toBe("v1");
    expect(
      hub({ ELEVENLABS_VOICE_ID: "v2", ELEVENLABSVOICE_ID: "v1" }).envSetting(
        "elevenlabs",
        "voiceEnv",
      ),
    ).toBe("v2");
  });
});

describe("word timings and captions", () => {
  it("groups ElevenLabs character timings into words", () => {
    const chars = [..."Hi there."];
    const starts = chars.map((_c, i) => i * 0.1);
    const ends = chars.map((_c, i) => i * 0.1 + 0.08);
    expect(wordsFromAlignment(chars, starts, ends, 2)).toEqual([
      { text: "Hi", start: 2, end: 2.18 },
      { text: "there.", start: 2.3, end: 2.88 },
    ]);
  });

  it("spreads words over a sentence in order, inside the span", () => {
    const words = distributeWords("The quick brown fox jumps.", 1, 3);
    expect(words).toHaveLength(5);
    expect(words[0]?.start).toBe(1);
    for (let i = 1; i < words.length; i++)
      expect(words[i]?.start).toBeGreaterThan(words[i - 1]?.start ?? 0);
    expect(words.at(-1)?.end).toBeLessThanOrEqual(3);
    expect(sentences("One. Two? Three!")).toEqual(["One.", "Two?", "Three!"]);
  });

  it("makes short captions that break at punctuation, and an SRT", () => {
    const words = distributeWords(
      "Every agent is real, and the crew works hard every single night.",
      0,
      4,
    );
    const chunks = chunkCaptions(words);
    expect(chunks[0]?.words.map((w) => w.text)).toEqual(["Every", "agent", "is"]);
    expect(chunks.find((c) => c.words.at(-1)?.text === "real,")).toBeTruthy();
    for (const c of chunks) expect(c.words.length).toBeLessThanOrEqual(3);
    const srt = toSrt(words);
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n/);
  });
});

describe("voice", () => {
  it("chunks long text by sentence and fixes pronunciation by whole words", () => {
    const text = `${"A short sentence here. ".repeat(30)}\n\nNew paragraph.`;
    const chunks = chunkText(text, 200);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.at(-1)).toBe("New paragraph.");
    expect(applyPronunciation("NASA and NASAL", { NASA: "nassa" })).toBe("nassa and NASAL");
  });

  it("finds speech inside quiet edges", () => {
    const rate = 1000;
    const s = new Float32Array(1000);
    for (let i = 300; i < 700; i++) s[i] = 0.5;
    const span = speechSpan(s, rate);
    expect(span.start).toBeCloseTo(0.28, 1);
    expect(span.end).toBeCloseTo(0.73, 1);
  });

  it("speaks with Kokoro and times every word", async () => {
    const voices = new VoiceService({ hub: hub(), eleven: null, kokoro: async () => fakeKokoro });
    const r = await voices.speak({
      text: "Hello there. General Kenobi.\n\nNew line.",
      lane: "live",
      out: path.join(dir, "k1"),
    });
    expect(r.provider).toBe("kokoro");
    expect(r.fallback).toMatch(/isn't configured/);
    expect(r.words.map((w) => w.text)).toEqual([
      "Hello",
      "there.",
      "General",
      "Kenobi.",
      "New",
      "line.",
    ]);
    expect(r.words.at(-1)?.end).toBeLessThanOrEqual(r.duration);
    expect(fs.statSync(r.file).size).toBeGreaterThan(44);
  });

  function fakeEleven(used: number, limit: number, dropFirst = 0) {
    const calls: string[] = [];
    let drops = dropFirst;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (drops > 0 && url.includes("text-to-speech")) {
        drops -= 1;
        throw new TypeError("fetch failed");
      }
      if (url.endsWith("/user/subscription")) {
        return Response.json({ character_count: used, character_limit: limit });
      }
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      const chars = [...text];
      return Response.json({
        audio_base64: silentMp3.toString("base64"),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_c, i) => i * 0.02),
          character_end_times_seconds: chars.map((_c, i) => i * 0.02 + 0.015),
        },
      });
    }) as typeof fetch;
    return {
      calls,
      voice: new ElevenLabsVoice({ apiKey: "k", voiceId: "v", model: "m", fetchImpl }),
    };
  }

  it("uses ElevenLabs when credits allow, with word-exact timings", async () => {
    const h = hub({ ELEVENLABS_API_KEY: "k" });
    const eleven = fakeEleven(1000, 121_000);
    const voices = new VoiceService({
      hub: h,
      eleven: eleven.voice,
      kokoro: async () => fakeKokoro,
    });
    const r = await voices.speak({
      text: "Every agent is real.",
      lane: "live",
      out: path.join(dir, "e1"),
    });
    expect(r.provider).toBe("elevenlabs");
    expect(r.units).toBe(20);
    expect(r.words.map((w) => w.text)).toEqual(["Every", "agent", "is", "real."]);
    expect(r.words[1]?.start).toBeCloseTo(0.12, 5);
    expect(h.usage.monthUnits("elevenlabs")).toBe(20);
  });

  it("keeps the ElevenLabs voice through a dropped connection, and says when it gave up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const flaky = fakeEleven(1000, 121_000, 1);
    const voices = new VoiceService({
      hub: hub({ ELEVENLABS_API_KEY: "k" }),
      eleven: flaky.voice,
      kokoro: async () => fakeKokoro,
      sleep,
    });
    const r = await voices.speak({
      text: "Every agent is real.",
      lane: "live",
      out: path.join(dir, "e3"),
    });
    expect(r.provider).toBe("elevenlabs");
    expect(waits).toEqual([20_000]);

    const down = fakeEleven(1000, 121_000, 5);
    const offline = new VoiceService({
      hub: hub({ ELEVENLABS_API_KEY: "k" }),
      eleven: down.voice,
      kokoro: async () => fakeKokoro,
      sleep,
    });
    const k = await offline.speak({
      text: "Every agent is real.",
      lane: "live",
      out: path.join(dir, "e4"),
    });
    expect(k.provider).toBe("kokoro");
    expect(k.fallback).toMatch(/fetch failed/);
    expect(waits).toEqual([20_000, 20_000, 60_000]);
  });

  it("stops short of the plan's credits and falls back to Kokoro", async () => {
    const eleven = fakeEleven(119_000, 121_000);
    const voices = new VoiceService({
      hub: hub({ ELEVENLABS_API_KEY: "k" }),
      eleven: eleven.voice,
      kokoro: async () => fakeKokoro,
    });
    const r = await voices.speak({
      text: "Every agent is real.",
      lane: "live",
      out: path.join(dir, "e2"),
    });
    expect(r.provider).toBe("kokoro");
    expect(r.fallback).toMatch(/credits/);
    expect(eleven.calls.some((u) => u.includes("text-to-speech"))).toBe(false);
    await expect(
      voices.speak({
        text: "Every agent is real.",
        lane: "live",
        out: path.join(dir, "e3"),
        prefer: "elevenlabs",
        strict: true,
      }),
    ).rejects.toThrow(/credits/);
  });
});

describe("timeline and composition", () => {
  const base = {
    format: "short" as const,
    duration: 4,
    voice: { src: "C:/x/voice.wav" },
    scenes: [
      {
        start: 0,
        duration: 2,
        visual: { type: "title" as const, title: "Every agent is real", kicker: "Hi" },
      },
      {
        start: 2,
        duration: 2,
        visual: { type: "still" as const, src: "C:/x/a b.png", move: "pan-left" as const },
        lowerThird: { text: "Render Farm" },
      },
    ],
    captions: {
      chunks: chunkCaptions(distributeWords("Every agent is real. Really.", 0, 3.8)),
    },
    progressBar: true,
  };

  it("checks that scenes cover the video without gaps", () => {
    expect(timelineProblems(timelineSchema.parse(base))).toEqual([]);
    const gap = timelineSchema.parse({ ...base, duration: 5 });
    expect(timelineProblems(gap)[0]).toMatch(/end at 4.00s/);
    expect(() => composeTimeline(gap)).toThrow(/doesn't add up/);
  });

  it("writes timed clips, karaoke captions, audio and a paused GSAP timeline", () => {
    const { html, assets } = composeTimeline(timelineSchema.parse(base));
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-width="1080" data-height="1920"');
    // The first scene runs on under the second one's fade.
    expect(html).toContain(
      'id="s0" class="clip scene" style="z-index:1" data-start="0" data-duration="2.35"',
    );
    expect(html).toMatch(
      /<audio id="vo" src="assets\/001-voice.wav" data-start="0" data-duration="4"/,
    );
    expect(assets.map((a) => a.to)).toEqual(["assets/000-a_b.png", "assets/001-voice.wav"]);
    expect(html).toContain('tl.set("#c0w0", { color: "#ffd23f", scale: 1.06 }, 0);');
    expect(html).toContain("xPercent: -4");
    expect(html).toContain('class="clip lt"');
    expect(html).toContain('window.__timelines["main"] = tl;');
    expect(html).not.toMatch(/Math\.random|Date\.now/);
  });

  it("escapes text", () => {
    const t = timelineSchema.parse({
      ...base,
      scenes: [{ start: 0, duration: 4, visual: { type: "quote", text: '<b>"Hi"</b> & bye' } }],
      captions: undefined,
    });
    expect(composeTimeline(t).html).toContain("&lt;b&gt;&quot;Hi&quot;&lt;/b&gt; &amp; bye");
  });
});

describe("render", () => {
  it("reads HyperFrames' progress lines", () => {
    expect(parseProgress('@hf-progress {"code":"encode","done":90,"total":90,"pct":90}')).toEqual({
      pct: 90,
      code: "encode",
    });
    expect(parseProgress("  ████ 75% Encoding video")).toBeNull();
  });
});
