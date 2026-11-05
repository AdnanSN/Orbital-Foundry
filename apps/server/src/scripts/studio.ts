import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { openDb } from "../db";
import { loadEnv } from "../env";
import { ARTIFACTS_DIR } from "../paths";
import { chunkCaptions, sentences, toSrt, type WordTiming } from "../studio/captions";
import { writeProject } from "../studio/compose";
import { loadMediaConfig, MediaHub, MediaUsage } from "../studio/media";
import { renderProject } from "../studio/render";
import { type Scene, type Timeline, timelineSchema } from "../studio/timeline";
import { type VoiceProvider, VoiceService } from "../studio/voice";

/**
 * `npm run studio -- smoke [--voice kokoro|elevenlabs|both] [--quality draft|looks|delivery]`
 * (Stage 13): a fixed 20-second script becomes a voiced, captioned vertical short, once per voice,
 * in data/artifacts/studio/smoke/. Nothing is published; it runs in the sandbox lane.
 */

loadEnv();

const SCRIPT =
  "Every agent on this station is real. When one types, a model is thinking. When one walks to the café, a free tier just said slow down. Tonight the crew learned a new trick. Script, voice, captions and render, all on one laptop. And this video cost nothing to make.";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** A code-drawn starfield with a planet: a still that costs no image budget. */
function starfield(file: string): void {
  const W = 1080;
  const H = 1920;
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#050816");
  sky.addColorStop(1, "#1b1f4a");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 900; i++) {
    const r = rnd() < 0.92 ? rnd() * 1.6 + 0.3 : rnd() * 3 + 1.5;
    g.globalAlpha = 0.3 + rnd() * 0.7;
    g.fillStyle = rnd() < 0.15 ? "#ffd9a0" : "#ffffff";
    g.beginPath();
    g.arc(rnd() * W, rnd() * H, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  const planet = g.createRadialGradient(W * 0.62, H * 0.58, 60, W * 0.7, H * 0.66, 520);
  planet.addColorStop(0, "#ff9a5a");
  planet.addColorStop(0.5, "#c2410c");
  planet.addColorStop(1, "#1e0a05");
  g.fillStyle = planet;
  g.beginPath();
  g.arc(W * 0.7, H * 0.66, 460, 0, Math.PI * 2);
  g.fill();
  fs.writeFileSync(file, c.toBuffer("image/png"));
}

/** One scene per sentence, starting where its first word is spoken. */
function scenesFor(words: WordTiming[], duration: number, still: string): Scene[] {
  const lines = sentences(SCRIPT);
  const visuals: Scene["visual"][] = [
    { type: "title", kicker: "Orbital Foundry", title: "Every agent is real" },
    { type: "quote", text: "When one types, a model is thinking." },
    { type: "still", src: still, move: "push-in", label: "Free tiers set the pace" },
    { type: "title", title: "A new trick", subtitle: "Faceless videos, made by the crew" },
    { type: "list", index: 1, heading: "The pipeline", item: "Script · Voice · Captions · Render" },
    { type: "stat", value: 0, prefix: "$", label: "spent on this video", decimals: 0 },
  ];
  let w = 0;
  const starts: number[] = [];
  for (const line of lines) {
    starts.push(starts.length === 0 ? 0 : (words[w]?.start ?? duration));
    w += line.split(/\s+/).filter(Boolean).length;
  }
  return lines.map((_line, i) => {
    const start = starts[i] ?? 0;
    const end = starts[i + 1] ?? duration;
    return {
      start,
      duration: Math.max(0.5, end - start),
      visual: visuals[i] ?? { type: "color" },
      transition: "fade" as const,
      ...(i === 2 ? { lowerThird: { text: "Render Farm", sub: "RTX 3050 · 6 GB" } } : {}),
    };
  });
}

async function smoke(): Promise<void> {
  const which = arg("voice", "both");
  const quality = arg("quality", "looks") as "draft" | "looks" | "delivery";
  const providers: VoiceProvider[] =
    which === "both" ? ["kokoro", "elevenlabs"] : [which as VoiceProvider];
  const dir = path.join(ARTIFACTS_DIR, "studio", "smoke");
  fs.mkdirSync(dir, { recursive: true });
  const still = path.join(dir, "starfield.png");
  starfield(still);
  const db = openDb();
  const hub = new MediaHub(loadMediaConfig(), new MediaUsage(db));
  const voices = new VoiceService({ hub, log: (m) => console.log(`  ${m}`) });
  if (providers.includes("elevenlabs") && voices.eleven) {
    console.log(
      `ElevenLabs credits available to the station: ${Math.floor(await voices.elevenCreditsLeft())}`,
    );
  }
  for (const provider of providers) {
    console.log(`\n▶ ${provider}`);
    const t0 = Date.now();
    const voice = await voices.speak({
      text: SCRIPT,
      lane: "sandbox",
      out: path.join(dir, `voice-${provider}`),
      prefer: provider,
      strict: provider === "elevenlabs",
    });
    console.log(
      `  voice: ${voice.duration.toFixed(1)} s from ${voice.provider} (${voice.units} ${voice.provider === "elevenlabs" ? "credits" : "chars"}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    const duration = Math.ceil((voice.duration + 0.6) * 10) / 10;
    const timeline: Timeline = timelineSchema.parse({
      format: "short",
      duration,
      voice: { src: voice.file },
      scenes: scenesFor(voice.words, duration, still),
      captions: { chunks: chunkCaptions(voice.words), style: "karaoke" },
      progressBar: true,
      watermark: "@orbitalfoundry",
    });
    fs.writeFileSync(path.join(dir, `smoke-${provider}.srt`), toSrt(voice.words));
    const project = path.join(dir, `project-${provider}`);
    writeProject(timeline, project);
    let last = -1;
    const result = await renderProject(project, path.join(dir, `smoke-${provider}.mp4`), {
      quality,
      workers: hub.setting("hyperframes", "workers", 3),
      gpu: hub.setting("hyperframes", "gpuEncode", true),
      onProgress: (pct) => {
        const step = Math.floor(pct / 20) * 20;
        if (step !== last) {
          last = step;
          process.stdout.write(`  render ${step}%\n`);
        }
      },
    });
    hub.usage.record({
      provider: "hyperframes",
      kind: "render",
      lane: "sandbox",
      units: result.seconds,
      unit: "seconds",
      ms: Math.round(result.seconds * 1000),
      ok: true,
      ref: path.basename(result.file),
    });
    console.log(
      `  ✓ ${result.file}\n    ${result.duration.toFixed(1)} s video, ${result.width}x${result.height}, rendered in ${result.seconds.toFixed(0)} s`,
    );
  }
  db.close();
}

const cmd = process.argv[2];
if (cmd === "smoke") {
  smoke().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  console.log(
    "Usage: npm run studio -- smoke [--voice kokoro|elevenlabs|both] [--quality draft|looks|delivery]",
  );
}
