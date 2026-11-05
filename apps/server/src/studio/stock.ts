import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Database from "better-sqlite3";
import { probeMedia } from "./ffmpeg";
import { type Asset, type AssetKind, type AssetLibrary, terms } from "./library";
import type { MediaHub, MediaLane } from "./media";

/**
 * Stock and public-domain footage (Stage 14): our own library first, then Pixabay, NASA's Image and
 * Video Library and Openverse (CC0, public domain and CC BY only). Searches are cached for 24 hours
 * as Pixabay asks, downloads are capped in size, and every file keeps its licence and credit.
 */

export const USER_AGENT = "OrbitalFoundryStudio/1.0 (+https://adnansn.github.io/Orbital-Foundry/)";
const DAY_MS = 86_400_000;
const MAX_BYTES = 250 * 1024 * 1024;

export interface StockHit {
  source: "pixabay" | "nasa" | "openverse";
  sourceId: string;
  kind: AssetKind;
  title: string;
  tags: string[];
  /** The item's page. */
  url: string;
  /** The file to download (for NASA, the asset manifest to resolve first). */
  file: string;
  width?: number;
  height?: number;
  duration?: number;
  licence: string;
  credit: string;
}

export interface StockRequest {
  kind: "video" | "image";
  query: string;
  lane: MediaLane;
  orientation?: "portrait" | "landscape";
  minDuration?: number;
  /** Providers to try first, e.g. ["nasa"] for a space channel. */
  prefer?: string[];
  /** Asset ids already used in this video. */
  exclude?: string[];
  /** Skip the library and fetch something new. */
  fresh?: boolean;
}

export interface StockOptions {
  hub: MediaHub;
  library: AssetLibrary;
  db: Database.Database;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

const LICENCES = {
  pixabay: "Pixabay Content License (free commercial use, no attribution required)",
  nasa: "NASA media, generally not copyrighted; NASA does not endorse this use",
};

export class StockService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: StockOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** The library's match, or a new download from the first provider that has one. */
  async fetch(req: StockRequest): Promise<Asset | null> {
    const { library, hub } = this.opts;
    const reuse = req.fresh
      ? undefined
      : library.find({
          kind: req.kind,
          query: req.query,
          ...(req.orientation ? { orientation: req.orientation } : {}),
          ...(req.minDuration ? { minDuration: req.minDuration } : {}),
          ...(req.exclude ? { exclude: req.exclude } : {}),
          limit: 1,
        })[0];
    if (reuse) return reuse;
    const order = req.kind === "video" ? ["pixabay", "nasa"] : ["pixabay", "nasa", "openverse"];
    const providers = [
      ...new Set([...(req.prefer ?? []).filter((p) => order.includes(p)), ...order]),
    ];
    for (const provider of providers) {
      if (!hub.available(provider, req.lane)) continue;
      try {
        const hits = (await this.search(provider, req)).filter(
          (h) => !library.get(assetId(h)) && !(req.exclude ?? []).includes(assetId(h)),
        );
        const best = pick(hits, req);
        if (best) return await this.download(best, req.lane);
      } catch (err) {
        this.opts.log?.(
          `stock: ${provider} failed for "${req.query}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  }

  async search(
    provider: string,
    req: Pick<StockRequest, "kind" | "query" | "lane" | "orientation">,
  ): Promise<StockHit[]> {
    const q = req.query.slice(0, 90);
    switch (provider) {
      case "pixabay":
        return this.pixabay(q, req);
      case "nasa":
        return this.nasa(q, req);
      case "openverse":
        return req.kind === "image" ? this.openverse(q, req) : [];
      default:
        return [];
    }
  }

  private async pixabay(
    q: string,
    req: Pick<StockRequest, "kind" | "lane" | "orientation">,
  ): Promise<StockHit[]> {
    const key = this.opts.hub.key("pixabay");
    if (!key) return [];
    const params = new URLSearchParams({ q, per_page: "20", safesearch: "true" });
    if (req.kind === "image") {
      params.set("image_type", "photo");
      if (req.orientation)
        params.set("orientation", req.orientation === "portrait" ? "vertical" : "horizontal");
    }
    const base =
      req.kind === "video" ? "https://pixabay.com/api/videos/" : "https://pixabay.com/api/";
    const body = (await this.cachedJson(
      "pixabay",
      req.lane,
      `${base}?${params}`,
      `${base}?key=${encodeURIComponent(key)}&${params}`,
    )) as {
      hits?: Record<string, unknown>[];
    };
    return (body.hits ?? []).flatMap((h): StockHit[] => {
      const tags = String(h.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const common = {
        source: "pixabay" as const,
        sourceId: String(h.id),
        title: tags.slice(0, 4).join(", ") || `Pixabay ${String(h.id)}`,
        tags,
        url: String(h.pageURL ?? ""),
        licence: LICENCES.pixabay,
        credit: "",
      };
      if (req.kind === "video") {
        const v = h.videos as
          | Record<string, { url?: string; width?: number; height?: number; size?: number }>
          | undefined;
        const file =
          [v?.large, v?.medium, v?.small].find(
            (x) => x?.url && (x.width ?? 0) <= 1920 && (x.size ?? 0) < MAX_BYTES,
          ) ?? v?.medium;
        if (!file?.url) return [];
        return [
          {
            ...common,
            kind: "video",
            file: file.url,
            ...(file.width ? { width: file.width } : {}),
            ...(file.height ? { height: file.height } : {}),
            ...(h.duration ? { duration: Number(h.duration) } : {}),
          },
        ];
      }
      const file = String(h.largeImageURL ?? h.webformatURL ?? "");
      if (!file) return [];
      return [
        {
          ...common,
          kind: "image",
          file,
          ...(h.imageWidth ? { width: Number(h.imageWidth) } : {}),
          ...(h.imageHeight ? { height: Number(h.imageHeight) } : {}),
        },
      ];
    });
  }

  private async nasa(q: string, req: Pick<StockRequest, "kind" | "lane">): Promise<StockHit[]> {
    const params = new URLSearchParams({ q, media_type: req.kind, page_size: "20" });
    const url = `https://images-api.nasa.gov/search?${params}`;
    const body = (await this.cachedJson("nasa", req.lane, url, url)) as {
      collection?: { items?: { href?: string; data?: Record<string, unknown>[] }[] };
    };
    return (body.collection?.items ?? []).flatMap((item): StockHit[] => {
      const d = item.data?.[0];
      if (!d || !item.href) return [];
      const description = String(d.description ?? "");
      // Third-party material in NASA's library keeps its own copyright: leave it out.
      if (/©|copyright|courtesy of|getty|reuters|associated press/i.test(description)) return [];
      const who = String(d.secondary_creator ?? d.photographer ?? "").trim();
      const center = String(d.center ?? "").trim();
      const credit = who && /nasa/i.test(who) ? who : `NASA${center ? `/${center}` : ""}`;
      return [
        {
          source: "nasa",
          sourceId: String(d.nasa_id),
          kind: req.kind,
          title: String(d.title ?? d.nasa_id),
          tags: ((d.keywords as string[] | undefined) ?? []).flatMap((k) => terms(k)).slice(0, 20),
          url: `https://images.nasa.gov/details/${encodeURIComponent(String(d.nasa_id))}`,
          file: item.href.replace(/^http:/, "https:"),
          licence: LICENCES.nasa,
          credit,
        },
      ];
    });
  }

  private async openverse(
    q: string,
    req: Pick<StockRequest, "lane" | "orientation">,
  ): Promise<StockHit[]> {
    const params = new URLSearchParams({
      q,
      license: "cc0,pdm,by",
      page_size: "20",
      mature: "false",
    });
    if (req.orientation)
      params.set("aspect_ratio", req.orientation === "portrait" ? "tall" : "wide");
    const url = `https://api.openverse.org/v1/images/?${params}`;
    const body = (await this.cachedJson("openverse", req.lane, url, url)) as {
      results?: Record<string, unknown>[];
    };
    return (body.results ?? []).flatMap((r): StockHit[] => {
      const licence = String(r.license ?? "").toLowerCase();
      if (!["cc0", "pdm", "by"].includes(licence) || !r.url) return [];
      const version = r.license_version ? ` ${String(r.license_version)}` : "";
      const label =
        licence === "by" ? `CC BY${version}` : licence === "cc0" ? "CC0" : "Public Domain Mark";
      return [
        {
          source: "openverse",
          sourceId: String(r.id),
          kind: "image",
          title: String(r.title ?? "Untitled"),
          tags: terms(String(r.title ?? "")),
          url: String(r.foreign_landing_url ?? r.url),
          file: String(r.url),
          ...(r.width ? { width: Number(r.width) } : {}),
          ...(r.height ? { height: Number(r.height) } : {}),
          licence: label,
          credit: licence === "by" ? `by ${String(r.creator ?? "unknown")}, ${label}` : "",
        },
      ];
    });
  }

  /** A provider GET through its gate, cached for 24 hours under `cacheKey` (never the API key). */
  private async cachedJson(
    provider: string,
    lane: MediaLane,
    cacheKey: string,
    url: string,
  ): Promise<unknown> {
    const { db, hub } = this.opts;
    const row = db
      .prepare("SELECT body, fetched_at FROM media_cache WHERE key = ?")
      .get(cacheKey) as { body: string; fetched_at: string } | undefined;
    if (row && this.now() - Date.parse(row.fetched_at) < DAY_MS) return JSON.parse(row.body);
    const body = await hub.run(provider, lane, async () => {
      const res = await this.fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`${provider} answered HTTP ${res.status}`);
      return { value: await res.text(), units: 1, unit: "requests" };
    });
    db.prepare(
      "INSERT INTO media_cache (key, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
    ).run(cacheKey, body, new Date(this.now()).toISOString());
    return JSON.parse(body);
  }

  /** NASA's asset manifest lists the file sizes on offer; take a reasonable one. */
  private async nasaFile(hit: StockHit, lane: MediaLane): Promise<string> {
    const list = (await this.cachedJson("nasa", lane, hit.file, hit.file)) as
      | { collection?: { items?: { href?: string }[] } }
      | string[];
    const hrefs = (
      Array.isArray(list) ? list : (list.collection?.items ?? []).map((i) => i.href ?? "")
    ).map((h) => h.replace(/^http:/, "https:"));
    const prefs =
      hit.kind === "video"
        ? ["~large.mp4", "~medium.mp4", "~mobile.mp4", "~orig.mp4"]
        : ["~large.jpg", "~orig.jpg", "~large.png", "~orig.png", "~medium.jpg"];
    for (const p of prefs) {
      const found = hrefs.find((h) => h.toLowerCase().endsWith(p));
      if (found) return found;
    }
    throw new Error(`NASA ${hit.sourceId} has no usable ${hit.kind} file`);
  }

  private async download(hit: StockHit, lane: MediaLane): Promise<Asset> {
    const url = hit.source === "nasa" ? await this.nasaFile(hit, lane) : hit.file;
    const ext = (
      /\.(mp4|mov|webm|jpe?g|png|webp)(?:\?|$)/i.exec(url)?.[1] ??
      (hit.kind === "video" ? "mp4" : "jpg")
    ).toLowerCase();
    const id = assetId(hit);
    const file = this.opts.library.fileFor(hit.source, `${id}.${ext}`);
    await this.opts.hub.run(hit.source, lane, async () => {
      const res = await this.fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
      if (!res.ok || !res.body) throw new Error(`download answered HTTP ${res.status}`);
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > MAX_BYTES) throw new Error(`file too large (${Math.round(size / 1e6)} MB)`);
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(file));
      return { value: null, units: 1, unit: "downloads" };
    });
    const info = await probeMedia(file).catch(() => null);
    this.opts.log?.(`stock: ${hit.source} ${hit.kind} "${hit.title.slice(0, 40)}"`);
    return this.opts.library.add({
      id,
      kind: hit.kind,
      source: hit.source,
      sourceId: hit.sourceId,
      title: hit.title,
      tags: [...new Set([...hit.tags.flatMap((t) => terms(t)), ...terms(hit.title)])].slice(0, 30),
      licence: hit.licence,
      credit: hit.credit,
      url: hit.url,
      path: file,
      bytes: fs.statSync(file).size,
      ...(info?.duration && hit.kind === "video"
        ? { duration: info.duration }
        : hit.duration
          ? { duration: hit.duration }
          : {}),
      ...(info?.width ? { width: info.width } : hit.width ? { width: hit.width } : {}),
      ...(info?.height ? { height: info.height } : hit.height ? { height: hit.height } : {}),
    });
  }
}

export function assetId(hit: Pick<StockHit, "source" | "sourceId">): string {
  const prefix = { pixabay: "px", nasa: "nasa", openverse: "ov" }[hit.source];
  return `${prefix}-${hit.sourceId.replace(/[^\w-]/g, "_").slice(0, 60)}`;
}

/** The hit that fits best: long enough, the right shape, sharp enough. */
export function pick(
  hits: StockHit[],
  req: Pick<StockRequest, "orientation" | "minDuration">,
): StockHit | undefined {
  const scored = hits
    .filter(
      (h) =>
        req.minDuration === undefined || h.duration === undefined || h.duration >= req.minDuration,
    )
    .map((h) => {
      let score = 0;
      if (h.width && h.height && req.orientation) {
        const portrait = h.height > h.width;
        score += portrait === (req.orientation === "portrait") ? 2 : 0;
      }
      if (h.width && h.width >= 1280) score += 1;
      return { h, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.h;
}

/**
 * Where to start a stock clip so a shot of `need` seconds avoids its opening: NASA b-roll often
 * opens on a press slate with the NASA insignia and contact details, so skip about 30% of it.
 */
export function mediaStartFor(asset: Pick<Asset, "source" | "duration">, need: number): number {
  const d = asset.duration ?? 0;
  if (d <= need + 0.5) return 0;
  const skip = asset.source === "nasa" ? Math.max(6, d * 0.3) : Math.min(1, d * 0.1);
  return Math.round(Math.max(0, Math.min(skip, d - need - 0.2)) * 100) / 100;
}

/** The shortest clip that still leaves `need` seconds after the opening is skipped. */
export function minClipFor(source: string, need: number): number {
  return source === "nasa" ? need + 8 : need + 1;
}
