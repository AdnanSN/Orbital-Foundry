import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { AssetLibrary, creditsText, terms } from "../src/studio/library";
import { loadMediaConfig, MediaHub, MediaUsage } from "../src/studio/media";
import { SoundKit, synthBed, synthSfx } from "../src/studio/sound";
import { assetId, pick, StockService } from "../src/studio/stock";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-sources-"));
const dbs: { close: () => void }[] = [];
afterAll(() => {
  for (const db of dbs) db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(env: NodeJS.ProcessEnv = { PIXABAY_API_KEY: "pk" }) {
  const dir = fs.mkdtempSync(path.join(root, "s-"));
  const db = openDb(path.join(dir, "station.db"));
  dbs.push(db);
  const hub = new MediaHub(loadMediaConfig(), new MediaUsage(db), env);
  const library = new AssetLibrary(db, path.join(dir, "library"));
  return { db, hub, library, dir };
}

/** A fake web: Pixabay, NASA (search, manifest, files) and Openverse. */
function fakeWeb() {
  const calls: string[] = [];
  const bytes = new Uint8Array(2048);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://pixabay.com/api/videos/")) {
      return Response.json({
        hits: [
          {
            id: 11,
            pageURL: "https://pixabay.com/videos/11",
            tags: "stars, night, sky",
            duration: 3,
            videos: {
              large: {
                url: "https://cdn.pixabay.test/11-large.mp4",
                width: 1920,
                height: 1080,
                size: 1000,
              },
            },
          },
          {
            id: 12,
            pageURL: "https://pixabay.com/videos/12",
            tags: "stars, galaxy",
            duration: 20,
            videos: {
              large: {
                url: "https://cdn.pixabay.test/12-large.mp4",
                width: 1080,
                height: 1920,
                size: 1000,
              },
            },
          },
        ],
      });
    }
    if (url.startsWith("https://pixabay.com/api/")) {
      return Response.json({
        hits: [
          {
            id: 21,
            pageURL: "https://pixabay.com/photos/21",
            tags: "saturn",
            largeImageURL: "https://cdn.pixabay.test/21.jpg",
            imageWidth: 1280,
            imageHeight: 853,
          },
        ],
      });
    }
    if (url.startsWith("https://images-api.nasa.gov/search")) {
      return Response.json({
        collection: {
          items: [
            {
              href: "http://images-assets.nasa.gov/image/PIA1/collection.json",
              data: [
                {
                  nasa_id: "PIA1",
                  title: "Saturn's rings",
                  description: "Cassini image",
                  keywords: ["Saturn", "rings"],
                  center: "JPL",
                  secondary_creator: "NASA/JPL-Caltech/SSI",
                },
              ],
            },
            {
              href: "http://images-assets.nasa.gov/image/X2/collection.json",
              data: [
                {
                  nasa_id: "X2",
                  title: "Launch",
                  description: "Photo © Getty Images",
                  keywords: [],
                },
              ],
            },
          ],
        },
      });
    }
    if (url.endsWith("/PIA1/collection.json")) {
      return Response.json([
        "http://images-assets.nasa.gov/image/PIA1/PIA1~thumb.jpg",
        "http://images-assets.nasa.gov/image/PIA1/PIA1~large.jpg",
      ]);
    }
    if (url.startsWith("https://api.openverse.org/")) {
      return Response.json({
        results: [
          {
            id: "a",
            title: "Dome",
            url: "https://ov.test/a.jpg",
            foreign_landing_url: "https://flickr.test/a",
            creator: "Ann",
            license: "by-sa",
            license_version: "2.0",
            width: 800,
            height: 1200,
          },
          {
            id: "b",
            title: "Observatory at night",
            url: "https://ov.test/b.jpg",
            foreign_landing_url: "https://flickr.test/b",
            creator: "Bo",
            license: "by",
            license_version: "4.0",
            width: 800,
            height: 1200,
          },
        ],
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("asset library", () => {
  it("finds by shared terms, prefers the right shape, and counts uses", () => {
    const { library, dir } = setup();
    const file = (name: string) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, "x");
      return f;
    };
    library.add({
      id: "a",
      kind: "image",
      source: "pixabay",
      tags: ["saturn", "rings"],
      licence: "L",
      credit: "",
      path: file("a.jpg"),
      width: 1000,
      height: 600,
      bytes: 10,
    });
    library.add({
      id: "b",
      kind: "image",
      source: "nasa",
      tags: ["saturn", "planet"],
      licence: "L",
      credit: "NASA",
      path: file("b.jpg"),
      width: 600,
      height: 1000,
      bytes: 10,
    });
    library.add({
      id: "c",
      kind: "image",
      source: "nasa",
      tags: ["moon"],
      licence: "L",
      credit: "NASA",
      path: file("c.jpg"),
      bytes: 10,
    });
    expect(
      library.find({ kind: "image", query: "Saturn", orientation: "portrait" }).map((a) => a.id),
    ).toEqual(["b", "a"]);
    expect(
      library.find({ kind: "image", query: "Saturn", exclude: ["b"] }).map((a) => a.id),
    ).toEqual(["a"]);
    expect(library.find({ kind: "video", query: "Saturn" })).toEqual([]);
    library.markUsed(["a"]);
    expect(library.get("a")?.uses).toBe(1);
    expect(terms("The rings of Saturn, and its moons")).toEqual(["rings", "saturn", "moons"]);
  });

  it("trims the least recently used downloads down to a cap", () => {
    const { library, dir } = setup();
    for (const id of ["old", "mid", "new"]) {
      const f = path.join(dir, `${id}.mp4`);
      fs.writeFileSync(f, "x".repeat(100));
      library.add({
        id,
        kind: "video",
        source: "pixabay",
        tags: [],
        licence: "L",
        credit: "",
        path: f,
        bytes: 100,
      });
    }
    library.markUsed(["new"]);
    expect(library.trim(150, new Set(["mid"]))).toBe(2);
    expect(library.get("old")).toBeNull();
    expect(library.get("new")).toBeNull();
    expect(library.get("mid")).not.toBeNull();
  });

  it("writes credits grouped by what each licence asks", () => {
    const base = { kind: "image" as const, tags: [], path: "x", uses: 0, createdAt: "" };
    const text = creditsText([
      { ...base, id: "1", source: "pixabay", licence: "P", credit: "" },
      { ...base, id: "2", source: "nasa", licence: "N", credit: "NASA/JPL-Caltech" },
      {
        ...base,
        id: "3",
        source: "openverse",
        licence: "CC BY 4.0",
        credit: "by Bo, CC BY 4.0",
        title: "Observatory",
        url: "https://flickr.test/b",
      },
    ]);
    expect(text).toContain("Pixabay");
    expect(text).toContain("NASA/JPL-Caltech. NASA does not endorse this video.");
    expect(text).toContain('"Observatory" by Bo, CC BY 4.0 (https://flickr.test/b).');
  });
});

describe("stock", () => {
  it("prefers long-enough portrait footage from Pixabay and caches the search", async () => {
    const { hub, library, db } = setup();
    const web = fakeWeb();
    const stock = new StockService({ hub, library, db, fetchImpl: web.fetchImpl });
    const a = await stock.fetch({
      kind: "video",
      query: "stars",
      lane: "live",
      orientation: "portrait",
      minDuration: 5,
    });
    expect(a?.id).toBe("px-12");
    expect(a?.licence).toMatch(/Pixabay/);
    expect(fs.existsSync(a?.path ?? "")).toBe(true);
    // The API key stays out of the cache, and a second search is served from it.
    const key = (db.prepare("SELECT key FROM media_cache").get() as { key: string }).key;
    expect(key).not.toContain("pk");
    await stock.search("pixabay", { kind: "video", query: "stars", lane: "live" });
    expect(web.calls.filter((c) => c.startsWith("https://pixabay.com/api/videos/"))).toHaveLength(
      1,
    );
    // Next time the library has it.
    const again = await stock.fetch({
      kind: "video",
      query: "stars",
      lane: "live",
      orientation: "portrait",
    });
    expect(again?.id).toBe("px-12");
  });

  it("takes NASA's large file, credits the creator and skips third-party items", async () => {
    const { hub, library, db } = setup({});
    const web = fakeWeb();
    const stock = new StockService({ hub, library, db, fetchImpl: web.fetchImpl });
    const hits = await stock.search("nasa", { kind: "image", query: "saturn", lane: "live" });
    expect(hits.map((h) => h.sourceId)).toEqual(["PIA1"]);
    const a = await stock.fetch({
      kind: "image",
      query: "saturn rings",
      lane: "live",
      prefer: ["nasa"],
    });
    expect(a?.id).toBe("nasa-PIA1");
    expect(a?.credit).toBe("NASA/JPL-Caltech/SSI");
    expect(web.calls).toContain("https://images-assets.nasa.gov/image/PIA1/PIA1~large.jpg");
  });

  it("keeps only CC0, public-domain and CC BY images from Openverse", async () => {
    const { hub, library, db } = setup({});
    const stock = new StockService({ hub, library, db, fetchImpl: fakeWeb().fetchImpl });
    const hits = await stock.search("openverse", {
      kind: "image",
      query: "observatory",
      lane: "live",
    });
    expect(hits.map((h) => h.sourceId)).toEqual(["b"]);
    expect(hits[0]?.credit).toBe("by Bo, CC BY 4.0");
  });

  it("skips Pixabay without a key and falls through to the next provider", async () => {
    const { hub, library, db } = setup({});
    const stock = new StockService({ hub, library, db, fetchImpl: fakeWeb().fetchImpl });
    const a = await stock.fetch({ kind: "image", query: "saturn rings", lane: "live" });
    expect(a?.source).toBe("nasa");
    expect(assetId({ source: "openverse", sourceId: "a/b" })).toBe("ov-a_b");
  });

  it("picks by duration and shape", () => {
    const hit = {
      source: "pixabay" as const,
      kind: "video" as const,
      title: "",
      tags: [],
      url: "",
      file: "",
      licence: "",
      credit: "",
    };
    const best = pick(
      [
        { ...hit, sourceId: "wide", width: 1920, height: 1080, duration: 30 },
        { ...hit, sourceId: "tall", width: 1080, height: 1920, duration: 30 },
        { ...hit, sourceId: "short", width: 1080, height: 1920, duration: 2 },
      ],
      { orientation: "portrait", minDuration: 5 },
    );
    expect(best?.sourceId).toBe("tall");
  });
});

describe("sound kit", () => {
  it("synthesizes a bed of the right length at -6 dBFS, and short effects", () => {
    const bed = synthBed(10, "space");
    expect(bed.length).toBe(441_000);
    const peak = bed.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeCloseTo(0.5, 2);
    expect(Math.abs(bed[0] ?? 1)).toBeLessThan(0.01);
    expect(synthSfx("pop").length).toBeLessThan(44_100);
    expect(synthBed(10, "space")).toEqual(bed);
  });

  it("uses the owner's tracks with a licence sidecar before synthesizing", () => {
    const { library } = setup();
    const kit = new SoundKit(library);
    const music = path.join(library.dir, "music");
    fs.mkdirSync(music, { recursive: true });
    fs.writeFileSync(path.join(music, "nolicence.mp3"), "x");
    fs.writeFileSync(path.join(music, "nolicence.json"), JSON.stringify({ title: "?" }));
    const made = kit.music(5, "calm");
    expect(made.asset.source).toBe("code");
    expect(fs.existsSync(made.file)).toBe(true);
    fs.writeFileSync(path.join(music, "drift.mp3"), "x");
    fs.writeFileSync(
      path.join(music, "drift.json"),
      JSON.stringify({
        title: "Drift",
        licence: "YouTube Audio Library",
        credit: "Drift by Someone",
        mood: "calm",
      }),
    );
    const owned = kit.music(5, "calm");
    expect(owned.asset.source).toBe("owner");
    expect(owned.asset.credit).toBe("Drift by Someone");
    expect(kit.sfx("whoosh").duration).toBeCloseTo(0.7, 1);
  });
});

describe("clip openings", () => {
  it("skips NASA's slate and keeps enough clip for the shot", async () => {
    const { mediaStartFor, minClipFor } = await import("../src/studio/stock");
    expect(mediaStartFor({ source: "nasa", duration: 60 }, 5)).toBe(18);
    expect(mediaStartFor({ source: "nasa", duration: 12 }, 5)).toBe(6);
    expect(mediaStartFor({ source: "pixabay", duration: 20 }, 5)).toBe(1);
    expect(mediaStartFor({ source: "pixabay", duration: 5 }, 5)).toBe(0);
    expect(minClipFor("nasa", 5)).toBe(13);
  });
});

describe("relevance", () => {
  it("needs the query's proper noun, or one of its longer words", async () => {
    const { relevant } = await import("../src/studio/stock");
    expect(
      relevant({ tags: ["gravity", "house", "cartoon"], title: "Gravity" }, "Venus from space"),
    ).toBe(false);
    expect(relevant({ tags: ["venus", "planet"], title: "Venus" }, "Venus from space")).toBe(true);
    expect(relevant({ tags: ["sunflower", "woman"], title: "" }, "rocket launch night")).toBe(
      false,
    );
    expect(relevant({ tags: ["rocket", "launch"], title: "" }, "rocket launch night")).toBe(true);
  });
});
