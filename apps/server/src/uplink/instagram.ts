import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Instagram through the Instagram API with Instagram Login (Stage 17, D-051, D-059): sign-in for a
 * professional account, long-lived tokens that refresh themselves, and Reels from the local file
 * (a resumable upload to rupload.facebook.com, so no public video URL is needed). The container
 * flow is create, upload, wait until processed, publish. Tokens live in data/secrets/instagram.json.
 */

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
] as const;

const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
const VERSION = "v23.0";
const RUPLOAD = `https://rupload.facebook.com/ig-api-upload/${VERSION}`;
const STATE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export interface InstagramAccount {
  /** The professional account id that content is published under. */
  id: string;
  username: string;
}

interface StoredTokens {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  issuedAt: number;
  scopes: string[];
}

export interface InstagramStatus {
  configured: boolean;
  connected: boolean;
  account: InstagramAccount | null;
  scopes: string[];
  expiresAt: string | null;
  redirectUri: string;
}

export interface ReelInput {
  file: string;
  caption: string;
  shareToFeed?: boolean;
  /** Where the cover frame is taken from, in milliseconds. */
  thumbOffsetMs?: number;
  /** Meta's "AI info" label (`is_ai_generated`, June 2026). It can't be added after publishing. */
  aiGenerated?: boolean;
}

export interface ReelResult {
  mediaId: string;
  url?: string;
}

export interface InstagramOptions {
  appId?: string;
  appSecret?: string;
  /** Registered in the Meta app: an https page on the website that hands the code back here. */
  redirectUri: string;
  /** The station's HTTP port, carried in `state` so the callback page knows where to send you. */
  stationPort: number;
  secretsDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

function localReturn(returnTo: string): string {
  const url = new URL(returnTo);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^https?:$/.test(url.protocol)
  ) {
    throw new Error("Sign-in can only return to the station on this computer.");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class InstagramConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pending = new Map<string, { returnTo: string; expires: number }>();
  private readonly tokenFile: string;

  constructor(private readonly opts: InstagramOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tokenFile = path.join(opts.secretsDir, "instagram.json");
  }

  get configured(): boolean {
    return Boolean(this.opts.appId && this.opts.appSecret);
  }

  status(): InstagramStatus {
    const saved = this.saved();
    return {
      configured: this.configured,
      connected: saved !== null && saved.tokens.expiresAt > this.now(),
      account: saved?.account ?? null,
      scopes: saved?.tokens.scopes ?? [],
      expiresAt: saved ? new Date(saved.tokens.expiresAt).toISOString() : null,
      redirectUri: this.opts.redirectUri,
    };
  }

  /** Instagram's consent page to send the owner to. */
  startConnect(returnTo: string): string {
    if (!this.configured) {
      throw new Error(
        "Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to .env, then restart the station.",
      );
    }
    const back = localReturn(returnTo);
    for (const [key, entry] of this.pending)
      if (entry.expires < this.now()) this.pending.delete(key);
    const state = `${this.opts.stationPort}.${randomBytes(18).toString("hex")}`;
    this.pending.set(state, { returnTo: back, expires: this.now() + STATE_TTL_MS });
    const q = new URLSearchParams({
      client_id: this.opts.appId ?? "",
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: INSTAGRAM_SCOPES.join(","),
      state,
      enable_fb_login: "0",
      force_authentication: "1",
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Instagram's redirect, forwarded by the website's callback page. */
  async finishConnect(
    query: Record<string, string | undefined>,
  ): Promise<{ returnTo: string; error?: string }> {
    const state = query.state ?? "";
    const entry = [...this.pending.entries()].find(([key]) => sameText(key, state))?.[1];
    if (!entry || entry.expires < this.now()) {
      throw new Error(
        "This sign-in link has expired or was already used. Press Connect Instagram again.",
      );
    }
    this.pending.delete(state);
    if (query.error || !query.code) {
      return {
        returnTo: entry.returnTo,
        error: query.error_description || query.error_reason || query.error || "No code came back.",
      };
    }
    // Instagram appends "#_" to the code; a browser keeps it out of the query, but be safe.
    const code = query.code.replace(/#_$/, "");
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.appId ?? "",
        client_secret: this.opts.appSecret ?? "",
        grant_type: "authorization_code",
        redirect_uri: this.opts.redirectUri,
        code,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { access_token?: string; user_id?: string | number; permissions?: string }[];
      access_token?: string;
      user_id?: string | number;
      permissions?: string | string[];
      error_message?: string;
    };
    const short = body.data?.[0] ?? body;
    if (!res.ok || !short.access_token) {
      throw new Error(`Instagram sign-in failed: ${body.error_message ?? `HTTP ${res.status}`}`);
    }
    const scopes = Array.isArray(short.permissions)
      ? short.permissions
      : String(short.permissions ?? "")
          .split(",")
          .filter(Boolean);
    // Swap the one-hour token for a 60-day one.
    const long = await this.graph<{ access_token: string; expires_in?: number }>(
      "GET",
      "/access_token",
      {
        grant_type: "ig_exchange_token",
        client_secret: this.opts.appSecret ?? "",
        access_token: short.access_token,
      },
      { versioned: false, token: false },
    );
    const tokens: StoredTokens = {
      accessToken: long.access_token,
      expiresAt: this.now() + Number(long.expires_in ?? 60 * 86_400) * 1000,
      issuedAt: this.now(),
      scopes,
    };
    this.save(tokens, null);
    const account = await this.fetchAccount().catch((err: unknown) => {
      this.log(`connected, but the profile didn't load: ${String(err)}`);
      return null;
    });
    this.save(tokens, account ?? { id: String(short.user_id ?? ""), username: "" });
    this.log(`connected ${account?.username ? `@${account.username}` : "an account"}`);
    return { returnTo: entry.returnTo };
  }

  disconnect(): void {
    fs.rmSync(this.tokenFile, { force: true });
    this.log("disconnected");
  }

  /** Publishes a Reel from the local file and returns its media id and permalink. */
  async publishReel(input: ReelInput): Promise<ReelResult> {
    const account = this.requireAccount();
    const size = fs.statSync(input.file).size;
    const container = await this.graph<{ id: string; uri?: string }>(
      "POST",
      `/${account.id}/media`,
      {
        media_type: "REELS",
        upload_type: "resumable",
        caption: input.caption.slice(0, 2200),
        share_to_feed: String(input.shareToFeed ?? true),
        ...(input.thumbOffsetMs !== undefined
          ? { thumb_offset: String(Math.round(input.thumbOffsetMs)) }
          : {}),
        ...(input.aiGenerated ? { is_ai_generated: "true" } : {}),
      },
    );
    const token = await this.accessToken();
    const upload = await this.fetchImpl(container.uri ?? `${RUPLOAD}/${container.id}`, {
      method: "POST",
      headers: {
        authorization: `OAuth ${token}`,
        offset: "0",
        file_size: String(size),
        "content-type": "application/octet-stream",
      },
      body: fs.readFileSync(input.file),
    });
    if (!upload.ok) {
      throw new Error(`Instagram refused the video file (${upload.status}).`);
    }
    // Meta asks for gentle polling: the container usually finishes within a minute or two.
    for (let i = 0; ; i++) {
      const state = await this.graph<{ status_code?: string; status?: string }>(
        "GET",
        `/${container.id}`,
        { fields: "status_code,status" },
      );
      if (state.status_code === "FINISHED") break;
      if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
        throw new Error(
          `Instagram couldn't process the Reel: ${state.status ?? state.status_code}`,
        );
      }
      if (i >= 40) throw new Error("Instagram is still processing the Reel after 10 minutes.");
      await this.sleep(15_000);
    }
    const published = await this.graph<{ id: string }>("POST", `/${account.id}/media_publish`, {
      creation_id: container.id,
    });
    const link = await this.graph<{ permalink?: string }>("GET", `/${published.id}`, {
      fields: "permalink",
    }).catch(() => ({ permalink: undefined }));
    this.log(`published Reel ${published.id}`);
    return { mediaId: published.id, url: link.permalink };
  }

  /** How many posts the API has published in the last 24 hours (the cap is 100). */
  async publishingLimit(): Promise<{ used: number; total: number }> {
    const account = this.requireAccount();
    const res = await this.graph<{
      data?: { quota_usage?: number; config?: { quota_total?: number } }[];
    }>("GET", `/${account.id}/content_publishing_limit`, { fields: "quota_usage,config" });
    const row = res.data?.[0];
    return { used: Number(row?.quota_usage ?? 0), total: Number(row?.config?.quota_total ?? 100) };
  }

  /** Followers and posts on the account (Stage 19). */
  async account(): Promise<{ followers: number; media: number }> {
    const me = await this.graph<{ followers_count?: number; media_count?: number }>("GET", "/me", {
      fields: "followers_count,media_count",
    });
    return { followers: Number(me.followers_count ?? 0), media: Number(me.media_count ?? 0) };
  }

  /** A Reel's numbers for the learning loop (Stage 19). */
  async insights(mediaId: string): Promise<Record<string, number>> {
    const res = await this.graph<{ data?: { name: string; values?: { value?: number }[] }[] }>(
      "GET",
      `/${mediaId}/insights`,
      { metric: "views,reach,likes,comments,shares,saved,ig_reels_avg_watch_time" },
    );
    const out: Record<string, number> = {};
    for (const m of res.data ?? []) out[m.name] = Number(m.values?.[0]?.value ?? 0);
    return out;
  }

  /** A fresh long-lived token: refreshed once it is a day old and within 10 days of expiring. */
  async accessToken(): Promise<string> {
    const saved = this.saved();
    if (!saved || saved.tokens.expiresAt <= this.now()) throw new Error("Connect Instagram first.");
    const t = saved.tokens;
    if (t.expiresAt - this.now() < 10 * DAY_MS && this.now() - t.issuedAt > DAY_MS) {
      const res = await this.graph<{ access_token: string; expires_in?: number }>(
        "GET",
        "/refresh_access_token",
        { grant_type: "ig_refresh_token", access_token: t.accessToken },
        { versioned: false, token: false },
      );
      const tokens: StoredTokens = {
        ...t,
        accessToken: res.access_token,
        expiresAt: this.now() + Number(res.expires_in ?? 60 * 86_400) * 1000,
        issuedAt: this.now(),
      };
      this.save(tokens, saved.account);
      return tokens.accessToken;
    }
    return t.accessToken;
  }

  private requireAccount(): InstagramAccount {
    const saved = this.saved();
    if (!saved || saved.tokens.expiresAt <= this.now()) throw new Error("Connect Instagram first.");
    if (!saved.account?.id) throw new Error("The Instagram account id is missing; connect again.");
    if (!saved.tokens.scopes.includes("instagram_business_content_publish")) {
      throw new Error("Instagram didn't grant publishing. Connect again and allow it.");
    }
    return saved.account;
  }

  private async fetchAccount(): Promise<InstagramAccount> {
    const me = await this.graph<{ user_id?: string | number; id?: string; username?: string }>(
      "GET",
      "/me",
      { fields: "user_id,username" },
    );
    return { id: String(me.user_id ?? me.id ?? ""), username: me.username ?? "" };
  }

  private async graph<T>(
    method: "GET" | "POST",
    apiPath: string,
    params: Record<string, string>,
    opts: { versioned?: boolean; token?: boolean } = {},
  ): Promise<T> {
    const fields = { ...params };
    if (opts.token !== false) fields.access_token = await this.accessToken();
    const base = `${GRAPH}${opts.versioned === false ? "" : `/${VERSION}`}${apiPath}`;
    const q = new URLSearchParams(fields);
    const res =
      method === "GET"
        ? await this.fetchImpl(`${base}?${q}`)
        : await this.fetchImpl(base, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: q,
          });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok || body.error) {
      throw new Error(`Instagram: ${body.error?.message ?? `HTTP ${res.status}`}`);
    }
    return body;
  }

  private saved(): { tokens: StoredTokens; account: InstagramAccount | null } | null {
    try {
      return JSON.parse(fs.readFileSync(this.tokenFile, "utf8"));
    } catch {
      return null;
    }
  }

  private save(tokens: StoredTokens, account: InstagramAccount | null): void {
    fs.mkdirSync(this.opts.secretsDir, { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify({ tokens, account }, null, 2), { mode: 0o600 });
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }
}
