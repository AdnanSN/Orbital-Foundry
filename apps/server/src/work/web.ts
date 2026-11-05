import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";

/**
 * Read-only web access for the agents' web_research tool (ROADMAP §6): GET requests to
 * allowlisted hosts only (config/web.yaml). Results are untrusted text and are labelled as such
 * when shown to a model.
 */

const webConfigSchema = z.object({
  allow: z.array(z.string()).default(["en.wikipedia.org"]),
  userAgent: z.string().default("OrbitalFoundry/0.4 (local research agent)"),
  maxBytes: z.number().int().positive().default(400_000),
});
export type WebConfig = z.infer<typeof webConfigSchema>;

export function loadWebConfig(file = path.join(CONFIG_DIR, "web.yaml")): WebConfig {
  if (!fs.existsSync(file)) return webConfigSchema.parse({});
  return webConfigSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")));
}

export interface SearchHit {
  title: string;
  url: string;
  summary: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class WebClient {
  constructor(
    private readonly config: WebConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  allowed(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && this.config.allow.includes(u.hostname);
    } catch {
      return false;
    }
  }

  private async get(url: string): Promise<string> {
    if (!this.allowed(url)) throw new Error(`Not on the web allowlist: ${url}`);
    const res = await this.fetchImpl(url, {
      headers: { "user-agent": this.config.userAgent, accept: "application/json, text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET ${url} failed (${res.status})`);
    const text = await res.text();
    return text.slice(0, this.config.maxBytes);
  }

  /** The plain text of a Wikipedia article (the studio's research briefs), cut to `maxChars`. */
  async article(
    title: string,
    maxChars = 8000,
  ): Promise<{ title: string; url: string; text: string }> {
    const t = encodeURIComponent(title);
    const raw = await this.get(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&titles=${t}`,
    );
    const data = JSON.parse(raw) as {
      query?: { pages?: Record<string, { title?: string; extract?: string }> };
    };
    const page = Object.values(data.query?.pages ?? {})[0];
    const name = page?.title ?? title;
    return {
      title: name,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replaceAll(" ", "_"))}`,
      text: (page?.extract ?? "").replace(/\n{2,}/g, "\n").slice(0, maxChars),
    };
  }

  /** Wikipedia search with a short summary of the top results. */
  async search(query: string, limit = 3): Promise<SearchHit[]> {
    if (!this.config.allow.includes("en.wikipedia.org")) return [];
    const q = encodeURIComponent(query.slice(0, 200));
    const raw = await this.get(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${q}`,
    );
    const data = JSON.parse(raw) as { query?: { search?: { title: string }[] } };
    const titles = (data.query?.search ?? []).map((s) => s.title).slice(0, limit);
    const hits: SearchHit[] = [];
    for (const title of titles) {
      const path = encodeURIComponent(title.replaceAll(" ", "_"));
      try {
        const summary = JSON.parse(
          await this.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${path}`),
        ) as { extract?: string; content_urls?: { desktop?: { page?: string } } };
        hits.push({
          title,
          url: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${path}`,
          summary: (summary.extract ?? "").slice(0, 900),
        });
      } catch {
        hits.push({ title, url: `https://en.wikipedia.org/wiki/${path}`, summary: "" });
      }
    }
    return hits;
  }
}
