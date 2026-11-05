import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStationMap } from "@orbital/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { buildApp } from "../src/http/app";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import { chunkPlan, TikTokConnector, videoType } from "../src/uplink/tiktok";
import type { WorkDirector } from "../src/work/director";
import type { WorkStore } from "../src/work/store";

const MB = 1024 * 1024;
const REDIRECT = "https://example.github.io/site/tiktok-callback.html";
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-uplink-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A tiny MP4 header: size, "ftyp", brand "isom", then padding. */
function mp4(bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  b.writeUInt32BE(24, 0);
  b.write("ftypisom", 4, "latin1");
  return b;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  bytes: number;
}

/** Answers like TikTok's API; `statuses` are returned in turn by the status endpoint. */
function fakeTikTok(statuses = ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"]) {
  const calls: Call[] = [];
  let tokenNo = 0;
  let statusNo = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body;
    const text =
      body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : "";
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: text,
      bytes: body instanceof Uint8Array ? body.length : 0,
    });
    if (url.endsWith("/v2/oauth/token/")) {
      tokenNo++;
      return json({
        access_token: `act.${tokenNo}`,
        refresh_token: `rft.${tokenNo}`,
        open_id: "open-1",
        expires_in: 86_400,
        refresh_expires_in: 31_536_000,
        scope: "user.info.basic,video.upload",
        token_type: "Bearer",
      });
    }
    if (url.includes("/v2/user/info/")) {
      return json({
        data: {
          user: {
            open_id: "open-1",
            display_name: "Orbital Foundry",
            avatar_url: "https://x/a.jpg",
          },
        },
        error: { code: "ok" },
      });
    }
    if (url.endsWith("/v2/post/publish/inbox/video/init/")) {
      return json({
        data: { publish_id: "v_inbox_file~1", upload_url: "https://upload.test/video/?id=1" },
        error: { code: "ok" },
      });
    }
    if (url.startsWith("https://upload.test/")) return new Response(null, { status: 201 });
    if (url.endsWith("/v2/post/publish/status/fetch/")) {
      const status = statuses[Math.min(statusNo++, statuses.length - 1)];
      return json({
        data: { status, fail_reason: status === "FAILED" ? "file_format_check_failed" : undefined },
        error: { code: "ok" },
      });
    }
    if (url.endsWith("/v2/oauth/revoke/")) return json({});
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function connector(opts: { now?: () => number; killed?: () => boolean; statuses?: string[] } = {}) {
  const dir = tempDir();
  const fake = fakeTikTok(opts.statuses);
  const tiktok = new TikTokConnector({
    clientKey: "ck",
    clientSecret: "cs",
    redirectUri: REDIRECT,
    stationPort: 8787,
    dir: path.join(dir, "uplink"),
    secretsDir: path.join(dir, "secrets"),
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.killed ? { killed: opts.killed } : {}),
  });
  return { tiktok, dir, ...fake };
}

async function connect(tiktok: TikTokConnector): Promise<void> {
  const state =
    new URL(tiktok.startConnect("http://localhost:5173/")).searchParams.get("state") ?? "";
  await tiktok.finishConnect({ code: "code-1", state });
}

describe("chunkPlan", () => {
  it("sends small files in one piece and big ones in 16 MB parts", () => {
    expect(chunkPlan(3 * MB)).toMatchObject({ chunkSize: 3 * MB, count: 1 });
    expect(chunkPlan(50 * MB).count).toBe(1);
    const big = chunkPlan(100 * MB);
    expect(big).toMatchObject({ chunkSize: 16 * MB, count: 6 });
    expect(big.ranges[0]).toEqual([0, 16 * MB - 1]);
    expect(big.ranges.at(-1)).toEqual([80 * MB, 100 * MB - 1]);
    for (let i = 1; i < big.ranges.length; i++) {
      expect(big.ranges[i]?.[0]).toBe((big.ranges[i - 1]?.[1] ?? 0) + 1);
    }
    expect(() => chunkPlan(0)).toThrow(/empty/);
  });

  it("recognizes MP4, MOV and WebM files", () => {
    expect(videoType(mp4(64))).toBe("video/mp4");
    const mov = mp4(64);
    mov.write("qt  ", 8, "latin1");
    expect(videoType(mov)).toBe("video/quicktime");
    expect(videoType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe("video/webm");
    expect(videoType(Buffer.from("not a video at all"))).toBeNull();
  });
});

describe("TikTokConnector", () => {
  it("builds the consent URL with our scopes, redirect and a port-tagged state", () => {
    const { tiktok } = connector();
    const url = new URL(tiktok.startConnect("http://localhost:5173/?x=1"));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("ck");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.upload");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toMatch(/^8787\.[0-9a-f]{36}$/);
    expect(() => tiktok.startConnect("https://evil.example/")).toThrow(/this computer/);
  });

  it("exchanges the code, saves the account and accepts each state once", async () => {
    const { tiktok, calls, dir } = connector();
    const state =
      new URL(tiktok.startConnect("http://localhost:5173/")).searchParams.get("state") ?? "";
    const result = await tiktok.finishConnect({ code: "code-1", state });
    expect(result).toEqual({ returnTo: "http://localhost:5173/" });
    const exchange = new URLSearchParams(calls[0]?.body);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("code-1");
    expect(exchange.get("redirect_uri")).toBe(REDIRECT);
    expect(exchange.get("client_secret")).toBe("cs");
    const status = tiktok.status();
    expect(status.connected).toBe(true);
    expect(status.account?.displayName).toBe("Orbital Foundry");
    expect(JSON.stringify(status)).not.toContain("act.1");
    expect(fs.existsSync(path.join(dir, "secrets", "tiktok.json"))).toBe(true);
    await expect(tiktok.finishConnect({ code: "code-1", state })).rejects.toThrow(/expired/);
    await expect(tiktok.finishConnect({ code: "x", state: "8787.forged" })).rejects.toThrow(
      /expired/,
    );
  });

  it("passes a refusal back to the station", async () => {
    const { tiktok } = connector();
    const state =
      new URL(tiktok.startConnect("http://127.0.0.1:8787/")).searchParams.get("state") ?? "";
    const result = await tiktok.finishConnect({
      state,
      error: "access_denied",
      error_description: "User cancelled",
    });
    expect(result.error).toBe("User cancelled");
    expect(tiktok.status().connected).toBe(false);
  });

  it("uploads a video to the inbox as a draft", async () => {
    const { tiktok, calls } = connector();
    await connect(tiktok);
    const record = await tiktok.upload("first.mp4", mp4(2 * MB));
    const done = await tiktok.settled(record.id);
    expect(done?.status).toBe("in_inbox");
    const init = calls.find((c) => c.url.endsWith("/inbox/video/init/"));
    expect(JSON.parse(init?.body ?? "{}")).toEqual({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: 2 * MB,
        chunk_size: 2 * MB,
        total_chunk_count: 1,
      },
    });
    expect(init?.headers.authorization).toBe("Bearer act.1");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers["content-range"]).toBe(`bytes 0-${2 * MB - 1}/${2 * MB}`);
    expect(put?.headers["content-type"]).toBe("video/mp4");
    expect(put?.bytes).toBe(2 * MB);
  });

  it("reports TikTok's failure reason", async () => {
    const { tiktok } = connector({ statuses: ["FAILED"] });
    await connect(tiktok);
    const record = await tiktok.upload("bad.mp4", mp4(1024));
    const done = await tiktok.settled(record.id);
    expect(done?.status).toBe("failed");
    expect(done?.detail).toContain("file_format_check_failed");
  });

  it("refreshes an expired access token before calling TikTok", async () => {
    let now = Date.UTC(2026, 10, 5);
    const { tiktok, calls } = connector({ now: () => now });
    await connect(tiktok);
    now += 2 * 86_400_000;
    const record = await tiktok.upload("later.mp4", mp4(1024));
    await tiktok.settled(record.id);
    const refresh = calls.filter((c) => c.url.endsWith("/v2/oauth/token/"))[1];
    expect(new URLSearchParams(refresh?.body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(refresh?.body).get("refresh_token")).toBe("rft.1");
    const init = calls.find((c) => c.url.endsWith("/inbox/video/init/"));
    expect(init?.headers.authorization).toBe("Bearer act.2");
  });

  it("refuses uploads while disconnected, killed, or for files that aren't videos", async () => {
    let killed = false;
    const { tiktok } = connector({ killed: () => killed });
    await expect(tiktok.upload("a.mp4", mp4(1024))).rejects.toThrow(/Connect TikTok/);
    await connect(tiktok);
    await expect(
      tiktok.upload("notes.txt", Buffer.from("hello world, not a video")),
    ).rejects.toThrow(/MP4/);
    killed = true;
    await expect(tiktok.upload("a.mp4", mp4(1024))).rejects.toThrow(/kill switch/);
  });

  it("revokes and forgets the tokens on disconnect", async () => {
    const { tiktok, calls, dir } = connector();
    await connect(tiktok);
    await tiktok.disconnect();
    expect(calls.some((c) => c.url.endsWith("/v2/oauth/revoke/"))).toBe(true);
    expect(tiktok.status().connected).toBe(false);
    expect(fs.existsSync(path.join(dir, "secrets", "tiktok.json"))).toBe(false);
  });
});

describe("Uplink routes", () => {
  it("serve the status, take raw video uploads and let only the callback skip the token", async () => {
    const db = openDb(path.join(tempDir(), "station.db"));
    const sim = new SimServer({ map: getStationMap(), store: new SimStore(db), seed: 3 });
    cleanups.push(() => {
      sim.stop();
      db.close();
    });
    const { tiktok } = connector();
    const app = await buildApp(
      sim,
      { director: {} as WorkDirector, store: {} as WorkStore, tiktok },
      { token: "secret" },
    );
    cleanups.push(() => void app.close());
    const auth = { authorization: "Bearer secret" };
    expect((await app.inject({ method: "GET", url: "/api/uplink/tiktok" })).statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url: "/api/uplink/tiktok", headers: auth });
    expect(status.json()).toMatchObject({ configured: true, connected: false });

    const bad = await app.inject({
      method: "GET",
      url: "/api/uplink/tiktok/callback?code=x&state=8787.nope",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("expired");

    const start = await app.inject({
      method: "POST",
      url: "/api/uplink/tiktok/connect",
      headers: auth,
      payload: { returnTo: "http://localhost:5173/" },
    });
    const state = new URL(start.json().url).searchParams.get("state") ?? "";
    const back = await app.inject({
      method: "GET",
      url: `/api/uplink/tiktok/callback?code=c&state=${encodeURIComponent(state)}`,
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("http://localhost:5173/?panel=uplink&tiktok=connected");

    const upload = await app.inject({
      method: "POST",
      url: "/api/uplink/tiktok/upload",
      headers: {
        ...auth,
        "content-type": "video/mp4",
        "x-file-name": encodeURIComponent("my clip.mp4"),
      },
      payload: mp4(4096),
    });
    expect(upload.statusCode).toBe(202);
    expect(upload.json()).toMatchObject({ file: "my clip.mp4", status: "uploading" });
    await tiktok.settled(upload.json().id);
  });
});

describe("TikTokConnector after a restart", () => {
  it("keeps waiting for TikTok's answer on uploads it already sent", async () => {
    const first = connector();
    await connect(first.tiktok);
    const record = await first.tiktok.upload("first.mp4", mp4(1024));
    await first.tiktok.settled(record.id);
    // Pretend the station stopped while TikTok was still processing.
    const file = path.join(first.dir, "uplink", "tiktok-uploads.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved[0].status = "processing";
    fs.writeFileSync(file, JSON.stringify(saved));
    const fake = fakeTikTok(["SEND_TO_USER_INBOX"]);
    const again = new TikTokConnector({
      clientKey: "ck",
      clientSecret: "cs",
      redirectUri: REDIRECT,
      stationPort: 8787,
      dir: path.join(first.dir, "uplink"),
      secretsDir: path.join(first.dir, "secrets"),
      fetchImpl: fake.fetchImpl,
      sleep: async () => {},
    });
    expect((await again.settled(record.id))?.status).toBe("in_inbox");
    expect(fake.calls.some((c) => c.url.endsWith("/status/fetch/"))).toBe(true);
  });
});
