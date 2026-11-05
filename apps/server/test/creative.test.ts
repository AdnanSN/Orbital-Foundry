import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Canvas, createCanvas } from "@napi-rs/canvas";
import { type ArtifactMeta, getStationMap } from "@orbital/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposeSpec, composeSpecSchema, layoutText, render } from "../src/creative/compose";
import {
  type Blocklist,
  creativeConfigSchema,
  loadBlocklist,
  type Style,
  styledPrompt,
} from "../src/creative/config";
import { blocklistHits, ipScreen } from "../src/creative/qa";
import {
  basicChecks,
  chromaKey,
  downscale,
  packSheet,
  pixels,
  quantize,
  removeBackgroundEdges,
  resampleUp,
} from "../src/creative/raster";
import { CreativeStudio, type StudioDeps } from "../src/creative/studio";
import { creativeTools } from "../src/creative/tools";
import { openDb } from "../src/db";
import { buildApp } from "../src/http/app";
import { type Fixture, FixtureTransport } from "../src/llm/fixtures";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import { WorkDirector } from "../src/work/director";
import { loadRoles } from "../src/work/roles";
import { WorkStore } from "../src/work/store";
import { BUILTIN_TOOLS, parseToolArgs, type ToolContext, ToolRegistry } from "../src/work/tools";
import { WebClient } from "../src/work/web";
import { makeRouter, provider, tiersWith } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function alphaAt(p: { width: number; data: Uint8ClampedArray }, x: number, y: number): number {
  return p.data[(y * p.width + x) * 4 + 3] ?? -1;
}

/** A subject on a flat background: a blue disc with a white centre, on `bg`. */
function subject(size: number, bg: string): Canvas {
  const c = createCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#1e40af";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.1, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

describe("pixel operations", () => {
  it("chroma-keys a flat magenta background and keeps the subject", () => {
    const { pixels: out, key } = chromaKey(pixels(subject(64, "#ff00ff")));
    expect(key).toEqual([255, 0, 255]);
    expect(alphaAt(out, 1, 1)).toBe(0);
    expect(alphaAt(out, 32, 20)).toBe(255);
  });

  it("flood-fills from the edges, so white inside the subject survives on a white background", () => {
    const src = pixels(subject(64, "#ffffff"));
    const { pixels: out } = removeBackgroundEdges(src, { tolerance: 40 });
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 63, 40)).toBe(0);
    // The white centre is enclosed by the blue disc: not background.
    expect(alphaAt(out, 32, 32)).toBe(255);
    // A chroma key would have removed it.
    expect(alphaAt(chromaKey(src, { tolerance: 40 }).pixels, 32, 32)).toBe(0);
    const checks = basicChecks(out);
    expect(checks.edgeOpaque).toBe(0);
    expect(checks.blank).toBe(false);
  });

  it("resamples up in 2× steps", () => {
    const up = resampleUp(subject(50, "#ffffff"), 4);
    expect([up.width, up.height]).toEqual([200, 200]);
  });

  it("pixelates to the size and palette asked for", () => {
    const src = createCanvas(120, 60);
    const ctx = src.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 120, 0);
    g.addColorStop(0, "#ff0000");
    g.addColorStop(1, "#0000ff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 120, 60);
    const small = downscale(src, 32, "average");
    expect([small.width, small.height]).toEqual([32, 16]);
    const { pixels: q, palette } = quantize(small, 6);
    expect(palette.length).toBeLessThanOrEqual(6);
    const colours = new Set<string>();
    for (let i = 0; i < q.data.length; i += 4) colours.add(q.data.slice(i, i + 3).join(","));
    expect(colours.size).toBeLessThanOrEqual(6);
  });

  it("packs frames into a grid with an atlas", () => {
    const frames = [0, 1, 2, 3, 4].map((i) => ({ name: `f${i}`, canvas: createCanvas(16, 16) }));
    const { canvas, atlas } = packSheet(frames, { padding: 2 });
    expect([atlas.columns, atlas.rows]).toEqual([3, 2]);
    expect([canvas.width, canvas.height]).toEqual([3 * 16 + 4 * 2, 2 * 16 + 3 * 2]);
    expect(atlas.frames[4]).toEqual({ name: "f4", x: 2 + 18, y: 2 + 18, w: 16, h: 16 });
  });

  it("flags a blank image", () => {
    const c = createCanvas(32, 32);
    c.getContext("2d").fillStyle = "#336699";
    c.getContext("2d").fillRect(0, 0, 32, 32);
    expect(basicChecks(pixels(c)).blank).toBe(true);
  });
});

describe("compose", () => {
  const fonts = creativeConfigSchema.parse({}).fonts;

  it("draws text and shrinks it to fit its box", () => {
    const spec: ComposeSpec = composeSpecSchema.parse({
      width: 320,
      height: 180,
      background: { gradient: ["#000000", "#202040"] },
      layers: [
        { type: "rect", x: 0, y: 140, width: 320, height: 40, color: "#ff3355" },
        {
          type: "text",
          text: "Ten winter candle niches ranked",
          x: 10,
          y: 10,
          maxWidth: 300,
          maxLines: 2,
          size: "120",
          stroke: { color: "#000000", width: 6 },
        },
      ],
    });
    const canvas = render(spec, new Map(), fonts);
    const p = pixels(canvas);
    let white = 0;
    for (let i = 0; i < p.data.length; i += 4)
      if ((p.data[i] ?? 0) > 240 && (p.data[i + 1] ?? 0) > 240) white += 1;
    expect(white).toBeGreaterThan(200);
    const layer = spec.layers[1];
    if (layer?.type !== "text") throw new Error("layer");
    const fitted = layoutText(canvas.getContext("2d"), layer, fonts);
    expect(fitted.size).toBeLessThan(120);
    expect(fitted.lines.length).toBeLessThanOrEqual(2);
  });
});

describe("prompts and the IP screen", () => {
  const style: Style = {
    description: "test",
    prefix: "Flat vector of",
    suffix: "white background",
    avoid: ["text"],
    aspect: "1:1",
    cutout: "edges",
  };
  const list: Blocklist = { characters: ["Mickey Mouse", "Marvel"], brands: ["Nike"] };

  it("wraps a subject in a style", () => {
    expect(styledPrompt("a  fox in snow", style)).toBe(
      "Flat vector of a fox in snow, white background. Avoid: text.",
    );
  });

  it("matches whole words only", () => {
    expect(blocklistHits("A MICKEY MOUSE candle", list).map((h) => h.term)).toEqual([
      "Mickey Mouse",
    ]);
    expect(blocklistHits("a marvellous nikeless design", list)).toEqual([]);
  });

  it("keeps the real blocklist to unambiguous names", () => {
    const real = loadBlocklist();
    expect(
      blocklistHits(
        "apple cinnamon candle for best friends by a frozen lake, peanut brittle",
        real,
      ),
    ).toEqual([]);
    expect(blocklistHits("a Grinch christmas sweater", real).map((h) => h.term)).toEqual([
      "Grinch",
    ]);
  });

  it("blocks list hits, reviews medium risk, and never clears without a model", async () => {
    expect((await ipScreen(null, "sandbox", list, "Nike style shoe")).verdict).toBe("block");
    expect((await ipScreen(null, "sandbox", list, "a fox")).verdict).toBe("review");
    const transport = new FixtureTransport([
      {
        when: { system: "You screen designs" },
        reply: { content: '{"risk":"medium","issues":["looks like a famous mouse"]}' },
      },
    ]);
    const { router } = makeRouter({
      providers: { fake: provider("fake", ["sandbox"]) },
      tiers: tiersWith({ fast: { sandbox: ["fake:small"] } }),
      transport,
    });
    const r = await ipScreen(router, "sandbox", list, "a cartoon mouse with round ears");
    expect(r.verdict).toBe("review");
    expect(r.llm?.issues).toEqual(["looks like a famous mouse"]);
  });
});

// -- The studio, with a fake image endpoint and a fixture vision model ---------------------------

const QA_PASS =
  '{"score":8,"defects":[],"garbledText":false,"artifacts":false,"legibility":9,"notes":"Clean."}';

function studioSetup(overrides: Partial<StudioDeps> = {}, fx?: Fixture[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-creative-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new WorkStore(db);
  const transport = new FixtureTransport(
    fx ?? [
      { when: { system: "image QA reviewer" }, reply: { content: QA_PASS } },
      { when: { system: "You screen designs" }, reply: { content: '{"risk":"none","issues":[]}' } },
    ],
  );
  const { router } = makeRouter({
    providers: { fake: provider("fake", ["sandbox"]) },
    tiers: tiersWith({ vision: { sandbox: ["fake:vl"] }, fast: { sandbox: ["fake:small"] } }),
    transport,
  });
  const generated: { prompt: string; width?: number; seed?: number }[] = [];
  const events: { meta: ArtifactMeta; change: string }[] = [];
  const said: string[] = [];
  const deps: StudioDeps = {
    images: {
      generate: async (_lane, req) => {
        generated.push({
          prompt: req.prompt,
          ...(req.width ? { width: req.width } : {}),
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        });
        // A square image, like Cloudflare's FLUX endpoint.
        return {
          bytes: await subject(96, "#ffffff").encode("png"),
          mime: "image/png",
          endpoint: "fake-flux",
          provider: "fake",
          latencyMs: 5,
          attempts: [],
        };
      },
    },
    router,
    store,
    dir: path.join(dir, "images"),
    lane: "sandbox",
    config: creativeConfigSchema.parse({ aspects: { "1:1": [64, 64], "16:9": [64, 36] } }),
    styles: {
      "pod-design": {
        description: "a t-shirt print",
        prefix: "Flat vector of",
        suffix: "plain white background",
        avoid: [],
        aspect: "1:1",
        cutout: "edges",
      },
    },
    blocklist: { characters: ["Pikachu"] },
    now: () => 1_000,
    onArtifact: (meta, change) => events.push({ meta, change }),
    say: (_room, text) => said.push(text),
    ...overrides,
  };
  return { studio: new CreativeStudio(deps), store, generated, events, said, dir, transport };
}

describe("CreativeStudio", () => {
  it("runs prompt → image → cutout → 4× upscale → QA, and records every step", async () => {
    const s = studioSetup();
    const result = await s.studio.pipeline(
      { prompt: "a fox in the snow", style: "pod-design", upscale: 4 },
      { createdBy: "owner", room: "factory-1" },
    );
    expect(result.steps.map((m) => m.info?.op)).toEqual(["generate", "cutout", "upscale"]);
    expect(s.generated[0]?.prompt).toBe("Flat vector of a fox in the snow, plain white background");
    const [gen, cut, up] = result.steps;
    expect(gen?.info?.width).toBe(64); // fitted to the aspect's size
    expect(cut?.parentId).toBe(gen?.id);
    expect(up?.parentId).toBe(cut?.id);
    expect([up?.info?.width, up?.info?.height]).toEqual([256, 256]);
    expect(result.steps.every((m) => m.room === "factory-1" && m.review === "pending")).toBe(true);
    expect(result.qa?.pass).toBe(true);
    expect(result.qa?.checks.edgeOpaque).toBe(0);
    expect((result.final.info?.qa as { score: number } | undefined)?.score).toBe(8);
    // Three new images, then the QA score as an update.
    expect(s.events.map((e) => e.change)).toEqual(["created", "created", "created", "updated"]);
    expect(fs.existsSync(s.studio.file(result.final.id)?.path ?? "")).toBe(true);
  });

  it("refuses prompts that name protected IP", async () => {
    const s = studioSetup();
    await expect(
      s.studio.generate({ prompt: "Pikachu surfing" }, { createdBy: "owner" }),
    ).rejects.toThrow(/protected IP \(Pikachu\)/);
    expect(s.generated).toHaveLength(0);
  });

  it("falls back to the resampler when Real-ESRGAN cannot run", async () => {
    const config = creativeConfigSchema.parse({
      aspects: { "1:1": [32, 32] },
      upscale: { realesrgan: path.join(os.tmpdir(), "no-such-realesrgan.exe") },
    });
    const s = studioSetup({ config });
    const base = await s.studio.generate({ prompt: "a fox" }, { createdBy: "owner" });
    const up = await s.studio.upscale(base.id, 2, { createdBy: "owner" });
    expect(up.info?.width).toBe(64);
    expect(String(up.info?.method)).toMatch(/^resample \(Real-ESRGAN failed/);
  });

  it("pixelates and packs a sprite sheet", async () => {
    const s = studioSetup();
    const a = await s.studio.generate(
      { prompt: "a potion" },
      { createdBy: "nova", room: "factory-3" },
    );
    const px = await s.studio.pixelate(
      a.id,
      { size: 16, colors: 8, scale: 2 },
      { createdBy: "nova" },
    );
    expect([px.info?.width, px.info?.height]).toEqual([32, 32]);
    expect((px.info?.palette as string[] | undefined)?.length).toBeLessThanOrEqual(8);
    expect(px.room).toBe("factory-3");
    const sheet = await s.studio.spritesheet([px.id, px.id, px.id], {}, { createdBy: "nova" });
    expect(sheet.atlas.frames).toHaveLength(3);
    expect(sheet.meta.info?.pixelArt).toBe(true);
  });

  it("composes over a generated image, reviews, and keeps files inside its folder", async () => {
    const s = studioSetup();
    const bg = await s.studio.generate(
      { prompt: "a stormy sea", aspect: "16:9" },
      { createdBy: "flash" },
    );
    const thumb = await s.studio.compose(
      composeSpecSchema.parse({
        width: 128,
        height: 72,
        background: { imageId: bg.id },
        layers: [{ type: "text", text: "STORM", x: 4, y: 4, size: 30, maxWidth: 60 }],
      }),
      "Storm thumbnail",
      { createdBy: "flash" },
    );
    expect(thumb.parentId).toBe(bg.id);
    const reviewed = s.studio.review(thumb.id, "approved", "Great contrast");
    expect(reviewed.review).toBe("approved");
    expect(s.events.at(-1)?.change).toBe("updated");
    // An artifact whose path points elsewhere is never served.
    s.store.saveArtifact({ ...thumb, id: "I-9999" }, null, path.join(os.tmpdir(), "elsewhere.png"));
    expect(s.studio.file("I-9999")).toBeNull();
  });

  it("does basic checks only when no vision model is available", async () => {
    const s = studioSetup({ router: null });
    const img = await s.studio.generate({ prompt: "a fox" }, { createdBy: "owner" });
    const qa = await s.studio.qa(img.id);
    expect(qa.vision).toBeNull();
    expect(qa.pass).toBe(false);
    expect(qa.note).toMatch(/basic checks only/);
  });
});

describe("creative tools and routes", () => {
  it("lets an agent chain image tools by id", async () => {
    const s = studioSetup();
    const registry = new ToolRegistry([...BUILTIN_TOOLS, ...creativeTools(["pod-design"])]);
    const gen = registry.get("generate_image");
    const cut = registry.get("remove_background");
    if (!gen || !cut) throw new Error("tools missing");
    const ctx = {
      agent: { id: "wick", room: "factory-1" },
      task: { id: "W-0001", objectiveId: null },
      studio: s.studio,
    } as unknown as ToolContext;
    const args = parseToolArgs(gen, JSON.stringify({ prompt: "a fox", style: "pod-design" }));
    if (!args.ok) throw new Error(args.error);
    expect(await gen.run(args.input, ctx)).toMatch(/^Made I-0001 \(64×64\)/);
    const cutArgs = parseToolArgs(cut, JSON.stringify({ imageId: "I-0001" }));
    if (!cutArgs.ok) throw new Error(cutArgs.error);
    expect(await cut.run(cutArgs.input, ctx)).toMatch(/^Made I-0002/);
    expect(s.store.artifact("I-0002")?.meta.taskId).toBe("W-0001");
    expect(parseToolArgs(cut, JSON.stringify({ imageId: "F-0001" })).ok).toBe(false);
  });

  it("serves the gallery: list, file, review and the one-click pipeline", async () => {
    const s = studioSetup();
    const db = openDb(path.join(s.dir, "world.db"));
    cleanups.push(() => db.close());
    const world = new SimServer({
      map: getStationMap(),
      store: new SimStore(db),
      seed: 1,
      mockProviders: false,
    });
    const director = new WorkDirector({
      router: makeRouter({
        providers: { fake: provider("fake", ["sandbox"]) },
        tiers: tiersWith({}),
        transport: s.transport,
      }).router,
      store: s.store,
      world,
      roles: loadRoles(),
      tools: new ToolRegistry(),
      web: new WebClient(
        { allow: [], userAgent: "test", maxBytes: 1_000 },
        async () => new Response(""),
      ),
      dailyStandup: false,
    });
    const app = await buildApp(world, { director, store: s.store, studio: s.studio });
    cleanups.push(() => void app.close());

    const run = await app.inject({
      method: "POST",
      url: "/api/creative/pipeline",
      payload: { prompt: "a fox", style: "pod-design", upscale: 2, room: "factory-1" },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json() as { final: ArtifactMeta; steps: ArtifactMeta[] };
    expect(body.steps).toHaveLength(3);

    const list = await app.inject({
      method: "GET",
      url: "/api/artifacts?kind=image&room=factory-1",
    });
    expect((list.json() as ArtifactMeta[]).map((a) => a.id)).toEqual([
      "I-0003",
      "I-0002",
      "I-0001",
    ]);

    const file = await app.inject({ method: "GET", url: `/api/artifacts/${body.final.id}/file` });
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.rawPayload.subarray(1, 4).toString()).toBe("PNG");

    const review = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/${body.final.id}`,
      payload: { review: "rejected", note: "Halo on the left" },
    });
    expect((review.json() as ArtifactMeta).review).toBe("rejected");

    const bad = await app.inject({
      method: "POST",
      url: "/api/creative/pipeline",
      payload: { prompt: "Pikachu", style: "pod-design" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: expect.stringMatching(/protected IP/) });
  });
});
