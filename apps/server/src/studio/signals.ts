import type Database from "better-sqlite3";
import type { MediaHub, MediaLane } from "./media";
import { USER_AGENT } from "./stock";

/**
 * Trend signals for the Trend Lab (Stage 15): Google Trends' public "trending now" feed,
 * Wikipedia's most-read articles, and YouTube's most-popular science chart when a YouTube API key
 * is set. Read-only, cached for 6 hours, each through its gate in config/media.yaml.
 */

export interface Signal {
  source: "google-trends" | "wikipedia" | "youtube";
  title: string;
  /** A rough size: searches, page views or video views. */
  volume: number;
  detail?: string;
}

const CACHE_MS = 6 * 3_600_000;
const SKIP_WIKI = /^(Main_Page|Special:|Wikipedia:|File:|Portal:|Help:|Talk:|Deaths_in_|-)/;

export class SignalService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      hub: MediaHub;
      db: Database.Database;
      fetchImpl?: typeof fetch;
      now?: () => number;
      log?: (m: string) => void;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Every source that answers; a failing source is logged and skipped. */
  async gather(lane: MediaLane, geo = "US"): Promise<Signal[]> {
    const all: Signal[] = [];
    for (const [name, get] of [
      ["google-trends", () => this.googleTrends(lane, geo)],
      ["wikimedia", () => this.wikipediaTop(lane)],
      ["youtube-data", () => this.youtubeScience(lane, geo)],
    ] as const) {
      if (!this.opts.hub.available(name, lane)) continue;
      try {
        all.push(...(await get()));
      } catch (err) {
        this.opts.log?.(
          `signals: ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return all;
  }

  async googleTrends(lane: MediaLane, geo = "US"): Promise<Signal[]> {
    const xml = await this.cached(
      "google-trends",
      lane,
      `https://trends.google.com/trending/rss?geo=${geo}`,
    );
    return parseTrendsRss(xml);
  }

  async wikipediaTop(lane: MediaLane): Promise<Signal[]> {
    const d = new Date(this.now() - 86_400_000);
    const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    const body = JSON.parse(
      await this.cached(
        "wikimedia",
        lane,
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia.org/all-access/${ymd}`,
      ),
    ) as { items?: { articles?: { article: string; views: number }[] }[] };
    return (body.items?.[0]?.articles ?? [])
      .filter((a) => !SKIP_WIKI.test(a.article))
      .slice(0, 60)
      .map((a) => ({
        source: "wikipedia" as const,
        title: a.article.replaceAll("_", " "),
        volume: a.views,
      }));
  }

  async youtubeScience(lane: MediaLane, geo = "US"): Promise<Signal[]> {
    const key = this.opts.hub.key("youtube-data");
    if (!key) return [];
    const params = new URLSearchParams({
      part: "snippet,statistics",
      chart: "mostPopular",
      regionCode: geo,
      videoCategoryId: "28",
      maxResults: "25",
    });
    const url = `https://www.googleapis.com/youtube/v3/videos?${params}`;
    const body = JSON.parse(
      await this.cached("youtube-data", lane, url, `${url}&key=${encodeURIComponent(key)}`),
    ) as {
      items?: {
        snippet?: { title?: string; channelTitle?: string };
        statistics?: { viewCount?: string };
      }[];
    };
    return (body.items ?? []).map((v) => ({
      source: "youtube" as const,
      title: v.snippet?.title ?? "",
      volume: Number(v.statistics?.viewCount ?? 0),
      ...(v.snippet?.channelTitle ? { detail: v.snippet.channelTitle } : {}),
    }));
  }

  private async cached(
    provider: string,
    lane: MediaLane,
    cacheKey: string,
    url = cacheKey,
  ): Promise<string> {
    const { db, hub } = this.opts;
    const row = db
      .prepare("SELECT body, fetched_at FROM media_cache WHERE key = ?")
      .get(cacheKey) as { body: string; fetched_at: string } | undefined;
    if (row && this.now() - Date.parse(row.fetched_at) < CACHE_MS) return row.body;
    const body = await hub.run(provider, lane, async () => {
      const res = await this.fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { value: await res.text(), units: 1, unit: "requests" };
    });
    db.prepare(
      "INSERT INTO media_cache (key, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
    ).run(cacheKey, body, new Date(this.now()).toISOString());
    return body;
  }
}

/** The titles and approximate traffic in Google Trends' RSS feed. */
export function parseTrendsRss(xml: string): Signal[] {
  const out: Signal[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const title = /<title>([^<]+)<\/title>/.exec(item)?.[1]?.trim();
    if (!title) continue;
    const traffic = /<ht:approx_traffic>([^<]+)<\/ht:approx_traffic>/.exec(item)?.[1] ?? "0";
    const volume = Number(traffic.replace(/[^\d]/g, "")) || 0;
    const news = /<ht:news_item_title>([^<]+)<\/ht:news_item_title>/.exec(item)?.[1];
    out.push({
      source: "google-trends",
      title: decode(title),
      volume,
      ...(news ? { detail: decode(news) } : {}),
    });
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
