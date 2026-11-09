import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { Approval } from "@orbital/shared";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import type { ModelRouter } from "../src/llm/router";
import { distributeWords } from "../src/studio/captions";
import { type Channel, channelSchema } from "../src/studio/channel";
import {
  beatTimes,
  chapters,
  drawStarfield,
  EditBay,
  type EditBayDeps,
  hookEndTime,
  keyTerms,
  pacedSpan,
  screenWords,
} from "../src/studio/editbay";
import { writeWav } from "../src/studio/ffmpeg";
import { type GpuJob, gpuConfigSchema } from "../src/studio/gpu";
import { type Asset, AssetLibrary } from "../src/studio/library";
import type { ScreeningReport } from "../src/studio/screening";
import { judge, parseIntervals } from "../src/studio/screening";
import { SoundKit } from "../src/studio/sound";
import type { StockRequest } from "../src/studio/stock";
import type { VoiceRequest } from "../src/studio/voice";
import type { Beat, ScriptDoc, WritersRoom } from "../src/studio/writers";
import type { WorkDirector } from "../src/work/director";
import { WorkStore } from "../src/work/store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-editbay-"));
const dbs: { close: () => void }[] = [];
afterAll(() => {
  for (const db of dbs) db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const channel: Channel = channelSchema.parse({
  id: "phenomena",
  status: "active",
  name: "Orbital Foundry Studio",
  handle: "@orbitalfoundry",
  niche: "Rare phenomena of Earth and space",
  audience: "Curious adults",
  persona: "A calm narrator; the narration is an AI voice.",
  style: { tone: "Clear" },
  voice: { kokoro: "am_michael", pronounce: { NASA: "N A S A" } },
  sources: { prefer: ["nasa", "pixabay", "openverse"] },
});

const beat = (
  narration: string,
  kind: Beat["visual"]["kind"],
  extra: Partial<Beat["visual"]> = {},
): Beat => ({
  narration,
  visual: { kind, ...extra },
});

function script(format: "short" | "long", status: ScriptDoc["status"] = "approved"): ScriptDoc {
  const beats =
    format === "short"
      ? [
          beat("Ball lightning is a glowing sphere that drifts through the air.", "stock-video", {
            query: "lightning storm",
          }),
          beat("It can last ten seconds.", "stat", {
            value: 10,
            suffix: " s",
            label: "the longest reports",
          }),
          beat("NASA has studied the physics of plasma for decades.", "ai-still", {
            prompt: "a glowing plasma ball in a dark room",
          }),
          beat("And it is still not fully explained.", "code"),
        ]
      : Array.from({ length: 6 }, (_x, i) =>
          i % 2 === 0
            ? beat(
                `Part ${i}. ${"This section explains one more piece of the puzzle in plain words. ".repeat(3)}`,
                "title",
                { text: `Part ${i}` },
              )
            : beat(
                "Footage shows what the narration describes, one idea at a time.",
                "stock-image",
                { query: "aurora sky" },
              ),
        );
  const at = new Date(0).toISOString();
  return {
    id: "S-1",
    channel: channel.id,
    format,
    status,
    version: 1,
    ideaId: null,
    idea: { title: "Ball lightning", angle: "How we know" },
    titles: ["The lightning that floats"],
    hooks: ["A glowing ball drifts through a kitchen."],
    beats,
    description: "What ball lightning is and how we know.",
    tags: ["science", "lightning"],
    thumbnails: [{ text: "IT FLOATS", idea: "glowing sphere" }],
    brief: {
      sources: [{ title: "Ball lightning", url: "https://en.wikipedia.org/wiki/Ball_lightning" }],
      facts: [],
    },
    checks: { words: 40, unsupported: [], banned: [], sameness: 0, problems: [] },
    artifactId: "D-SCRIPT",
    createdAt: at,
    updatedAt: at,
  };
}

function png(file: string): string {
  const c = createCanvas(64, 64);
  c.getContext("2d").fillRect(0, 0, 64, 64);
  fs.writeFileSync(file, c.toBuffer("image/png"));
  return file;
}

function setup(
  doc: ScriptDoc,
  opts: {
    cuts?: { from: number; to: number; hook: string; title: string }[];
    gpu?: EditBayDeps["gpu"];
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(root, "e-"));
  const db = openDb(path.join(dir, "station.db"));
  dbs.push(db);
  const store = new WorkStore(db);
  const library = new AssetLibrary(db, path.join(dir, "library"));
  const asset = (id: string, source: string, kind: "image" | "video"): Asset =>
    library.add({
      id,
      kind,
      source,
      tags: ["x"],
      licence: "L",
      credit: source === "nasa" ? "NASA" : "",
      path: png(path.join(dir, `${id}.png`)),
      bytes: 10,
    });
  const stockCalls: StockRequest[] = [];
  const stock = {
    fetch: async (req: StockRequest) => {
      stockCalls.push(req);
      return req.kind === "video" ? null : asset(`img-${stockCalls.length}`, "nasa", "image");
    },
  };
  const voices = {
    speak: async (req: VoiceRequest) => {
      const text = req.text.replace(/\bNASA\b/g, "N A S A");
      const words = text.split(/\n\n/).flatMap((p, i) => distributeWords(p, i * 3, i * 3 + 2.6));
      const file = `${req.out}.wav`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeWav(file, new Float32Array(2400), 24_000);
      return {
        file,
        duration: (words.at(-1)?.end ?? 1) + 0.2,
        words,
        provider: "kokoro" as const,
        voice: "am_michael",
        units: text.length,
      };
    },
  };
  const desk: Approval[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  const director = {
    fileDeskItem: (f: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">) => {
      const a = {
        ...f,
        id: `A-${desk.length + 1}`,
        status: "pending",
        createdAt: 0,
        decidedAt: null,
        note: null,
      } as Approval;
      desk.push(a);
      return a;
    },
    onDecision: (h: (a: Approval) => void | Promise<void>) => hooks.push(h),
  } as unknown as WorkDirector;
  const writers = {
    script: () => doc,
    channel: () => channel,
    scripts: () => [doc],
  } as unknown as WritersRoom;
  const router = {
    generate: async () => ({
      data: { cuts: opts.cuts ?? [] },
      text: "",
      provider: "fake",
      model: "m",
      lane: "live",
    }),
  } as unknown as ModelRouter;
  const renders: string[] = [];
  const bay = new EditBay({
    writers,
    router,
    voices,
    stock,
    stills: async () => asset(`gen-${stockCalls.length}`, "generated", "image"),
    library,
    kit: new SoundKit(library),
    store,
    db,
    director,
    ...(opts.gpu ? { gpu: opts.gpu } : {}),
    lane: "live",
    dir: path.join(dir, "videos"),
    render: async (project, out) => {
      renders.push(fs.readFileSync(path.join(project, "index.html"), "utf8"));
      fs.writeFileSync(out, "mp4");
      return { file: out, seconds: 2, duration: 12 };
    },
    frame: async (_file, _t, out) => {
      png(out);
    },
    screen: async (input): Promise<ScreeningReport> => ({
      black: [],
      frozen: [],
      silent: [],
      lufs: -14,
      truePeak: -1.5,
      ipHits: [],
      syntheticMedia: input.realisticAi,
      problems: [],
      ok: true,
    }),
  });
  const decide = async (
    a: Approval,
    status: "approved" | "rejected",
    note: string | null = null,
  ) => {
    for (const h of hooks) await h({ ...a, status, note });
  };
  return { bay, desk, store, stockCalls, renders, decide };
}

describe("edit bay helpers", () => {
  it("times beats from the words, counting pronunciation fixes", () => {
    const beats = [beat("NASA saw it.", "code"), beat("Then it was gone.", "code")];
    // "NASA" is spoken as three words ("N A S A" has four tokens), so the second beat starts later.
    const words = distributeWords("N A S A saw it.", 0, 2).concat(
      distributeWords("Then it was gone.", 2.4, 4),
    );
    const t = beatTimes(beats, words, 4.5, { NASA: "N A S A" });
    expect(t[0]).toEqual({ start: 0, end: 2.4 });
    expect(t[1]?.end).toBe(4.5);
  });

  it("writes chapters only when there are at least three, ten seconds apart", () => {
    const beats = [
      beat("a", "title", { text: "One" }),
      beat("b", "title", { text: "Two" }),
      beat("c", "title", { text: "Three" }),
    ];
    expect(chapters(beats, [{ start: 0 }, { start: 30 }, { start: 75 }])).toBe(
      "0:00 Intro\n0:30 Two\n1:15 Three",
    );
    expect(chapters(beats, [{ start: 0 }, { start: 5 }, { start: 8 }])).toBe("");
  });

  it("draws a starfield and reads FFmpeg's detector lines", () => {
    const file = path.join(root, "sf.png");
    drawStarfield(file, 3, "short", "#000", "#123");
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
    expect(
      parseIntervals("[blackdetect] black_start:3.2 black_end:4.5 black_duration:1.3", "black"),
    ).toEqual([{ start: 3.2, end: 4.5 }]);
    expect(
      parseIntervals(
        "silence_start: 10.5\nfoo\nsilence_end: 13 | silence_duration: 2.5",
        "silence",
      ),
    ).toEqual([{ start: 10.5, end: 13 }]);
    const report = judge(
      { duration: 20, words: "", realisticAi: false },
      {
        black: [
          { start: 0, end: 0.3 },
          { start: 8, end: 9 },
        ],
        frozen: [],
        silent: [],
        lufs: -18,
        truePeak: -1,
      },
      [],
    );
    expect(report.problems).toEqual(["Black frames at 8.0s.", "Loudness -18.0 LUFS (target -14)."]);
  });
});

// Real composition, canvas and sound synthesis: slow on a laptop that is also rendering.
describe("edit bay", { timeout: 30_000 }, () => {
  it("refuses unapproved scripts unless it's a test render", () => {
    const { bay } = setup(script("short", "review"));
    expect(() => bay.produce("S-1")).toThrow(/approve it at the Owner's Desk/);
    expect(bay.produce("S-1", { test: true }).test).toBe(true);
  });

  it("makes a short: fallbacks, captions, package and a Desk item with a player", async () => {
    const { bay, desk, store, stockCalls, renders } = setup(script("short"));
    const v = await bay.settled(bay.produce("S-1").id);
    expect(v?.status).toBe("review");
    // Footage was wanted for the first beat; none was found, so a photo stood in.
    expect(v?.shots[0]).toMatchObject({ want: "stock-video", got: "stock-image" });
    expect(v?.shots[0]?.fallback).toMatch(/no stock-video/);
    expect(stockCalls[0]).toMatchObject({
      kind: "video",
      orientation: "portrait",
      prefer: ["nasa", "pixabay", "openverse"],
    });
    // The opening beat (the hook) is cut in two quick shots; the rest follow the shot list.
    expect(v?.shots.map((s) => s.got)).toEqual([
      "stock-image",
      "stock-image",
      "stat",
      "ai-still",
      "code",
    ]);
    expect(renders[0]).toContain('class="clip cap"');
    expect(renders[0]).toContain('id="progress"');
    expect(v?.disclosure.syntheticMedia).toBe(true);
    expect(v?.description).toContain(
      "Sources:\nBall lightning: https://en.wikipedia.org/wiki/Ball_lightning",
    );
    expect(v?.description).toContain("NASA does not endorse this video.");
    expect(v?.description).toMatch(/Narration: AI voice\.$/);
    const meta = JSON.parse(fs.readFileSync(v?.metadata ?? "", "utf8"));
    expect(meta.youtube.containsSyntheticMedia).toBe(true);
    expect(meta.tiktok.isAigc).toBe(true);
    expect(fs.existsSync(v?.thumbnail ?? "")).toBe(true);
    expect(desk[0]?.title).toBe("Video ready: The lightning that floats");
    expect(store.artifact(desk[0]?.artifactId ?? "")?.content).toContain(`<!-- video:${v?.id} -->`);
  });

  it("makes long-form without burned captions, then the shorts the model picks", async () => {
    const { bay, renders } = setup(script("long"), {
      cuts: [{ from: 1, to: 2, hook: "Auroras sing, sort of.", title: "The singing aurora" }],
    });
    const main = bay.produce("S-1");
    await bay.settled(main.id);
    const all = bay.videos();
    expect(all.find((v) => v.id === main.id)?.format).toBe("long");
    expect(renders[0]).not.toContain('class="clip cap"');
    expect(renders[0]).toContain('data-width="1920"');
    const cut = all.find((v) => v.kind === "cutdown");
    expect(cut).toMatchObject({
      format: "short",
      parentId: main.id,
      title: "The singing aurora",
      status: "review",
    });
    // The cut-down opens on a real shot with its hook's words on screen, not on a title card.
    expect(cut?.shots[0]?.want).not.toBe("title");
    expect(renders[1]).toContain('<div class="hook-t">THE SINGING AURORA</div>');
  });

  it("opens on the hook: its words on screen, a hit, and quick first cuts", async () => {
    const doc = script("short");
    doc.hook = {
      line: "Ball lightning is a glowing sphere that drifts through the air.",
      text: "IT FLOATS",
    };
    const { bay, renders } = setup(doc);
    const v = await bay.settled(bay.produce("S-1").id);
    expect(v?.status).toBe("review");
    expect(renders[0]).toContain('id="hook"');
    expect(renders[0]).toContain('<div class="hook-t">IT FLOATS</div>');
    expect(renders[0]).toMatch(/<audio id="fx0"[^>]*data-start="0"/);
    // The first beat's footage is cut into pieces of at most 2.5 s.
    const opening = (v?.shots ?? []).filter((s) => s.beat === 0);
    expect(opening.every((s) => s.duration <= 2.5 + 1e-6)).toBe(true);
  });

  it("approves a real video for posting, but never a test render", async () => {
    const { bay, desk, decide } = setup(script("short"));
    const real = await bay.settled(bay.produce("S-1").id);
    await decide(desk[0] as Approval, "approved");
    expect(bay.video(real?.id ?? "")?.status).toBe("approved");
    const test = await bay.settled(bay.produce("S-1", { test: true }).id);
    await decide(desk[1] as Approval, "approved");
    expect(bay.video(test?.id ?? "")?.status).toBe("review");
    expect(desk[1]?.title).toMatch(/^\[Test render\] /);
  });

  it("waits for the GPU lane's AI clip, then cuts with it or falls back when it's late", async () => {
    const prompt = "a glowing sphere drifting down a dark corridor";
    const withClip = (ready: boolean) => {
      const doc = script("short");
      doc.beats[0] = beat("A glowing ball drifts through a dark kitchen.", "ai-video", { prompt });
      const requested: string[] = [];
      let settled = false;
      const clipFile = png(path.join(root, `clip-${ready}.mp4`));
      const gpu: EditBayDeps["gpu"] = {
        config: gpuConfigSchema.parse({}),
        request: (scriptId, beatNo, shot) => {
          requested.push(`${scriptId}:${beatNo}:${shot.orientation}`);
          return { id: "G-1" } as GpuJob;
        },
        settled: () => settled,
        clip: (_id, p) =>
          settled && ready && p === prompt
            ? {
                id: "gen-G-1",
                kind: "video",
                source: "generated",
                sourceId: "comfyui-video",
                tags: [],
                licence: "Apache-2.0",
                credit: "",
                path: clipFile,
                uses: 0,
                createdAt: "",
              }
            : null,
      };
      const t = setup(doc, { gpu });
      return { ...t, requested, settle: () => (settled = true) };
    };

    const a = withClip(true);
    const waiting = a.bay.produce("S-1");
    expect(waiting.status).toBe("waiting");
    expect(a.requested).toEqual(["S-1:0:portrait"]);
    expect(a.desk).toHaveLength(0);
    a.settle();
    a.bay.resume("S-1");
    const made = await a.bay.settled(waiting.id);
    expect(made?.status).toBe("review");
    expect(made?.shots[0]).toMatchObject({ want: "ai-video", got: "ai-video", assetId: "gen-G-1" });
    expect(made?.disclosure.syntheticMedia).toBe(true);
    // The clip's motion carries the whole 3 s opening beat.
    expect(made?.shots.filter((s) => s.beat === 0)).toHaveLength(1);

    // A late clip: the shot falls back to footage or a still with a camera move, on time.
    const b = withClip(false);
    const late = b.bay.produce("S-1");
    b.settle();
    b.bay.resume("S-1");
    const done = await b.bay.settled(late.id);
    expect(done?.status).toBe("review");
    expect(done?.shots[0]?.want).toBe("ai-video");
    expect(["stock-video", "ai-still", "stock-image"]).toContain(done?.shots[0]?.got);
    // Without the clip, the opening cuts at the hook's pace (2.5 s at most), not the clip's 5 s.
    const opener = done?.shots.filter((s) => s.beat === 0) ?? [];
    expect(opener).toHaveLength(2);
    for (const s of opener) expect(s.duration).toBeLessThanOrEqual(2.5);

    // Test renders never wait for the GPU.
    const c = withClip(true);
    const test = c.bay.produce("S-1", { test: true });
    expect(test.status).toBe("producing");
    expect(c.requested).toEqual([]);
    expect((await c.bay.settled(test.id))?.status).toBe("review");
  });
});

describe("shot queries and stats", () => {
  it("builds searches from a line's proper nouns and longest words", () => {
    expect(keyTerms("Its orbit around the Sun lasts 224.7 Earth days, almost twice as long.")).toBe(
      "Sun Earth around",
    );
    // A month is not what a shot is about.
    expect(keyTerms("As of January 2021, 31 confirmed magnetars have been found.")).toBe(
      "confirmed magnetars found",
    );
  });

  it("times the hook from its words and keeps its screen words short", () => {
    const words = distributeWords("NASA saw it twice. Then nothing for years.", 0, 4);
    // "NASA" is spoken as four words, so the hook "NASA saw it twice." ends on its seventh word.
    expect(hookEndTime("NASA saw it twice.", words, { NASA: "N A S A" })).toBeCloseTo(
      (words[6]?.end ?? 0) + 0.25,
      2,
    );
    expect(hookEndTime("Hi.", [], {})).toBe(2.75);
    expect(screenWords("The 15-microsecond mystery of fast radio bursts!")).toBe(
      "THE 15-MICROSECOND MYSTERY OF FAST",
    );
  });

  it("cuts quickly while the hook plays, then settles", () => {
    // A 12.7 s opening beat: 2.5 s cuts for the first 5 s, then two of 3.85 s (not six of 2.1 s).
    const cuts = pacedSpan(0, 12.7, 2.5, 5).map((p) => Math.round(p.dur * 100) / 100);
    expect(cuts).toEqual([2.5, 2.5, 3.85, 3.85]);
    // A beat that ends with the hook is cut quickly throughout.
    expect(pacedSpan(0, 5.3, 2.5, 5)).toHaveLength(3);
    // Later beats are never in a hurry.
    expect(pacedSpan(20, 12, 7, Number.POSITIVE_INFINITY)).toHaveLength(2);
  });

  it("shrinks long stats to fit and spaces their units", async () => {
    const { composeTimeline } = await import("../src/studio/compose");
    const { timelineSchema } = await import("../src/studio/timeline");
    const html = composeTimeline(
      timelineSchema.parse({
        format: "short",
        duration: 3,
        scenes: [
          {
            start: 0,
            duration: 3,
            visual: {
              type: "stat",
              value: 116.75,
              decimals: 1,
              suffix: "days",
              label: "a day on Venus",
            },
          },
        ],
      }),
    ).html;
    const size = Number(/class="stat" style="font-size:(\d+)px"/.exec(html)?.[1]);
    expect(size).toBeLessThan(216);
    expect(size * 0.62 * "116.8 days".length).toBeLessThanOrEqual(1080 * 0.86 + 1);
    expect(html).toContain("</span> days</div>");
  });

  it("writes big stats the way people say them", async () => {
    const { composeTimeline, statText } = await import("../src/studio/compose");
    const { timelineSchema } = await import("../src/studio/timeline");
    expect(statText(1_500_000, 0)).toBe("1.5 million");
    expect(statText(2.3e9, 0)).toBe("2.3 billion");
    expect(statText(30_000, 0)).toBe("30,000");
    expect(statText(2020, 0)).toBeNull();
    const html = composeTimeline(
      timelineSchema.parse({
        format: "short",
        duration: 3,
        scenes: [
          {
            start: 0,
            duration: 3,
            visual: { type: "stat", value: 1_500_000, suffix: "Jy ms", label: "fluence" },
          },
        ],
      }),
    ).html;
    expect(html).toContain('<span id="s0-n">1.5 million</span> Jy ms');
    // A written-out number pops in rather than counting up.
    expect(html).not.toContain("textContent: 1500000");
  });
});
