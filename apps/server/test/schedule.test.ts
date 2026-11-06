import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { StudioBoard, scriptBoard, videoBoard } from "../src/studio/board";
import { type Channel, channelSchema } from "../src/studio/channel";
import type { VideoDoc } from "../src/studio/editbay";
import {
  backupSkip,
  isWorkfile,
  loadStudioConfig,
  StudioSchedule,
  studioConfigSchema,
} from "../src/studio/schedule";
import type { Idea, ScriptDoc } from "../src/studio/writers";
import type { PostRecord } from "../src/uplink/publisher";
import { WorkStore } from "../src/work/store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-schedule-"));
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
  fs.rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400_000;
/** Thursday 5 November 2026, 10:00 local time. */
const T0 = new Date(2026, 10, 5, 10, 0).getTime();

const channel: Channel = channelSchema.parse({
  id: "phenomena",
  status: "active",
  name: "Orbital Foundry Studio",
  handle: "@orbitalfoundry",
  niche: "Rare phenomena",
  audience: "Curious adults",
  persona: "A calm narrator.",
  style: { tone: "Clear" },
  voice: { kokoro: "am_michael" },
});

function video(id: string, extra: Partial<VideoDoc> = {}): VideoDoc {
  const iso = new Date(T0 - DAY).toISOString();
  return {
    id,
    scriptId: "S-0001",
    channel: channel.id,
    format: "short",
    kind: "main",
    test: false,
    status: "review",
    stage: "done",
    progress: 100,
    title: `Video ${id}`,
    titles: [],
    description: "",
    tags: [],
    shots: [],
    assets: [],
    disclosure: { syntheticMedia: false, aiNarration: true },
    createdAt: iso,
    updatedAt: iso,
    ...extra,
  };
}

function script(id: string, format: "short" | "long", status: ScriptDoc["status"]): ScriptDoc {
  return {
    id,
    channel: channel.id,
    format,
    status,
    titles: [`Script ${id}`],
    idea: { title: id, angle: "" },
    updatedAt: new Date(T0).toISOString(),
  } as ScriptDoc;
}

function idea(id: string, format: Idea["format"], score: number): Idea {
  return {
    id,
    channel: channel.id,
    title: id,
    angle: "",
    format,
    hook: "",
    score,
    why: "",
    wikipedia: [],
    status: "backlog",
    createdAt: "",
  };
}

function setup(
  opts: {
    videos?: VideoDoc[];
    scripts?: ScriptDoc[];
    ideas?: Idea[];
    cadence?: { longPerWeek: number; shortsPerDay: number };
    schedule?: Record<string, number | boolean>;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(root, "s-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => db.close());
  const store = new WorkStore(db);
  let now = T0;
  const videos = opts.videos ?? [];
  const scripts = opts.scripts ?? [];
  const ideas = opts.ideas ?? [
    idea("I-1", "short", 7),
    idea("I-2", "both", 6),
    idea("I-3", "long", 8),
    idea("I-4", "short", 5),
  ];
  const calls = { started: [] as string[], proposed: 0, trimmed: [] as number[] };
  const writers = {
    channels: () => [channel],
    ideas: (_c?: string, status?: Idea["status"]) =>
      ideas.filter((i) => !status || i.status === status).sort((a, b) => b.score - a.score),
    scripts: () => scripts,
    proposeIdeas: async () => {
      calls.proposed += 1;
      const fresh = [idea(`I-new-${calls.proposed}`, "short", 9)];
      ideas.push(...fresh);
      return fresh;
    },
    start: (_c: string, o: { format: "short" | "long"; ideaId?: string }) => {
      const i = ideas.find((x) => x.id === o.ideaId);
      if (i) i.status = "scripted";
      calls.started.push(`${o.format}:${o.ideaId}`);
      const doc = script(`S-${10 + calls.started.length}`, o.format, "writing");
      scripts.push(doc);
      return doc;
    },
  };
  const videosDir = path.join(dir, "videos");
  const schedule = new StudioSchedule({
    store,
    writers,
    videos: {
      videos: () => videos,
      save: (v) => {
        const i = videos.findIndex((x) => x.id === v.id);
        if (i >= 0) videos[i] = v;
      },
    },
    cadence: () => opts.cadence ?? { longPerWeek: 1, shortsPerDay: 1 },
    library: {
      trim: (cap: number) => {
        calls.trimmed.push(cap);
        return 0;
      },
    },
    videosDir,
    config: studioConfigSchema.parse({ schedule: opts.schedule ?? {} }),
    now: () => now,
  });
  return {
    schedule,
    store,
    calls,
    videos,
    scripts,
    videosDir,
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe("studio schedule", () => {
  it("starts the scripts the cadence needs, at most two a day", async () => {
    const t = setup({
      cadence: { longPerWeek: 0, shortsPerDay: 2 },
      schedule: { minBacklog: 0 },
      videos: [video("V-1", { status: "approved" }), video("V-2", { test: true })],
      scripts: [script("S-0001", "short", "approved")],
    });
    // One short approved and waiting to post (V-1); test renders don't count.
    expect(t.schedule.pipeline()).toEqual([
      { channel: "phenomena", short: 1, long: 0, target: { short: 6, long: 0 } },
    ]);
    const r = await t.schedule.run();
    expect(t.calls.started).toEqual(["short:I-1", "short:I-2"]);
    expect(r.started).toHaveLength(2);
    const again = await t.schedule.run();
    expect(again.started).toEqual([]);
    expect(t.schedule.status()).toMatchObject({ startedToday: 2, enabled: true, hour: 9 });
  });

  it("counts a long-form for the three shorts cut from it", async () => {
    const t = setup({ videos: [video("V-3", { format: "long", status: "producing" })] });
    expect(t.schedule.pipeline()[0]).toMatchObject({ short: 3, long: 1 });
    const fresh = setup();
    await fresh.schedule.run();
    // The long-form covers this week's shorts too, so it is the only script started.
    expect(fresh.calls.started).toEqual(["long:I-3"]);
  });

  it("proposes fresh ideas when the backlog runs low", async () => {
    const t = setup({ ideas: [idea("I-9", "long", 6)] });
    await t.schedule.run();
    expect(t.calls.proposed).toBe(1);
    expect(t.calls.started).toEqual(["long:I-9"]);
  });

  it("runs once a day from its hour, and cleans up daily", async () => {
    const t = setup();
    t.setNow(new Date(2026, 10, 5, 8, 0).getTime());
    await t.schedule.tick();
    expect(t.calls.started).toEqual([]);
    expect(t.calls.trimmed).toEqual([8 * 1024 ** 3]);
    t.setNow(new Date(2026, 10, 5, 9, 5).getTime());
    await t.schedule.tick();
    expect(t.calls.started).toHaveLength(1);
    await t.schedule.tick();
    expect(t.calls.started).toHaveLength(1);
    expect(t.calls.trimmed).toHaveLength(1);
  });

  it("cleans old test renders and failures, and posted videos' working files", () => {
    const old = new Date(T0 - 20 * DAY).toISOString();
    const t = setup({
      videos: [
        video("V-0001", { test: true, updatedAt: old }),
        video("V-0002", { status: "failed", updatedAt: old }),
        video("V-0003", { status: "posted", updatedAt: old }),
        video("V-0004", { status: "approved", updatedAt: old }),
        video("V-0005", { test: true }),
      ],
    });
    for (const id of ["V-0001", "V-0002", "V-0003", "V-0004", "V-0005"]) {
      const d = path.join(t.videosDir, id);
      fs.mkdirSync(path.join(d, "project"), { recursive: true });
      fs.writeFileSync(path.join(d, `${id}.mp4`), "mp4");
      fs.writeFileSync(path.join(d, `${id}-thumb.png`), "png");
      fs.writeFileSync(path.join(d, "voice.wav"), "x".repeat(1000));
      fs.writeFileSync(path.join(d, "starfield-12.png"), "png");
      fs.writeFileSync(path.join(d, "project", "index.html"), "<html>");
    }
    const r = t.schedule.cleanup();
    expect(r).toMatchObject({ folders: 2, workfiles: 3 });
    expect(fs.existsSync(path.join(t.videosDir, "V-0001"))).toBe(false);
    expect(fs.existsSync(path.join(t.videosDir, "V-0002"))).toBe(false);
    expect(fs.readdirSync(path.join(t.videosDir, "V-0003")).sort()).toEqual([
      "V-0003-thumb.png",
      "V-0003.mp4",
    ]);
    // Approved but not posted, and fresh test renders, are left alone.
    expect(fs.readdirSync(path.join(t.videosDir, "V-0004"))).toHaveLength(5);
    expect(fs.readdirSync(path.join(t.videosDir, "V-0005"))).toHaveLength(5);
    expect(t.videos.find((v) => v.id === "V-0003")?.cleaned).toBe("workfiles");
  });

  it("leaves render working files out of backups and reads its config", () => {
    expect(isWorkfile("voice.wav")).toBe(true);
    expect(isWorkfile("V-0001.mp4")).toBe(false);
    expect(backupSkip("studio/videos/V-0001/project")).toBe(true);
    expect(backupSkip("studio/videos/V-0001/voice.wav")).toBe(true);
    expect(backupSkip("studio/videos/V-0001/V-0001.mp4")).toBe(false);
    expect(backupSkip("studio/videos/V-0001")).toBe(false);
    expect(backupSkip("thumbs/project")).toBe(false);
    expect(loadStudioConfig().schedule).toMatchObject({
      enabled: true,
      hour: 9,
      maxScriptsPerDay: 2,
    });
  });
});

describe("studio board", () => {
  it("places scripts and videos on their boards", () => {
    expect(scriptBoard(script("S-1", "short", "review"))).toMatchObject({
      status: "Script waiting for your approval",
      steps: { idea: "done", script: "current", voice: "todo" },
    });
    expect(
      videoBoard(video("V-1", { status: "producing", stage: "render", progress: 40 }), []),
    ).toMatchObject({
      progress: 40,
      steps: { voice: "done", visuals: "done", render: "current", screening: "todo" },
    });
    expect(
      videoBoard(video("V-1", { status: "failed", stage: "shots", error: "no disk" }), []),
    ).toMatchObject({
      status: "Failed: no disk",
      steps: { voice: "done", visuals: "failed" },
    });
    const awaiting = { status: "awaiting" } as PostRecord;
    expect(videoBoard(video("V-1", { status: "approved" }), [awaiting])).toMatchObject({
      status: "Post plan waiting for your approval",
      steps: { approval: "done", posted: "current" },
    });
    expect(videoBoard(video("V-1", { status: "posted" }), []).steps.posted).toBe("done");
  });

  it("builds one board with the budgets and the pipeline", async () => {
    const t = setup({
      videos: [
        video("V-1", { voice: { provider: "kokoro", units: 400, fallback: "fetch failed" } }),
      ],
      scripts: [script("S-0001", "short", "approved"), script("S-0009", "long", "review")],
    });
    let asked = 0;
    const board = new StudioBoard({
      writers: { channels: () => [channel], scripts: () => t.scripts },
      videos: { videos: () => t.videos },
      voices: {
        elevenCreditsLeft: async () => {
          asked += 1;
          return 42_000;
        },
      },
      schedule: t.schedule,
      stillsToday: () => 3,
      diskPath: root,
    });
    const b = await board.build();
    expect(b.items.map((i) => i.id).sort()).toEqual(["S-0009", "V-1"]);
    expect(b.items.find((i) => i.id === "V-1")?.voice).toEqual({
      provider: "kokoro",
      fallback: "fetch failed",
    });
    expect(b.budgets.elevenlabs.creditsLeft).toBe(42_000);
    expect(b.budgets.stills.madeToday).toBe(3);
    expect(b.budgets.disk.freeGb).toBeGreaterThan(0);
    expect(b.schedule?.pipeline[0]).toMatchObject({ short: 4, long: 1 });
    await board.build();
    expect(asked).toBe(1);
  });
});
