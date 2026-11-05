import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { type Approval, getStationMap } from "@orbital/shared";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { creativeConfigSchema, loadStyles } from "../src/creative/config";
import { addOutline, applyPalette, buildPalette, findBlobs, pixels } from "../src/creative/raster";
import { CreativeStudio } from "../src/creative/studio";
import { openDb } from "../src/db";
import { AssetForge, licenseText } from "../src/forge/forge";
import { type Fixture, FixtureTransport } from "../src/llm/fixtures";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import { WorkStore } from "../src/work/store";
import { makeRouter, provider, tiersWith } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const COLOURS = [
  "#e63946",
  "#2a9d8f",
  "#e9c46a",
  "#264653",
  "#f4a261",
  "#8ecae6",
  "#6a4c93",
  "#90be6d",
];

/** A fake sprite sheet: twelve shapes in a 4×3 grid on flat magenta, with a sparkle by one. */
async function fakeSheet(): Promise<Buffer> {
  const c = createCanvas(256, 256);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ff00ff";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 12; i++) {
    const x = 16 + (i % 4) * 60;
    const y = 30 + Math.floor(i / 4) * 70;
    ctx.fillStyle = COLOURS[i % COLOURS.length] as string;
    if (i % 2) ctx.fillRect(x, y, 34, 40);
    else {
      ctx.beginPath();
      ctx.arc(x + 18, y + 20, 18, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(56, 26, 3, 3); // a sparkle just outside the first shape
  return c.encode("png");
}

describe("pack pixel helpers", () => {
  it("finds separate items in reading order, merging specks that sit next to an item", () => {
    const c = createCanvas(120, 60);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(70, 10, 20, 20); // right
    ctx.fillRect(10, 12, 20, 20); // left
    ctx.fillRect(33, 14, 2, 2); // a speck 3 px from the left item
    ctx.fillRect(10, 45, 1, 1); // a lone speck
    const blobs = findBlobs(pixels(c), { minArea: 20, gap: 4 });
    expect(blobs.map((b) => [b.x0, b.y0])).toEqual([
      [10, 12],
      [70, 10],
    ]);
    expect(blobs[0]?.x1).toBe(34);
  });

  it("locks a pack to one palette and outlines each shape", () => {
    const a = createCanvas(8, 8);
    a.getContext("2d").fillStyle = "#d00000";
    a.getContext("2d").fillRect(2, 2, 4, 4);
    const b = createCanvas(8, 8);
    b.getContext("2d").fillStyle = "#0000d0";
    b.getContext("2d").fillRect(2, 2, 4, 4);
    const palette = buildPalette([pixels(a), pixels(b)], 2);
    expect(palette).toHaveLength(2);
    const outlined = addOutline(applyPalette(pixels(a), palette), [0, 0, 0]);
    const at = (x: number, y: number) =>
      outlined.data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4).join(",");
    expect(at(1, 3)).toBe("0,0,0,255"); // outline left of the square
    expect(at(0, 0)).toBe("0,0,0,0"); // still transparent
  });

  it("writes a licence that allows games and forbids reselling the assets", () => {
    const text = licenseText("Potion Pack", 2026);
    expect(text).toContain("commercial and non-commercial projects");
    expect(text).toContain("You may not resell");
    expect(text).toContain("AI image generation");
  });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-forge-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new WorkStore(db);
  const world = new SimServer({
    map: getStationMap(),
    store: new SimStore(db),
    seed: 5,
    mockProviders: false,
  });
  const plan = {
    title: "Tiny Alchemy",
    items: Array.from({ length: 16 }, (_, i) => `item ${i + 1}`),
    palette: COLOURS,
    outline: "dark",
    light: "top-left",
    stylePrompt: "Bold flat game icons, chunky shapes, soft shading",
    tags: ["pixel art", "icons", "alchemy"],
    blurb: "Sixteen tiny alchemy icons.",
  };
  const fx: Fixture[] = [
    { when: { system: "You are Forge" }, reply: { content: JSON.stringify(plan) } },
    {
      when: { system: "You are Lens, reviewing" },
      reply: {
        content: JSON.stringify({
          score: 8,
          outliers: [2],
          names: Array.from({ length: 12 }, (_, i) => (i === 3 ? "Teal Cube" : `Shape ${i + 1}`)),
          notes: "Consistent.",
        }),
      },
    },
  ];
  const { router } = makeRouter({
    providers: { fake: provider("fake", ["sandbox"]) },
    tiers: tiersWith({ creative: { sandbox: ["fake:big"] }, vision: { sandbox: ["fake:vl"] } }),
    transport: new FixtureTransport(fx),
  });
  let sheets = 0;
  const studio = new CreativeStudio({
    images: {
      generate: async () => {
        sheets += 1;
        return {
          bytes: await fakeSheet(),
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
    config: creativeConfigSchema.parse({ aspects: { "1:1": [256, 256] } }),
    styles: loadStyles(),
    blocklist: {},
    now: () => world.sim.now,
  });
  const desk: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  const forge = new AssetForge({
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
    dir: path.join(dir, "forge"),
  });
  return { forge, store, world, desk, hooks, studio, sheets: () => sheets, dir };
}

describe("AssetForge", () => {
  it("makes a consistent pack from sprite sheets: icons, sheet, preview, licence, README", async () => {
    const s = setup();
    const pack = await s.forge.make({ theme: "tiny alchemy", size: 16, count: 8 });
    expect(pack.status).toBe("delivered");
    expect(s.sheets()).toBe(1); // twelve items on one sheet cover eight icons plus spares
    expect(pack.icons).toHaveLength(8);
    // Outlier #2 was swapped for a spare; Lens's names became file names.
    expect(pack.outliers).toEqual([2]);
    expect(pack.icons.map((i) => i.name)).not.toContain("shape-2");
    expect(pack.icons.map((i) => i.name)).toContain("teal-cube");
    for (const icon of pack.icons) {
      expect([
        s.store.artifact(icon.id)?.meta.info?.width,
        s.store.artifact(icon.id)?.meta.info?.height,
      ]).toEqual([16, 16]);
    }
    expect(pack.palette.length).toBeLessThanOrEqual(12);
    const files = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(pack.zip ?? "")))).sort();
    expect(files).toEqual(
      expect.arrayContaining([
        "LICENSE.txt",
        "README.md",
        "preview.png",
        "spritesheet.json",
        "spritesheet.png",
        "icons/01-shape-1.png",
      ]),
    );
    expect(files.filter((f) => f.startsWith("icons/"))).toHaveLength(8);
    const delivery = s.store.artifact(pack.deliveryId ?? "");
    expect(delivery?.content).toContain("AI generation disclosure");
    expect(s.desk[0]).toMatchObject({ kind: "deliverable", artifactId: pack.deliveryId });
    expect(s.world.sim.task(pack.taskId)).toMatchObject({ status: "done", pipeline: "forge" });
  });

  it("asks before uploading, and uploads as a dry run without butler", async () => {
    const s = setup();
    const pack = await s.forge.make({ theme: "tiny alchemy", size: 16, count: 8 });
    const base = { ...(s.desk[0] as Approval), id: "A-1", createdAt: 0, decidedAt: 1, note: null };
    await s.hooks[0]?.({ ...base, status: "approved" });
    const upload = s.desk.find((d) => d.kind === "action");
    expect(upload?.title).toMatch(/^Upload \(dry run\)/);
    await s.hooks[0]?.({
      ...(upload as Approval),
      id: "A-2",
      status: "approved",
      createdAt: 0,
      decidedAt: 2,
      note: null,
    });
    const after = s.forge.pack(pack.id);
    expect(after?.uploaded?.mode).toBe("dry-run");
    expect(after?.uploaded?.command).toMatch(/^butler push ".*\.zip" /);
  });

  it("will not upload while the kill switch is on, and survives restarts", async () => {
    const s = setup();
    const pack = await s.forge.make({ theme: "tiny alchemy", size: 16, count: 8 });
    s.store.setKv("station.kill", "on");
    await expect(s.forge.upload(pack.id)).rejects.toThrow(/kill switch/);
    s.store.setKv(`forge.pack.${pack.id}`, JSON.stringify({ ...pack, status: "working" }));
    const again = new AssetForge({
      ...(s.forge as unknown as { deps: ConstructorParameters<typeof AssetForge>[0] }).deps,
    });
    expect(again.pack(pack.id)?.status).toBe("failed");
  });
});
