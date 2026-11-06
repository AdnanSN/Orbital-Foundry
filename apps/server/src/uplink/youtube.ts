import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * YouTube through the Data API v3 (Stage 17, D-051, D-059): OAuth for a desktop app (Google sends
 * the browser straight back to this computer, with PKCE), resumable uploads with scheduled
 * publishing, the AI-disclosure flag, custom thumbnails, caption files, playlists and quota
 * tracking. Tokens live in data/secrets/youtube.json and never reach logs.
 */

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
/** Resumable chunks must be multiples of 256 KB. */
const CHUNK = 8 * 1024 * 1024;
const STATE_TTL_MS = 10 * 60_000;
/** The project's daily allowance: uploads have their own bucket of 100, the rest share 10,000. */
export const YOUTUBE_LIMITS = { uploads: 100, units: 10_000 };
/** What each call costs in quota units. */
export const YOUTUBE_COSTS = {
  list: 1,
  update: 50,
  thumbnail: 50,
  caption: 400,
  playlistInsert: 50,
  playlistItem: 50,
};

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface YouTubeChannel {
  id: string;
  title: string;
}

interface Saved {
  tokens: Tokens;
  channel: YouTubeChannel | null;
  /** Quota used per Pacific-time day (YouTube's reset), e.g. { "2026-11-06": { uploads, units } }. */
  quota: Record<string, { uploads: number; units: number }>;
  playlists: Record<string, string>;
}

export interface YouTubeStatus {
  configured: boolean;
  connected: boolean;
  channel: YouTubeChannel | null;
  quota: { uploads: number; units: number; limits: typeof YOUTUBE_LIMITS };
  redirectUri: string;
}

export interface YouTubeUploadInput {
  file: string;
  title: string;
  description: string;
  tags: string[];
  categoryId?: string;
  privacy: "private" | "unlisted" | "public";
  /** ISO time; YouTube makes the video public then (it stays private until). */
  publishAt?: string;
  syntheticMedia: boolean;
  thumbnail?: string;
  srt?: string;
  playlist?: string;
}

export interface YouTubeUploadResult {
  videoId: string;
  url: string;
  warnings: string[];
}

export interface YouTubeOptions {
  clientId?: string;
  clientSecret?: string;
  /** The station's own callback; desktop OAuth clients may use any loopback port and path. */
  redirectUri: string;
  secretsDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

/** YouTube's quota day runs on Pacific time. */
export function quotaDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export class YouTubeConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Map<
    string,
    { verifier: string; returnTo: string; expires: number }
  >();
  private readonly file: string;

  constructor(private readonly opts: YouTubeOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.file = path.join(opts.secretsDir, "youtube.json");
  }

  get configured(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  status(): YouTubeStatus {
    const saved = this.saved();
    const q = saved?.quota[quotaDay(this.now())] ?? { uploads: 0, units: 0 };
    return {
      configured: this.configured,
      connected: Boolean(saved?.tokens.refreshToken),
      channel: saved?.channel ?? null,
      quota: { ...q, limits: YOUTUBE_LIMITS },
      redirectUri: this.opts.redirectUri,
    };
  }

  /** Google's consent page to send the owner to. */
  startConnect(returnTo: string): string {
    if (!this.configured) {
      throw new Error(
        "Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env, then restart the station.",
      );
    }
    const back = new URL(returnTo);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(back.hostname)) {
      throw new Error("Sign-in can only return to the station on this computer.");
    }
    for (const [key, entry] of this.pending)
      if (entry.expires < this.now()) this.pending.delete(key);
    const state = randomBytes(18).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, {
      verifier,
      returnTo: `${back.origin}${back.pathname}`,
      expires: this.now() + STATE_TTL_MS,
    });
    const q = new URLSearchParams({
      client_id: this.opts.clientId ?? "",
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: YOUTUBE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    return `${AUTH}?${q}`;
  }

  async finishConnect(
    query: Record<string, string | undefined>,
  ): Promise<{ returnTo: string; error?: string }> {
    const entry = this.pending.get(query.state ?? "");
    if (!entry || entry.expires < this.now()) {
      throw new Error(
        "This sign-in link has expired or was already used. Press Connect YouTube again.",
      );
    }
    this.pending.delete(query.state ?? "");
    if (query.error || !query.code) {
      return { returnTo: entry.returnTo, error: query.error ?? "Google sent no code." };
    }
    const body = await this.token({
      code: query.code,
      grant_type: "authorization_code",
      redirect_uri: this.opts.redirectUri,
      code_verifier: entry.verifier,
    });
    if (!body.refresh_token) {
      throw new Error(
        "Google sent no refresh token. Remove the app's access in your Google account, then connect again.",
      );
    }
    const tokens = this.toTokens(body, String(body.refresh_token));
    const old = this.saved();
    this.save({ tokens, channel: null, quota: old?.quota ?? {}, playlists: {} });
    const channel = await this.channel().catch(() => null);
    this.save({ tokens, channel, quota: this.saved()?.quota ?? {}, playlists: {} });
    this.opts.log?.(`connected ${channel?.title ? `"${channel.title}"` : "a channel"}`);
    return { returnTo: entry.returnTo };
  }

  disconnect(): void {
    fs.rmSync(this.file, { force: true });
    this.opts.log?.("disconnected");
  }

  async channel(): Promise<YouTubeChannel | null> {
    const res = (await this.api("GET", `${API}/channels?part=snippet&mine=true`, undefined, 1)) as {
      items?: { id: string; snippet?: { title?: string } }[];
    };
    const item = res.items?.[0];
    return item ? { id: item.id, title: item.snippet?.title ?? "" } : null;
  }

  /** Uploads a video; the thumbnail, captions and playlist are best-effort (warnings). */
  async upload(input: YouTubeUploadInput): Promise<YouTubeUploadResult> {
    const used = this.status().quota;
    if (used.uploads >= YOUTUBE_LIMITS.uploads) {
      throw new Error("Today's 100 YouTube uploads for this project are used up.");
    }
    const size = fs.statSync(input.file).size;
    const token = await this.accessToken();
    const meta = {
      snippet: {
        title: input.title.slice(0, 100),
        description: input.description.slice(0, 5000),
        tags: input.tags.slice(0, 30),
        categoryId: input.categoryId ?? "28",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
      },
      status: {
        privacyStatus: input.publishAt ? "private" : input.privacy,
        ...(input.publishAt ? { publishAt: input.publishAt } : {}),
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: input.syntheticMedia,
      },
    };
    const init = await this.fetchImpl(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(size),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(meta),
    });
    const session = init.headers.get("location");
    if (!init.ok || !session) {
      throw new Error(
        `YouTube refused the upload (${init.status}): ${(await init.text()).slice(0, 300)}`,
      );
    }
    const video = await this.sendFile(session, input.file, size, token);
    this.spend({ uploads: 1 });
    const warnings: string[] = [];
    if (input.thumbnail && fs.existsSync(input.thumbnail)) {
      const ok = await this.optional(YOUTUBE_COSTS.thumbnail, () =>
        this.fetchImpl(`${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(video)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
          body: fs.readFileSync(input.thumbnail as string),
        }),
      );
      if (!ok) {
        warnings.push(
          "The thumbnail wasn't set (custom thumbnails need a phone-verified channel).",
        );
      }
    }
    if (input.srt && fs.existsSync(input.srt)) {
      const boundary = `orbital${randomBytes(8).toString("hex")}`;
      const head = JSON.stringify({ snippet: { videoId: video, language: "en", name: "English" } });
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${head}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
        ),
        fs.readFileSync(input.srt),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const ok = await this.optional(YOUTUBE_COSTS.caption, () =>
        this.fetchImpl(`${UPLOAD}/captions?part=snippet&uploadType=multipart`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": `multipart/related; boundary=${boundary}`,
          },
          body,
        }),
      );
      if (!ok) warnings.push("The captions file wasn't added.");
    }
    if (input.playlist) {
      await this.addToPlaylist(video, input.playlist).catch((err: unknown) => {
        warnings.push(`Not added to the playlist: ${String(err).slice(0, 120)}`);
      });
    }
    this.opts.log?.(`uploaded ${video}${input.publishAt ? ` for ${input.publishAt}` : ""}`);
    return { videoId: video, url: `https://youtu.be/${video}`, warnings };
  }

  /** Takes a scheduled video off its schedule (the kill switch): private, no publish time. */
  async hold(videoId: string, syntheticMedia: boolean): Promise<void> {
    await this.setStatus(videoId, { privacyStatus: "private" }, syntheticMedia);
  }

  /** Puts a held video back on a schedule (or makes it public now when `publishAt` is past). */
  async reschedule(videoId: string, publishAt: string, syntheticMedia: boolean): Promise<void> {
    const future = Date.parse(publishAt) > this.now() + 60_000;
    await this.setStatus(
      videoId,
      future ? { privacyStatus: "private", publishAt } : { privacyStatus: "public" },
      syntheticMedia,
    );
  }

  /** Adds the video to the channel's playlist with this title, creating it the first time. */
  async addToPlaylist(videoId: string, title: string): Promise<string> {
    const saved = this.saved();
    let id = saved?.playlists[title];
    if (!id) {
      const list = (await this.api(
        "GET",
        `${API}/playlists?part=snippet&mine=true&maxResults=50`,
        undefined,
        YOUTUBE_COSTS.list,
      )) as { items?: { id: string; snippet?: { title?: string } }[] };
      id = list.items?.find((p) => p.snippet?.title === title)?.id;
      if (!id) {
        const made = (await this.api(
          "POST",
          `${API}/playlists?part=snippet,status`,
          { snippet: { title }, status: { privacyStatus: "public" } },
          YOUTUBE_COSTS.playlistInsert,
        )) as { id: string };
        id = made.id;
      }
      const now = this.saved();
      if (now) this.save({ ...now, playlists: { ...now.playlists, [title]: id } });
    }
    await this.api(
      "POST",
      `${API}/playlistItems?part=snippet`,
      { snippet: { playlistId: id, resourceId: { kind: "youtube#video", videoId } } },
      YOUTUBE_COSTS.playlistItem,
    );
    return id;
  }

  /** Subscribers, lifetime views and uploads (channels.list, 1 unit). */
  async channelStats(): Promise<{ subscribers: number; views: number; videos: number }> {
    const res = (await this.api(
      "GET",
      `${API}/channels?part=statistics&mine=true`,
      undefined,
      YOUTUBE_COSTS.list,
    )) as {
      items?: {
        statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string };
      }[];
    };
    const s = res.items?.[0]?.statistics;
    return {
      subscribers: Number(s?.subscriberCount ?? 0),
      views: Number(s?.viewCount ?? 0),
      videos: Number(s?.videoCount ?? 0),
    };
  }

  /** Views and watch minutes by content type (SHORTS, VIDEO_ON_DEMAND…), for the Partner Program. */
  async byContentType(
    startDate: string,
    endDate: string,
  ): Promise<Record<string, { views: number; minutes: number }>> {
    const q = new URLSearchParams({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "views,estimatedMinutesWatched",
      dimensions: "creatorContentType",
    });
    const res = (await this.api("GET", `${ANALYTICS}?${q}`, undefined, 0)) as {
      rows?: (string | number)[][];
    };
    const out: Record<string, { views: number; minutes: number }> = {};
    for (const [type, views, minutes] of res.rows ?? []) {
      out[String(type)] = { views: Number(views ?? 0), minutes: Number(minutes ?? 0) };
    }
    return out;
  }

  /** Where one video's views came from (YT_SEARCH, SUGGESTED, SHORTS, EXT_URL and so on). */
  async trafficSources(
    videoId: string,
    startDate: string,
    endDate: string,
  ): Promise<Record<string, number>> {
    const q = new URLSearchParams({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "views",
      dimensions: "insightTrafficSourceType",
      filters: `video==${videoId}`,
      sort: "-views",
      maxResults: "10",
    });
    const res = (await this.api("GET", `${ANALYTICS}?${q}`, undefined, 0)) as {
      rows?: (string | number)[][];
    };
    return Object.fromEntries((res.rows ?? []).map(([k, v]) => [String(k), Number(v ?? 0)]));
  }

  /** Per-video numbers from YouTube Analytics (Stage 19). Dates are YYYY-MM-DD. */
  async stats(
    videoIds: string[],
    startDate: string,
    endDate: string,
  ): Promise<Record<string, Record<string, number>>> {
    if (videoIds.length === 0) return {};
    const metrics = [
      "views",
      "estimatedMinutesWatched",
      "averageViewDuration",
      "averageViewPercentage",
      "subscribersGained",
      "likes",
      "comments",
      "shares",
    ];
    const q = new URLSearchParams({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: metrics.join(","),
      dimensions: "video",
      filters: `video==${videoIds.slice(0, 200).join(",")}`,
      maxResults: "200",
    });
    const res = (await this.api("GET", `${ANALYTICS}?${q}`, undefined, 0)) as {
      columnHeaders?: { name: string }[];
      rows?: (string | number)[][];
    };
    const names = (res.columnHeaders ?? []).map((c) => c.name);
    const out: Record<string, Record<string, number>> = {};
    for (const row of res.rows ?? []) {
      const rec: Record<string, number> = {};
      names.forEach((n, i) => {
        if (n !== "video") rec[n] = Number(row[i] ?? 0);
      });
      out[String(row[names.indexOf("video")])] = rec;
    }
    return out;
  }

  /** A call to the Data API with a fresh token, counted against the day's quota. */
  async api(method: string, url: string, body: unknown, units: number): Promise<unknown> {
    const used = this.status().quota.units;
    if (units > 0 && used + units > YOUTUBE_LIMITS.units) {
      throw new Error("Today's YouTube quota (10,000 units) is used up.");
    }
    const token = await this.accessToken();
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (units > 0) this.spend({ units });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new Error(`YouTube: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return json;
  }

  async accessToken(): Promise<string> {
    const saved = this.saved();
    if (!saved) throw new Error("Connect YouTube first.");
    if (saved.tokens.expiresAt - 60_000 > this.now()) return saved.tokens.accessToken;
    const body = await this.token({
      grant_type: "refresh_token",
      refresh_token: saved.tokens.refreshToken,
    });
    const tokens = this.toTokens(body, saved.tokens.refreshToken);
    this.save({ ...saved, tokens });
    return tokens.accessToken;
  }

  private async sendFile(session: string, file: string, size: number, token: string) {
    const fd = fs.openSync(file, "r");
    try {
      let start = 0;
      for (let tries = 0; start < size && tries < 2_000; tries++) {
        const end = Math.min(size, start + CHUNK) - 1;
        const buf = Buffer.alloc(end - start + 1);
        fs.readSync(fd, buf, 0, buf.length, start);
        const res = await this.fetchImpl(session, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "video/mp4",
            "content-range": `bytes ${start}-${end}/${size}`,
          },
          body: buf,
        });
        if (res.status === 308) {
          // YouTube says how much it has; carry on from there.
          const got = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
          start = got ? Number(got[1]) + 1 : end + 1;
          continue;
        }
        if (!res.ok) throw new Error(`YouTube's upload stopped at byte ${start} (${res.status}).`);
        const video = (await res.json()) as { id?: string };
        if (!video.id) throw new Error("YouTube finished the upload without a video id.");
        return video.id;
      }
    } finally {
      fs.closeSync(fd);
    }
    throw new Error("YouTube never confirmed the upload.");
  }

  private async setStatus(
    videoId: string,
    status: { privacyStatus: string; publishAt?: string },
    syntheticMedia: boolean,
  ): Promise<void> {
    // An update replaces the whole status part, so the disclosure flags go along every time.
    await this.api(
      "PUT",
      `${API}/videos?part=status`,
      {
        id: videoId,
        status: {
          ...status,
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: syntheticMedia,
        },
      },
      YOUTUBE_COSTS.update,
    );
  }

  private async optional(units: number, call: () => Promise<Response>): Promise<boolean> {
    if (this.status().quota.units + units > YOUTUBE_LIMITS.units) return false;
    const res = await call().catch(() => null);
    this.spend({ units });
    return Boolean(res?.ok);
  }

  private spend(add: { uploads?: number; units?: number }): void {
    const saved = this.saved();
    if (!saved) return;
    const day = quotaDay(this.now());
    const q = saved.quota[day] ?? { uploads: 0, units: 0 };
    const quota = Object.fromEntries(
      Object.entries(saved.quota)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-14),
    );
    quota[day] = { uploads: q.uploads + (add.uploads ?? 0), units: q.units + (add.units ?? 0) };
    this.save({ ...saved, quota });
  }

  private async token(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.clientId ?? "",
        client_secret: this.opts.clientSecret ?? "",
        ...fields,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !body.access_token) {
      throw new Error(
        `Google sign-in failed: ${String(body.error_description ?? body.error ?? res.status)}`,
      );
    }
    return body;
  }

  private toTokens(body: Record<string, unknown>, refresh: string): Tokens {
    return {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token ?? refresh),
      expiresAt: this.now() + Number(body.expires_in ?? 3600) * 1000,
      scopes: String(body.scope ?? "")
        .split(" ")
        .filter(Boolean),
    };
  }

  private saved(): Saved | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Saved>;
      if (!raw.tokens) return null;
      return {
        tokens: raw.tokens,
        channel: raw.channel ?? null,
        quota: raw.quota ?? {},
        playlists: raw.playlists ?? {},
      };
    } catch {
      return null;
    }
  }

  private save(data: Saved): void {
    fs.mkdirSync(this.opts.secretsDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
