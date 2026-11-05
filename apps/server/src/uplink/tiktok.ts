import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The Uplink's TikTok connection (ROADMAP Stage 17, built early for TikTok's app review): sign-in
 * with Login Kit for Web, token refresh, and uploads to the owner's TikTok inbox as drafts through
 * the Content Posting API. Nothing is posted publicly: the owner finishes and posts each draft in
 * the TikTok app (D-051). Tokens live in a local file under data/secrets and never reach logs.
 */

/** Only what a draft upload needs. `video.publish` (Direct Post) waits for TikTok's audit. */
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload"] as const;

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com";
const MB = 1024 * 1024;
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TikTokAccount {
  openId: string;
  displayName: string;
  avatarUrl: string;
}

interface StoredTokens {
  openId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshExpiresAt: number;
  scopes: string[];
}

export type TikTokUploadStatus = "uploading" | "processing" | "in_inbox" | "failed";

export interface TikTokUpload {
  id: string;
  file: string;
  bytes: number;
  status: TikTokUploadStatus;
  publishId?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TikTokStatus {
  configured: boolean;
  connected: boolean;
  account: TikTokAccount | null;
  scopes: string[];
  redirectUri: string;
  killed: boolean;
  uploads: TikTokUpload[];
}

export interface TikTokOptions {
  clientKey?: string;
  clientSecret?: string;
  /** Registered in the TikTok app: an https page on the website that hands the code back here. */
  redirectUri: string;
  /** The station's HTTP port, carried in `state` so the callback page knows where to send you. */
  stationPort: number;
  /** Upload records and the uploaded files (data/uplink). */
  dir: string;
  /** Tokens (data/secrets, git-ignored). */
  secretsDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The station kill switch: no uploads while it is on. */
  killed?: () => boolean;
  log?: (message: string) => void;
}

/** TikTok's chunk rules: 5 to 64 MB per chunk, files under 64 MB in one piece, at most 1,000. */
export function chunkPlan(size: number): {
  chunkSize: number;
  count: number;
  ranges: [number, number][];
} {
  if (!Number.isInteger(size) || size <= 0) throw new Error("The video file is empty.");
  if (size > 4096 * MB) throw new Error("TikTok takes video files up to 4 GB.");
  const chunkSize = size <= 64 * MB ? size : 16 * MB;
  const count = Math.floor(size / chunkSize);
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    ranges.push([start, i === count - 1 ? size - 1 : start + chunkSize - 1]);
  }
  return { chunkSize, count, ranges };
}

/** MP4 and MOV carry "ftyp" at byte 4; WebM starts with the EBML magic number. */
export function videoType(head: Uint8Array): string | null {
  if (head.length >= 12 && Buffer.from(head.subarray(4, 8)).toString("latin1") === "ftyp") {
    return Buffer.from(head.subarray(8, 10)).toString("latin1") === "qt"
      ? "video/quicktime"
      : "video/mp4";
  }
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return "video/webm";
  }
  return null;
}

/** Only this machine may receive the browser after sign-in (no open redirect). */
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

export class TikTokConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pending = new Map<string, { returnTo: string; expires: number }>();
  private readonly tokenFile: string;
  private readonly uploadsFile: string;
  private uploads: TikTokUpload[];

  constructor(private readonly opts: TikTokOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tokenFile = path.join(opts.secretsDir, "tiktok.json");
    this.uploadsFile = path.join(opts.dir, "tiktok-uploads.json");
    this.uploads = this.readJson<TikTokUpload[]>(this.uploadsFile) ?? [];
    // An upload cut off by a restart can't be resumed: say so instead of showing it as running.
    for (const u of this.uploads) {
      if (u.status === "uploading")
        this.mark(u, "failed", "The station restarted during the upload.");
    }
  }

  get configured(): boolean {
    return Boolean(this.opts.clientKey && this.opts.clientSecret);
  }

  status(): TikTokStatus {
    const saved = this.saved();
    return {
      configured: this.configured,
      connected: saved !== null && saved.tokens.refreshExpiresAt > this.now(),
      account: saved?.account ?? null,
      scopes: saved?.tokens.scopes ?? [],
      redirectUri: this.opts.redirectUri,
      killed: this.opts.killed?.() ?? false,
      uploads: this.uploads.slice(0, 20),
    };
  }

  /** The TikTok consent page to send the owner to. */
  startConnect(returnTo: string): string {
    this.requireKeys();
    const back = localReturn(returnTo);
    for (const [key, entry] of this.pending)
      if (entry.expires < this.now()) this.pending.delete(key);
    const state = `${this.opts.stationPort}.${randomBytes(18).toString("hex")}`;
    this.pending.set(state, { returnTo: back, expires: this.now() + STATE_TTL_MS });
    const q = new URLSearchParams({
      client_key: this.opts.clientKey ?? "",
      scope: TIKTOK_SCOPES.join(","),
      response_type: "code",
      redirect_uri: this.opts.redirectUri,
      state,
      disable_auto_auth: "1",
    });
    return `${AUTH_URL}?${q}`;
  }

  /** TikTok's redirect, forwarded by the website's callback page. Returns where to send the browser. */
  async finishConnect(
    query: Record<string, string | undefined>,
  ): Promise<{ returnTo: string; error?: string }> {
    const state = query.state ?? "";
    const entry = [...this.pending.entries()].find(([key]) => sameText(key, state))?.[1];
    if (!entry || entry.expires < this.now()) {
      throw new Error(
        "This sign-in link has expired or was already used. Press Connect TikTok again.",
      );
    }
    this.pending.delete(state);
    if (query.error || !query.code) {
      return {
        returnTo: entry.returnTo,
        error: query.error_description || query.error || "TikTok sent no code.",
      };
    }
    const body = await this.tokenRequest({
      code: query.code,
      grant_type: "authorization_code",
      redirect_uri: this.opts.redirectUri,
    });
    const tokens = this.toTokens(body);
    this.save(tokens, null);
    const account = await this.fetchAccount().catch((err: unknown) => {
      this.log(`connected, but the profile didn't load: ${String(err)}`);
      return null;
    });
    this.save(tokens, account ?? { openId: tokens.openId, displayName: "", avatarUrl: "" });
    this.log(`connected ${account?.displayName ? `as ${account.displayName}` : "an account"}`);
    return { returnTo: entry.returnTo };
  }

  async disconnect(): Promise<void> {
    const saved = this.saved();
    if (saved) {
      await this.form("/v2/oauth/revoke/", { token: saved.tokens.accessToken }).catch(() => {});
    }
    fs.rmSync(this.tokenFile, { force: true });
    this.log("disconnected");
  }

  /** Saves the video and starts sending it to the TikTok inbox; the record updates as it goes. */
  async upload(fileName: string, data: Buffer): Promise<TikTokUpload> {
    if (this.opts.killed?.()) throw new Error("The station kill switch is on.");
    const saved = this.saved();
    if (!saved || saved.tokens.refreshExpiresAt <= this.now())
      throw new Error("Connect TikTok first.");
    if (!saved.tokens.scopes.includes("video.upload")) {
      throw new Error("TikTok didn't grant video.upload. Connect again and allow uploads.");
    }
    const type = videoType(data.subarray(0, 16));
    if (!type) throw new Error("That file isn't an MP4, MOV or WebM video.");
    chunkPlan(data.length);
    if (this.uploads.some((u) => u.status === "uploading" || u.status === "processing")) {
      throw new Error("Another upload is still running. Wait for it to finish.");
    }
    const id = `tt-${randomUUID().slice(0, 8)}`;
    const videos = path.join(this.opts.dir, "videos");
    fs.mkdirSync(videos, { recursive: true });
    const ext = type === "video/webm" ? ".webm" : type === "video/quicktime" ? ".mov" : ".mp4";
    fs.writeFileSync(path.join(videos, `${id}${ext}`), data);
    const at = new Date(this.now()).toISOString();
    const record: TikTokUpload = {
      id,
      file: path.basename(fileName).slice(0, 120) || `${id}${ext}`,
      bytes: data.length,
      status: "uploading",
      createdAt: at,
      updatedAt: at,
    };
    this.uploads.unshift(record);
    this.uploads = this.uploads.slice(0, 100);
    this.persistUploads();
    void this.send(record, data, type).catch((err: unknown) => {
      this.mark(record, "failed", err instanceof Error ? err.message : String(err));
    });
    return record;
  }

  /** Waits for a running upload (tests and scripts). */
  async settled(id: string, timeoutMs = 15 * 60_000): Promise<TikTokUpload | undefined> {
    const until = this.now() + timeoutMs;
    for (;;) {
      const u = this.uploads.find((x) => x.id === id);
      if (!u || (u.status !== "uploading" && u.status !== "processing") || this.now() > until)
        return u;
      await this.sleep(50);
    }
  }

  private async send(record: TikTokUpload, data: Buffer, type: string): Promise<void> {
    const plan = chunkPlan(data.length);
    const init = (await this.api("POST", "/v2/post/publish/inbox/video/init/", {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: data.length,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.count,
      },
    })) as { publish_id?: string; upload_url?: string };
    if (!init.publish_id || !init.upload_url)
      throw new Error("TikTok didn't return an upload address.");
    record.publishId = init.publish_id;
    this.log(`${record.id}: sending ${(data.length / MB).toFixed(1)} MB in ${plan.count} part(s)`);
    for (const [start, end] of plan.ranges) {
      const res = await this.fetchImpl(init.upload_url, {
        method: "PUT",
        headers: {
          "content-type": type,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${data.length}`,
        },
        body: data.subarray(start, end + 1),
      });
      if (![200, 201, 206].includes(res.status)) {
        throw new Error(`TikTok refused part ${start}-${end} (HTTP ${res.status}).`);
      }
    }
    this.mark(record, "processing", "TikTok is processing the video.");
    for (let i = 0; i < 120; i++) {
      const s = (await this.api("POST", "/v2/post/publish/status/fetch/", {
        publish_id: init.publish_id,
      })) as { status?: string; fail_reason?: string };
      if (s.status === "SEND_TO_USER_INBOX" || s.status === "PUBLISH_COMPLETE") {
        this.mark(record, "in_inbox", "In your TikTok inbox: open TikTok to review and post it.");
        return;
      }
      if (s.status === "FAILED") {
        this.mark(
          record,
          "failed",
          `TikTok couldn't process it: ${s.fail_reason ?? "no reason given"}.`,
        );
        return;
      }
      await this.sleep(5_000);
    }
    this.mark(
      record,
      "failed",
      "TikTok is still processing after 10 minutes; check your TikTok inbox.",
    );
  }

  /** A TikTok API call with the owner's token, refreshed when it is about to expire. */
  private async api(method: string, apiPath: string, body?: unknown): Promise<unknown> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${API}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json; charset=UTF-8" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: unknown;
      error?: { code?: string; message?: string; log_id?: string };
    } | null;
    const code = json?.error?.code;
    if (!res.ok || (code && code !== "ok")) {
      const why = json?.error?.message || code || `HTTP ${res.status}`;
      throw new Error(`TikTok: ${why}${json?.error?.log_id ? ` (log ${json.error.log_id})` : ""}`);
    }
    return json?.data ?? {};
  }

  private async fetchAccount(): Promise<TikTokAccount> {
    const data = (await this.api(
      "GET",
      "/v2/user/info/?fields=open_id,avatar_url,display_name",
    )) as {
      user?: { open_id?: string; avatar_url?: string; display_name?: string };
    };
    return {
      openId: data.user?.open_id ?? "",
      displayName: data.user?.display_name ?? "",
      avatarUrl: data.user?.avatar_url ?? "",
    };
  }

  private async accessToken(): Promise<string> {
    const saved = this.saved();
    if (!saved || saved.tokens.refreshExpiresAt <= this.now())
      throw new Error("Connect TikTok first.");
    if (saved.tokens.expiresAt - REFRESH_MARGIN_MS > this.now()) return saved.tokens.accessToken;
    const body = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: saved.tokens.refreshToken,
    });
    const tokens = this.toTokens(body);
    this.save(tokens, saved.account);
    return tokens.accessToken;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const body = await this.form("/v2/oauth/token/", fields);
    if (typeof body.error === "string" && body.error) {
      throw new Error(`TikTok sign-in failed: ${String(body.error_description || body.error)}`);
    }
    return body;
  }

  private async form(
    apiPath: string,
    fields: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    this.requireKeys();
    const res = await this.fetchImpl(`${API}${apiPath}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
      body: new URLSearchParams({
        client_key: this.opts.clientKey ?? "",
        client_secret: this.opts.clientSecret ?? "",
        ...fields,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && !body.error) throw new Error(`TikTok answered HTTP ${res.status}.`);
    return body;
  }

  private toTokens(body: Record<string, unknown>): StoredTokens {
    const access = body.access_token;
    const refresh = body.refresh_token;
    if (typeof access !== "string" || typeof refresh !== "string") {
      throw new Error("TikTok's token reply was incomplete.");
    }
    const now = this.now();
    return {
      openId: String(body.open_id ?? ""),
      accessToken: access,
      refreshToken: refresh,
      expiresAt: now + Number(body.expires_in ?? 86_400) * 1000,
      refreshExpiresAt: now + Number(body.refresh_expires_in ?? 31_536_000) * 1000,
      scopes: String(body.scope ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  private requireKeys(): void {
    if (!this.configured) {
      throw new Error(
        "Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to .env, then restart the station.",
      );
    }
  }

  private saved(): { tokens: StoredTokens; account: TikTokAccount | null } | null {
    return this.readJson(this.tokenFile);
  }

  private save(tokens: StoredTokens, account: TikTokAccount | null): void {
    fs.mkdirSync(this.opts.secretsDir, { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify({ tokens, account }, null, 2), { mode: 0o600 });
  }

  private mark(record: TikTokUpload, status: TikTokUploadStatus, detail: string): void {
    record.status = status;
    record.detail = detail;
    record.updatedAt = new Date(this.now()).toISOString();
    this.persistUploads();
    this.log(`${record.id}: ${detail}`);
  }

  private persistUploads(): void {
    fs.mkdirSync(this.opts.dir, { recursive: true });
    fs.writeFileSync(this.uploadsFile, JSON.stringify(this.uploads, null, 2));
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }
}
