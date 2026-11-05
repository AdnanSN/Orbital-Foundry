import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { loadBlocklist } from "../creative/config";
import { openDb } from "../db";
import { loadEnv } from "../env";
import { ARTIFACTS_DIR, DATA_DIR } from "../paths";
import { createStation } from "../station";
import { chunkCaptions, sentences, toSrt, type WordTiming } from "../studio/captions";
import { writeProject } from "../studio/compose";
import { type Asset, AssetLibrary, creditsText } from "../studio/library";
import { loadMediaConfig, MediaHub, MediaUsage } from "../studio/media";
import { renderProject } from "../studio/render";
import { SoundKit } from "../studio/sound";
import { generateStill } from "../studio/stills";
import { mediaStartFor, minClipFor, StockService } from "../studio/stock";
import { type CameraMove, type Scene, type Timeline, timelineSchema } from "../studio/timeline";
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

type DemoShot =
  | { kind: "stock"; type: "image" | "video"; prefer: string; query: string; move?: CameraMove }
  | { kind: "ai"; prompt: string }
  | { kind: "stat"; value: number; decimals: number; suffix: string; label: string }
  | { kind: "code" };

/** Stage 14's demo: one sentence per shot, every kind of source in one short. */
const SPACE_DEMO: { text: string; shot: DemoShot }[] = [
  {
    text: "Saturn's rings are mostly water ice, and in places they are only about ten meters thick.",
    shot: {
      kind: "stock",
      type: "image",
      prefer: "nasa",
      query: "Saturn rings Cassini",
      move: "push-in",
    },
  },
  {
    text: "On a clear night, far from city lights, you can see around two thousand five hundred stars with your own eyes.",
    shot: { kind: "stock", type: "video", prefer: "pixabay", query: "starry night sky" },
  },
  {
    text: "Astronomers have pointed telescopes at the sky for four centuries, and they still find something new every year.",
    shot: {
      kind: "stock",
      type: "image",
      prefer: "openverse",
      query: "observatory telescope",
      move: "pan-left",
    },
  },
  {
    text: "Artists imagine what it would feel like to stand beneath another planet's sky.",
    shot: {
      kind: "ai",
      prompt:
        "a lone astronaut standing on a rocky moon, looking up at a huge ringed planet that fills the sky",
    },
  },
  {
    text: "Rockets made the trip real. Since 1957, people have launched thousands of satellites.",
    shot: { kind: "stock", type: "video", prefer: "nasa", query: "rocket launch" },
  },
  {
    text: "The universe is about thirteen point eight billion years old.",
    shot: {
      kind: "stat",
      value: 13.8,
      decimals: 1,
      suffix: " bn",
      label: "years since the Big Bang",
    },
  },
  { text: "And all of it began with someone simply looking up.", shot: { kind: "code" } },
];

async function sources(): Promise<void> {
  const quality = arg("quality", "looks") as "draft" | "looks" | "delivery";
  const dir = path.join(ARTIFACTS_DIR, "studio", "sources");
  fs.mkdirSync(dir, { recursive: true });
  const station = createStation();
  const hub = new MediaHub(loadMediaConfig(), new MediaUsage(station.db));
  const library = new AssetLibrary(station.db, path.join(DATA_DIR, "library"));
  const log = (m: string) => console.log(`  ${m}`);
  const stock = new StockService({ hub, library, db: station.db, log });
  const kit = new SoundKit(library);
  const voices = new VoiceService({ hub, log });
  const lane = "sandbox" as const;
  const script = SPACE_DEMO.map((s) => s.text).join(" ");
  const voice = await voices.speak({
    text: script,
    lane,
    out: path.join(dir, "voice"),
    prefer: "kokoro",
  });
  console.log(`voice: ${voice.duration.toFixed(1)} s (${voice.provider})`);
  const duration = Math.ceil((voice.duration + 0.8) * 10) / 10;
  // Scene boundaries: where each sentence's first word is spoken.
  const starts: number[] = [];
  let w = 0;
  for (const s of SPACE_DEMO) {
    starts.push(starts.length === 0 ? 0 : (voice.words[w]?.start ?? duration));
    w += s.text.split(/\s+/).filter(Boolean).length;
  }
  const backup = path.join(dir, "starfield.png");
  starfield(backup);
  const used: Asset[] = [];
  const scenes: Scene[] = [];
  const sfx: Timeline["sfx"] = [];
  for (const [i, s] of SPACE_DEMO.entries()) {
    const start = starts[i] ?? 0;
    const dur = Math.max(0.6, (starts[i + 1] ?? duration) - start);
    let visual: Scene["visual"] = { type: "still", src: backup, move: "drift" };
    const shot = s.shot;
    try {
      if (shot.kind === "stock") {
        const asset = await stock.fetch({
          kind: shot.type,
          query: shot.query,
          lane,
          orientation: "portrait",
          prefer: [shot.prefer],
          exclude: used.map((a) => a.id),
          ...(shot.type === "video" ? { minDuration: minClipFor(shot.prefer, dur) } : {}),
        });
        if (asset) {
          used.push(asset);
          visual =
            asset.kind === "video"
              ? {
                  type: "video",
                  src: asset.path,
                  mediaStart: mediaStartFor(asset, dur),
                  ...(asset.credit ? { credit: asset.credit } : {}),
                }
              : {
                  type: "still",
                  src: asset.path,
                  move: shot.move ?? "push-in",
                  ...(asset.credit ? { credit: asset.credit } : {}),
                };
          console.log(
            `shot ${i + 1}: ${asset.source} ${asset.kind} "${(asset.title ?? "").slice(0, 50)}"`,
          );
        } else console.log(`shot ${i + 1}: nothing found for "${shot.query}", using the starfield`);
      } else if (shot.kind === "ai") {
        const asset = await generateStill(
          station.images,
          library,
          { prompt: shot.prompt, lane, orientation: "portrait" },
          loadBlocklist(),
        );
        used.push(asset);
        visual = { type: "still", src: asset.path, move: "tilt-up" };
        console.log(`shot ${i + 1}: AI still (${asset.licence})`);
      } else if (shot.kind === "stat") {
        visual = {
          type: "stat",
          value: shot.value,
          decimals: shot.decimals,
          suffix: shot.suffix,
          label: shot.label,
        };
        {
          const fx = kit.sfx("pop");
          sfx.push({ src: fx.file, duration: fx.duration, start: start + 0.1, volume: 0.5 });
        }
        console.log(`shot ${i + 1}: motion graphic (stat)`);
      } else console.log(`shot ${i + 1}: code-drawn still`);
    } catch (err) {
      console.log(
        `shot ${i + 1}: ${err instanceof Error ? err.message : String(err)}; using the starfield`,
      );
    }
    if (i > 0) {
      const fx = kit.sfx("whoosh");
      sfx.push({
        src: fx.file,
        duration: fx.duration,
        start: Math.max(0, start - 0.25),
        volume: 0.35,
      });
    }
    scenes.push({
      start,
      duration: dur,
      visual,
      transition: "fade",
      ...(i === 0 ? { lowerThird: { text: "Space facts", sub: "Orbital Foundry Studio" } } : {}),
    });
  }
  const music = kit.music(duration, "space");
  used.push(music.asset);
  const timeline: Timeline = timelineSchema.parse({
    format: "short",
    duration,
    voice: { src: voice.file },
    music: { src: music.file, volume: 0.14 },
    sfx,
    scenes,
    captions: { chunks: chunkCaptions(voice.words), style: "karaoke" },
    progressBar: true,
    watermark: "@orbitalfoundry",
  });
  const project = path.join(dir, "project");
  writeProject(timeline, project);
  const result = await renderProject(project, path.join(dir, "sources-demo.mp4"), {
    quality,
    workers: hub.setting("hyperframes", "workers", 3),
    gpu: hub.setting("hyperframes", "gpuEncode", true),
  });
  library.markUsed(used.map((a) => a.id));
  const credits = creditsText(used);
  fs.writeFileSync(path.join(dir, "credits.txt"), `${credits}\n\nNarration: AI voice.\n`);
  fs.writeFileSync(path.join(dir, "sources-demo.srt"), toSrt(voice.words));
  console.log(
    `✓ ${result.file}: ${result.duration.toFixed(1)} s, rendered in ${result.seconds.toFixed(0)} s`,
  );
  console.log(`credits:\n${credits || "(none needed)"}`);
  station.close();
}

const cmd = process.argv[2];
const commands: Record<string, () => Promise<void>> = { smoke, sources };
const run = cmd ? commands[cmd] : undefined;
if (run) {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  console.log(
    "Usage: npm run studio -- smoke [--voice kokoro|elevenlabs|both] [--quality draft|looks|delivery]\n       npm run studio -- sources [--quality ...]   (a short that uses every visual source)",
  );
}
