import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { type Approval, getStationMap } from "@orbital/shared";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { creativeConfigSchema, loadStyles } from "../src/creative/config";
import { CreativeStudio } from "../src/creative/studio";
import { openDb } from "../src/db";
import { type Fixture, FixtureTransport } from "../src/llm/fixtures";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import {
  contrastRatio,
  mobilePreview,
  type ThumbConcept,
  ThumbnailStudio,
  thumbSpec,
} from "../src/thumbs/studio";
import { WorkStore } from "../src/work/store";
import { makeRouter, provider, tiersWith } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const CONCEPTS: ThumbConcept[] = [
  {
    angle: "curiosity",
    hook: "Why Nobody Does This",
    scene: "a dark workshop with a single glowing lamp",
    subject: "a surprised robot",
    textSide: "left",
    textColor: "#ffe14d",
    accentColor: "#ff3d5a",
  },
  {
    angle: "emotion",
    hook: "I Almost Quit",
    scene: "a stormy sky over a lonely desk",
    subject: "",
    textSide: "right",
    textColor: "#ffffff",
    accentColor: "#29d3ff",
  },
  {
    angle: "contrast",
    hook: "$0 vs $1000",
    scene: "a split scene, cheap tools on one side and luxury tools on the other",
    subject: "",
    textSide: "left",
    textColor: "#7CFF6B",
    accentColor: "#ffffff",
  },
];

function fixtures(): Fixture[] {
  return [
    {
      when: { system: "You are Flash, a YouTube thumbnail designer", user: "Video title" },
      reply: { content: JSON.stringify({ concepts: CONCEPTS }) },
      once: true,
    },
    // The revision: bigger, louder hook on #2, everything else kept.
    {
      when: { system: "revision note" },
      reply: {
        content: JSON.stringify({
          concepts: CONCEPTS.map((c) =>
            c.angle === "emotion" ? { ...c, hook: "I QUIT", textColor: "#ff5252" } : c,
          ),
        }),
      },
    },
    {
      when: { system: "image QA reviewer" },
      reply: {
        content: JSON.stringify({
          score: 8,
          defects: [],
          garbledText: false,
          artifacts: false,
          legibility: 9,
          notes: "Reads well.",
        }),
      },
    },
    {
      when: { system: "Write a Fiverr gig" },
      reply: {
        content:
          "# I will design 3 scroll-stopping YouTube thumbnails\n\nMade with AI-assisted tools and finished by a designer.",
      },
    },
  ];
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-thumbs-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new WorkStore(db);
  const world = new SimServer({
    map: getStationMap(),
    store: new SimStore(db),
    seed: 4,
    mockProviders: false,
  });
  const transport = new FixtureTransport(fixtures());
  const { router } = makeRouter({
    providers: { fake: provider("fake", ["sandbox"]) },
    tiers: tiersWith({ creative: { sandbox: ["fake:big"] }, vision: { sandbox: ["fake:vl"] } }),
    transport,
  });
  let n = 0;
  const generated: string[] = [];
  const studio = new CreativeStudio({
    images: {
      generate: async (_lane, req) => {
        n += 1;
        generated.push(req.prompt);
        const c = createCanvas(128, 128);
        const ctx = c.getContext("2d");
        ctx.fillStyle = n % 2 ? "#123456" : "#00ff00";
        ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = "#c0392b";
        ctx.fillRect(40, 30, 48, 70);
        return {
          bytes: await c.encode("png"),
          mime: "image/png",
          endpoint: "fake",
          provider: "fake",
          latencyMs: 1,
          attempts: [],
        };
      },
    },
    router,
    store,
    dir: path.join(dir, "images"),
    lane: "sandbox",
    config: creativeConfigSchema.parse({ aspects: { "1:1": [128, 128], "16:9": [256, 144] } }),
    styles: loadStyles(),
    blocklist: {},
    now: () => world.sim.now,
  });
  const desk: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  const thumbs = new ThumbnailStudio({
    router,
    studio,
    store,
    world,
    director: {
      fileDeskItem: (f) => {
        desk.push(f);
        return {
          ...f,
          id: `A-${desk.length}`,
          status: "pending",
          createdAt: 0,
          decidedAt: null,
          note: null,
        };
      },
      onDecision: (hook) => {
        hooks.push(hook);
      },
    },
    lane: "sandbox",
    dir: path.join(dir, "thumbs"),
  });
  return { thumbs, store, world, desk, hooks, studio, generated, db, dir };
}

describe("thumbnail helpers", () => {
  it("measures contrast like WCAG", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1);
  });

  it("lays the hook out opposite the subject", () => {
    const left = thumbSpec(CONCEPTS[0] as ThumbConcept, "I-1", "I-2");
    const text = left.layers.find((l) => l.type === "text");
    const subject = left.layers.find((l) => l.type === "image");
    expect(text?.type === "text" && text.x).toBe(48);
    expect(subject?.type === "image" && subject.x).toBeGreaterThan(600);
    expect(left.width).toBe(1280);
    expect(left.height).toBe(720);
  });

  it("previews at YouTube's phone size", () => {
    const p = mobilePreview(createCanvas(1280, 720));
    expect([p.width, p.height]).toEqual([336, 188]);
  });
});

describe("ThumbnailStudio", () => {
  it("turns a brief into three 1280×720 thumbnails with phone previews and a ZIP", async () => {
    const s = setup();
    const t0 = Date.now();
    const job = await s.thumbs.make({
      title: "I tried every cheap tool on Amazon",
      channelStyle: "bold tech reviews",
    });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(job.status).toBe("delivered");
    const v = job.versions[0];
    if (!v) throw new Error("no version");
    expect(v.concepts.map((c) => c.angle)).toEqual(["curiosity", "emotion", "contrast"]);
    expect(v.images).toHaveLength(3);
    for (const id of v.images) {
      expect([
        s.store.artifact(id)?.meta.info?.width,
        s.store.artifact(id)?.meta.info?.height,
      ]).toEqual([1280, 720]);
    }
    expect(v.readability.every((r) => r.words <= 5 && r.contrast > 1)).toBe(true);
    expect(v.qa.map((q) => q.score)).toEqual([8, 8, 8]);
    const files = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(v.zip)))).sort();
    expect(files).toContain("1-curiosity.png");
    expect(files).toContain("sources/2-emotion-layout.json");
    expect(files).toContain("previews/3-contrast-phone.png");
    expect(files).toContain("sources/subject.png");
    expect(s.desk[0]).toMatchObject({ kind: "deliverable", artifactId: v.deliveryId });
    expect(s.world.sim.task(job.taskId)).toMatchObject({ status: "done", pipeline: "thumbs" });
  });

  it("revises from the owner's note, keeping the backgrounds unless the note asks", async () => {
    const s = setup();
    const job = await s.thumbs.make({ title: "My first year as a solo developer" });
    const before = s.generated.length;
    const v1 = job.versions[0];
    if (!v1) throw new Error("no v1");
    await s.hooks[0]?.({
      ...(s.desk[0] as Approval),
      id: "A-1",
      status: "rejected",
      createdAt: 0,
      decidedAt: 1,
      note: "Make the hook on #2 shorter and red",
    });
    const v2 = s.thumbs.job(job.id)?.versions[1];
    expect(v2?.version).toBe(2);
    expect(v2?.concepts[1]?.hook).toBe("I QUIT");
    expect(v2?.backgrounds).toEqual(v1.backgrounds);
    expect(s.generated.length).toBe(before);
    expect(s.desk.at(-1)?.title).toMatch(/\(v2\)$/);
    // A note that asks for a new scene regenerates the backgrounds.
    await s.thumbs.revise(job.id, "New background for all three, brighter");
    expect(s.generated.length).toBe(before + 3);
  });

  it("withdraws the previous version's Desk item when a revision lands", async () => {
    const s = setup();
    const job = await s.thumbs.make({ title: "Ten tiny habits" });
    const v1 = job.versions[0];
    if (!v1) throw new Error("no v1");
    s.store.saveApproval({
      ...(s.desk[0] as Approval),
      id: "A-0101",
      status: "pending",
      createdAt: 0,
      decidedAt: null,
      note: null,
    });
    await s.thumbs.revise(job.id, "Make the hook on #2 shorter and red");
    expect(s.store.approval("A-0101")).toMatchObject({
      status: "rejected",
      note: "Superseded by version 2.",
    });
  });

  it("cuts out the client's photo and uses it on every thumbnail", async () => {
    const s = setup();
    const photo = createCanvas(120, 160);
    const ctx = photo.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 120, 160);
    ctx.fillStyle = "#8d5524";
    ctx.beginPath();
    ctx.arc(60, 70, 40, 0, Math.PI * 2);
    ctx.fill();
    const job = await s.thumbs.make({
      title: "Reacting to my old videos",
      facePhoto: (await photo.encode("png")).toString("base64"),
    });
    expect(job.photoId).toMatch(/^I-/);
    expect(job.versions[0]?.subject).toBe(job.photoId);
    expect(job.brief.hasPhoto).toBe(true);
    expect("facePhoto" in job.brief).toBe(false);
  });

  it("draws the scenes itself when image generation is unavailable", async () => {
    const s = setup();
    const dead = new ThumbnailStudio({
      ...(s.thumbs as unknown as { deps: ConstructorParameters<typeof ThumbnailStudio>[0] }).deps,
      studio: new CreativeStudio({
        ...(s.studio as unknown as { deps: ConstructorParameters<typeof CreativeStudio>[0] }).deps,
        images: {
          generate: async () => {
            throw new Error("you have used up your daily free allocation of 10,000 neurons");
          },
        },
      }),
    });
    const job = await dead.make({ title: "Budget day" });
    expect(job.status).toBe("delivered");
    const v = job.versions[0];
    expect(v?.images).toHaveLength(3);
    const bg = s.store.artifact(v?.backgrounds[0] ?? "")?.meta;
    expect(bg?.info?.op).toBe("procedural");
    expect(s.store.artifact(v?.deliveryId ?? "")?.content).toContain("drawn in code");
  });

  it("writes a gig kit with a portfolio of the best thumbnails", async () => {
    const s = setup();
    await s.thumbs.make({ title: "Ten tiny habits that changed my year" });
    const kit = await s.thumbs.gigKit();
    const content = s.store.artifact(kit.id)?.content ?? "";
    expect(content).toContain("I will design");
    expect(content).toContain("## Portfolio");
    expect((kit.info?.portfolio as string[] | undefined)?.length).toBe(3);
  });

  it("keeps jobs across a restart and marks unfinished ones failed", async () => {
    const s = setup();
    const job = await s.thumbs.make({ title: "Building a cabin alone" });
    s.store.setKv(`thumbs.job.${job.id}`, JSON.stringify({ ...job, status: "working" }));
    const again = new ThumbnailStudio({
      router: makeRouter({
        providers: { fake: provider("fake", ["sandbox"]) },
        tiers: tiersWith({}),
        transport: new FixtureTransport([]),
      }).router,
      studio: s.studio,
      store: s.store,
      world: s.world,
      director: { fileDeskItem: () => ({}) as Approval, onDecision: () => {} },
      lane: "sandbox",
      dir: path.join(s.dir, "thumbs"),
    });
    expect(again.job(job.id)?.status).toBe("failed");
    expect(again.list()).toHaveLength(1);
  });
});
