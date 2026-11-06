import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Approval, Lane } from "@orbital/shared";
import { getStationMap } from "@orbital/shared";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { buildApp } from "../src/http/app";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import type { VideoDoc } from "../src/studio/editbay";
import { InstagramConnector } from "../src/uplink/instagram";
import {
  DEFAULT_UPLINK,
  nextSlot,
  type Platform,
  type UplinkConfig,
  UplinkPublisher,
} from "../src/uplink/publisher";
import { YouTubeConnector, type YouTubeUploadInput } from "../src/uplink/youtube";
import { Outbox } from "../src/vault/ledger";
import type { WorkDirector } from "../src/work/director";
import { WorkStore } from "../src/work/store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-publish-"));
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Thursday 5 November 2026, 10:00 local time. */
const T0 = new Date(2026, 10, 5, 10, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);

function makeVideo(dir: string, extra: Partial<VideoDoc> = {}): VideoDoc {
  const file = path.join(dir, "video.mp4");
  fs.writeFileSync(file, Buffer.from("\0\0\0\x18ftypisom fake video bytes"));
  const thumbnail = path.join(dir, "thumbnail.png");
  fs.writeFileSync(thumbnail, "png");
  const srt = path.join(dir, "captions.srt");
  fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
  const metadata = path.join(dir, "metadata.json");
  fs.writeFileSync(
    metadata,
    JSON.stringify({
      youtube: {
        title: "The lightning that floats",
        description: "What ball lightning is.",
        tags: ["science", "lightning"],
        categoryId: "28",
        containsSyntheticMedia: false,
      },
      tiktok: { caption: "The lightning that floats #science", isAigc: false },
      instagram: { caption: "The lightning that floats\n\n#science\n\nNarration: AI voice." },
    }),
  );
  const iso = new Date(T0).toISOString();
  return {
    id: "V-0001",
    scriptId: "S-1",
    channel: "phenomena",
    format: "short",
    kind: "main",
    test: false,
    status: "approved",
    stage: "done",
    progress: 100,
    title: "The lightning that floats",
    titles: [],
    description: "What ball lightning is.",
    tags: ["science", "lightning"],
    file,
    srt,
    thumbnail,
    metadata,
    duration: 40,
    shots: [],
    assets: [],
    disclosure: { syntheticMedia: false, aiNarration: true },
    lane: "live",
    artifactId: "F-V1",
    createdAt: iso,
    updatedAt: iso,
    ...extra,
  };
}

function setup(
  opts: {
    mode?: "dry-run" | "live";
    lane?: Lane;
    connected?: Partial<Record<Platform, boolean>>;
    config?: UplinkConfig;
    videos?: (dir: string) => VideoDoc[];
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(root, "p-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => db.close());
  const store = new WorkStore(db);
  const list = opts.videos?.(dir) ?? [makeVideo(dir)];
  for (const v of list) {
    store.saveArtifact(
      {
        id: v.artifactId ?? "F-X",
        kind: "studio.video",
        title: v.title,
        mime: "text/markdown",
        taskId: null,
        objectiveId: null,
        createdBy: "frame",
        createdAt: 0,
        size: 1,
      },
      "video",
    );
  }
  const vids = new Map(list.map((v) => [v.id, v]));
  const videos = {
    video: (id: string) => vids.get(id) ?? null,
    videos: () => [...vids.values()],
    save: (v: VideoDoc) => void vids.set(v.id, v),
  };
  const desk: Approval[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  const director = {
    fileDeskItem: (f: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">) => {
      const a = {
        ...f,
        id: `A-${desk.length + 1}`,
        status: "pending",
        createdAt: 0,
        decidedAt: null,
        note: null,
      } as Approval;
      desk.push(a);
      return a;
    },
    onDecision: (h: (a: Approval) => void | Promise<void>) => hooks.push(h),
  } as unknown as WorkDirector;
  const decide = async (a: Approval, status: "approved" | "rejected", note?: string) => {
    for (const h of hooks) await h({ ...a, status, note: note ?? null, decidedAt: 1 } as Approval);
  };
  const approveVideo = (id = "V-0001") =>
    decide(
      {
        id: `A-${id}`,
        kind: "deliverable",
        title: "Video ready",
        summary: "",
        requestedBy: "frame",
        objectiveId: null,
        taskId: null,
        artifactId: vids.get(id)?.artifactId ?? null,
        action: null,
        status: "pending",
        createdAt: 0,
        decidedAt: null,
        note: null,
      } as Approval,
      "approved",
    );
  let now = T0;
  const calls = {
    youtube: [] as YouTubeUploadInput[],
    hold: [] as string[],
    reschedule: [] as string[],
    instagram: [] as { caption: string }[],
    tiktok: [] as string[],
  };
  const connected = { youtube: true, instagram: true, tiktok: true, ...opts.connected };
  const youtube = {
    status: () => ({ connected: connected.youtube }),
    upload: async (input: YouTubeUploadInput) => {
      calls.youtube.push(input);
      const id = `yt${calls.youtube.length}`;
      return { videoId: id, url: `https://youtu.be/${id}`, warnings: [] };
    },
    hold: async (id: string) => void calls.hold.push(id),
    reschedule: async (id: string, when: string) => void calls.reschedule.push(`${id}@${when}`),
  };
  const instagram = {
    status: () => ({ connected: connected.instagram }),
    publishReel: async (input: { caption: string }) => {
      calls.instagram.push(input);
      return { mediaId: "ig1", url: "https://www.instagram.com/reel/abc/" };
    },
  };
  const tiktok = {
    status: () => ({ connected: connected.tiktok }),
    upload: async (name: string) => {
      calls.tiktok.push(name);
      return {
        id: "tt-1",
        file: name,
        bytes: 1,
        status: "processing",
        createdAt: "",
        updatedAt: "",
      };
    },
    settled: async () => ({
      id: "tt-1",
      file: "x",
      bytes: 1,
      status: "in_inbox",
      publishId: "pub-1",
      createdAt: "",
      updatedAt: "",
    }),
  };
  const notices: string[] = [];
  const publisher = new UplinkPublisher({
    videos,
    store,
    db,
    outbox: new Outbox(db),
    director,
    youtube: youtube as never,
    instagram: instagram as never,
    tiktok: tiktok as never,
    config: opts.config ?? DEFAULT_UPLINK,
    mode: opts.mode ?? "dry-run",
    lane: opts.lane ?? "live",
    dir: path.join(dir, "uplink"),
    notify: (t) => notices.push(t),
    now: () => now,
  });
  const byPlatform = () =>
    Object.fromEntries(publisher.posts().map((p) => [p.platform, p])) as Record<
      Platform,
      ReturnType<UplinkPublisher["posts"]>[number]
    >;
  return {
    publisher,
    desk,
    decide,
    approveVideo,
    calls,
    notices,
    store,
    vids,
    db,
    byPlatform,
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe("posting schedule", () => {
  const cfg = DEFAULT_UPLINK;

  it("picks the next free slot with the lead, one post per slot and the daily cap", () => {
    expect(nextSlot("short", "youtube", cfg, [], T0)).toEqual(at(5, 17));
    // 15 minutes before the slot is inside the 30-minute lead, so it moves to tomorrow.
    expect(nextSlot("short", "youtube", cfg, [], at(5, 16, 45).getTime())).toEqual(at(6, 17));
    const taken = [{ platform: "tiktok" as const, at: at(5, 17).toISOString() }];
    expect(nextSlot("short", "tiktok", cfg, taken, T0)).toEqual(at(6, 17));
    expect(nextSlot("short", "youtube", cfg, taken, T0)).toEqual(at(5, 17));
    // Long-form goes out on Saturdays at 15:00 (5 November 2026 is a Thursday).
    expect(nextSlot("long", "youtube", cfg, [], T0)).toEqual(at(7, 15));
    const two: UplinkConfig = {
      ...cfg,
      schedule: { ...cfg.schedule, shortTimes: ["09:00", "17:00"] },
      platforms: { ...cfg.platforms, instagram: { ...cfg.platforms.instagram, dailyCap: 1 } },
    };
    const one = [{ platform: "instagram" as const, at: at(5, 17).toISOString() }];
    expect(nextSlot("short", "instagram", two, one, T0)).toEqual(at(6, 9));
  });
});

describe("uplink publisher", () => {
  it("files a post plan for an approved video and runs it as a dry run", async () => {
    const t = setup();
    await t.approveVideo();
    expect(t.desk).toHaveLength(1);
    const item = t.desk[0] as Approval;
    expect(item.title).toBe("Post: The lightning that floats");
    expect(item.summary).toContain("Dry run");
    const plan = t.store.artifact(item.artifactId as string);
    expect(plan?.meta.kind).toBe("studio.post");
    expect(plan?.content).toContain("<!-- video:V-0001 -->");
    expect(plan?.content).toContain("| TikTok | Draft in your TikTok inbox |");
    expect(plan?.content).toContain("Narration: AI voice.");
    const planned = t.byPlatform();
    expect(Object.keys(planned).sort()).toEqual(["instagram", "tiktok", "youtube"]);
    for (const p of Object.values(planned)) expect(new Date(p.at)).toEqual(at(5, 17));

    await t.decide(item, "approved");
    await t.publisher.tick();
    // YouTube takes its upload at once (with a publish time); the others wait for 17:00.
    expect(t.byPlatform().youtube.status).toBe("scheduled");
    expect(t.byPlatform().youtube.remoteId).toMatch(/^dry-youtube-U-/);
    expect(t.byPlatform().tiktok.status).toBe("scheduled");

    t.setNow(at(5, 17).getTime());
    await t.publisher.tick();
    const after = t.byPlatform();
    expect([after.youtube.status, after.instagram.status, after.tiktok.status]).toEqual([
      "posted",
      "posted",
      "draft",
    ]);
    // A dry run sends nothing and leaves the video unposted.
    expect(t.calls.youtube.length + t.calls.instagram.length + t.calls.tiktok.length).toBe(0);
    expect(t.vids.get("V-0001")?.status).toBe("approved");
    expect(t.notices.some((n) => n.includes("TikTok draft ready (dry run)"))).toBe(true);
  });

  it("posts for real in live mode, once each, with the first YouTube upload unlisted", async () => {
    const t = setup({ mode: "live" });
    await t.approveVideo();
    expect(t.desk[0]?.summary).toContain("YouTube unlisted check");
    await t.decide(t.desk[0] as Approval, "approved");
    await t.publisher.tick();
    expect(t.calls.youtube).toHaveLength(1);
    expect(t.calls.youtube[0]).toMatchObject({
      privacy: "unlisted",
      publishAt: undefined,
      syntheticMedia: false,
      title: "The lightning that floats",
    });
    expect(t.byPlatform().youtube).toMatchObject({ status: "posted", remoteId: "yt1" });
    expect(t.vids.get("V-0001")?.status).toBe("posted");

    t.setNow(at(5, 17).getTime());
    await t.publisher.tick();
    expect(t.calls.instagram).toHaveLength(1);
    expect(t.calls.instagram[0]).toMatchObject({ aiGenerated: true });
    expect(t.calls.instagram[0]?.caption).toContain("Narration: AI voice.");
    expect(t.calls.tiktok).toEqual(["V-0001.mp4"]);
    expect(t.notices.some((n) => n.includes("Turn on the AI-generated content label"))).toBe(true);
    expect(t.byPlatform().tiktok).toMatchObject({ status: "draft", remoteId: "pub-1" });

    // Once only: a post that is resumed after a failure doesn't go out a second time.
    const ig = t.byPlatform().instagram;
    t.db
      .prepare(
        "UPDATE posts SET status = 'failed', data = json_set(data, '$.status', 'failed') WHERE id = ?",
      )
      .run(ig.id);
    const resumed = await t.publisher.resume(ig.id);
    expect(new Date(resumed.at)).toEqual(at(6, 17));
    t.setNow(at(6, 17).getTime());
    await t.publisher.tick();
    expect(t.byPlatform().instagram.status).toBe("posted");
    expect(t.calls.instagram).toHaveLength(1);
  });

  it("schedules later YouTube uploads with a publish time", async () => {
    const t = setup({
      mode: "live",
      videos: (dir) => [
        makeVideo(dir),
        makeVideo(dir, { id: "V-0002", format: "long", artifactId: "F-V2", title: "Deep dive" }),
      ],
    });
    await t.approveVideo("V-0001");
    await t.decide(t.desk[0] as Approval, "approved");
    await t.publisher.tick();
    await t.approveVideo("V-0002");
    const plan = t.desk[1] as Approval;
    expect(plan.summary).toContain("YouTube scheduled");
    await t.decide(plan, "approved");
    await t.publisher.tick();
    expect(t.calls.youtube[1]).toMatchObject({
      title: "The lightning that floats",
      privacy: "public",
      publishAt: at(7, 15).toISOString(),
    });
    const long = t.publisher.posts({ videoId: "V-0002" })[0];
    expect(long).toMatchObject({ platform: "youtube", status: "scheduled", remoteId: "yt2" });
  });

  it("holds everything scheduled when the kill switch goes on", async () => {
    const t = setup({
      mode: "live",
      config: { ...DEFAULT_UPLINK, youtube: { firstUploadUnlisted: false, playlists: {} } },
    });
    await t.approveVideo();
    await t.decide(t.desk[0] as Approval, "approved");
    await t.publisher.tick();
    expect(t.byPlatform().youtube).toMatchObject({ status: "scheduled", remoteId: "yt1" });
    expect(t.calls.youtube[0]?.publishAt).toBe(at(5, 17).toISOString());

    t.store.setKv("station.kill", "on");
    await t.publisher.onKill();
    expect(t.calls.hold).toEqual(["yt1"]);
    const held = t.byPlatform();
    expect([held.youtube.status, held.instagram.status, held.tiktok.status]).toEqual([
      "held",
      "held",
      "held",
    ]);
    t.setNow(at(5, 17).getTime());
    await t.publisher.tick();
    expect(t.calls.instagram.length + t.calls.tiktok.length).toBe(0);
    await expect(t.publisher.resume(held.youtube.id)).rejects.toThrow("kill switch");

    t.store.setKv("station.kill", "off");
    t.setNow(T0);
    await t.publisher.resume(held.youtube.id);
    expect(t.calls.reschedule).toEqual([`yt1@${at(5, 17).toISOString()}`]);
    expect(t.byPlatform().youtube.status).toBe("scheduled");
  });

  it("refuses test renders and sandbox videos, and cancels a plan that is sent back", async () => {
    const t = setup({
      mode: "live",
      videos: (dir) => [
        makeVideo(dir, { lane: "sandbox" }),
        makeVideo(dir, { id: "V-0002", test: true, artifactId: "F-V2" }),
      ],
    });
    expect(() => t.publisher.propose("V-0002")).toThrow("Test renders can't be posted.");
    await t.approveVideo("V-0002");
    expect(t.desk).toHaveLength(0);

    await t.approveVideo("V-0001");
    await t.decide(t.desk[0] as Approval, "approved");
    await t.publisher.tick();
    expect(t.byPlatform().youtube.status).toBe("failed");
    expect(t.byPlatform().youtube.detail).toContain("live lane");
    expect(t.calls.youtube).toHaveLength(0);

    const again = setup();
    await again.approveVideo();
    await again.decide(again.desk[0] as Approval, "rejected", "Wrong thumbnail");
    expect(again.publisher.posts().map((p) => p.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(again.publisher.posts()[0]?.detail).toBe("Wrong thumbnail");
  });

  it("makes an upload kit for a platform that isn't connected", async () => {
    const t = setup({ connected: { instagram: false, youtube: false } });
    await t.approveVideo();
    const plan = t.store.artifact(t.desk[0]?.artifactId as string);
    expect(plan?.content).toContain("| Instagram | Upload kit (not connected) |");
    await t.decide(t.desk[0] as Approval, "approved");
    await t.publisher.tick();
    // Kits are ready at once; the post time is for posting them by hand.
    expect(t.byPlatform().instagram.status).toBe("kit");
    const ig = unzipSync(t.publisher.kitZip(t.byPlatform().instagram.id).data);
    expect(Object.keys(ig).sort()).toEqual(["post.txt", "thumbnail.png", "video.mp4"]);
    const text = new TextDecoder().decode(ig["post.txt"]);
    expect(text).toContain("Narration: AI voice.");
    expect(text).toContain("AI label (Advanced settings): on (the narration is an AI voice)");
    const yt = unzipSync(t.publisher.kitZip(t.byPlatform().youtube.id).data);
    expect(Object.keys(yt)).toContain("captions.srt");
    expect(new TextDecoder().decode(yt["post.txt"])).toContain("Altered or synthetic content: No");
    expect(t.notices.some((n) => n.includes("Instagram upload kit ready"))).toBe(true);
  });
});

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
function fakeFetch(routes: [RegExp, Route][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    for (const [pattern, route] of routes) {
      if (pattern.test(`${init?.method ?? "GET"} ${url.toString()}`)) return route(url, init);
    }
    return new Response(JSON.stringify({ error: { message: `no route for ${url}` } }), {
      status: 404,
    });
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("YouTube connector", () => {
  it("signs in with PKCE, uploads resumably and counts the quota", async () => {
    const dir = fs.mkdtempSync(path.join(root, "yt-"));
    let now = T0;
    const net = fakeFetch([
      [
        /^POST https:\/\/oauth2\.googleapis\.com\/token/,
        () => json({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "s" }),
      ],
      [/channels\?part=snippet/, () => json({ items: [{ id: "UC1", snippet: { title: "OFS" } }] })],
      [
        /^POST https:\/\/www\.googleapis\.com\/upload\/youtube\/v3\/videos/,
        () => new Response("", { status: 200, headers: { location: "https://up.test/s1" } }),
      ],
      [/^PUT https:\/\/up\.test\/s1/, () => json({ id: "vid1" })],
      [/thumbnails\/set/, () => json({})],
      [/upload\/youtube\/v3\/captions/, () => json({})],
      [/^GET .*\/playlists\?/, () => json({ items: [] })],
      [/^POST .*\/playlists\?/, () => json({ id: "PL1" })],
      [/playlistItems/, () => json({})],
    ]);
    const yt = new YouTubeConnector({
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "http://127.0.0.1:8787/api/uplink/youtube/callback",
      secretsDir: dir,
      fetchImpl: net.impl,
      now: () => now,
    });
    const url = new URL(yt.startConnect("http://localhost:5173/?panel=uplink"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/api/uplink/youtube/callback",
    );
    expect(() => yt.startConnect("https://evil.test/")).toThrow("this computer");
    await expect(yt.finishConnect({ state: "nope", code: "c" })).rejects.toThrow("expired");
    const done = await yt.finishConnect({ state: url.searchParams.get("state") ?? "", code: "c1" });
    expect(done.returnTo).toBe("http://localhost:5173/");
    const tokenBody = String(net.calls[0]?.init?.body);
    expect(tokenBody).toContain("code_verifier=");
    expect(yt.status()).toMatchObject({ connected: true, channel: { id: "UC1", title: "OFS" } });

    const file = path.join(dir, "v.mp4");
    fs.writeFileSync(file, Buffer.alloc(1000, 1));
    const srt = path.join(dir, "c.srt");
    fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
    const thumb = path.join(dir, "t.png");
    fs.writeFileSync(thumb, "png");
    const res = await yt.upload({
      file,
      title: "Title",
      description: "Desc",
      tags: ["a"],
      privacy: "public",
      publishAt: "2026-11-07T15:00:00.000Z",
      syntheticMedia: true,
      thumbnail: thumb,
      srt,
      playlist: "Deep dives",
    });
    expect(res).toEqual({ videoId: "vid1", url: "https://youtu.be/vid1", warnings: [] });
    const init = net.calls.find((c) => c.url.includes("uploadType=resumable"));
    const meta = JSON.parse(String(init?.init?.body));
    expect(meta.status).toMatchObject({
      privacyStatus: "private",
      publishAt: "2026-11-07T15:00:00.000Z",
      containsSyntheticMedia: true,
      selfDeclaredMadeForKids: false,
    });
    const put = net.calls.find((c) => c.url.startsWith("https://up.test/"));
    const putHeaders = (put?.init?.headers ?? {}) as Record<string, string>;
    expect(putHeaders["content-range"]).toBe("bytes 0-999/1000");
    // 1 (channel) + 50 (thumbnail) + 400 (captions) + 1 + 50 + 50 (playlist) units, 1 upload.
    expect(yt.status().quota).toMatchObject({ uploads: 1, units: 552 });
    expect(fs.readFileSync(path.join(dir, "youtube.json"), "utf8")).toContain("rt1");

    // The access token refreshes itself once it expires.
    now += 2 * 3_600_000;
    await yt.accessToken();
    const refresh = net.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com"));
    expect(String(refresh.at(-1)?.init?.body)).toContain("grant_type=refresh_token");
  });
});

describe("Instagram connector", () => {
  it("signs in, swaps for a long-lived token and publishes a Reel from the file", async () => {
    const dir = fs.mkdtempSync(path.join(root, "ig-"));
    let now = T0;
    let polls = 0;
    const net = fakeFetch([
      [
        /^POST https:\/\/api\.instagram\.com\/oauth\/access_token/,
        () =>
          json({
            data: [
              {
                access_token: "short",
                user_id: "1789",
                permissions: "instagram_business_basic,instagram_business_content_publish",
              },
            ],
          }),
      ],
      [
        /^GET https:\/\/graph\.instagram\.com\/access_token\?/,
        () => json({ access_token: "long", expires_in: 5_184_000 }),
      ],
      [
        /^GET https:\/\/graph\.instagram\.com\/refresh_access_token/,
        () => json({ access_token: "long2", expires_in: 5_184_000 }),
      ],
      [/\/v23\.0\/me\?/, () => json({ user_id: "1789", username: "orbitalfoundry" })],
      [
        /^POST https:\/\/graph\.instagram\.com\/v23\.0\/1789\/media$/,
        () => json({ id: "C1", uri: "https://rupload.facebook.com/ig-api-upload/v23.0/C1" }),
      ],
      [/^POST https:\/\/rupload\.facebook\.com/, () => json({ success: true })],
      [/\/v23\.0\/C1\?/, () => json({ status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" })],
      [/media_publish/, () => json({ id: "M1" })],
      [/\/v23\.0\/M1\?/, () => json({ permalink: "https://www.instagram.com/reel/abc/" })],
    ]);
    const ig = new InstagramConnector({
      appId: "app",
      appSecret: "secret",
      redirectUri: "https://example.test/instagram-callback.html",
      stationPort: 8787,
      secretsDir: dir,
      fetchImpl: net.impl,
      now: () => now,
      sleep: async () => {},
    });
    const url = new URL(ig.startConnect("http://localhost:5173/"));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toContain("instagram_business_content_publish");
    const state = url.searchParams.get("state") ?? "";
    expect(state.startsWith("8787.")).toBe(true);
    await expect(ig.finishConnect({ state: "8787.nope", code: "x" })).rejects.toThrow("expired");
    await ig.finishConnect({ state, code: "abc#_" });
    expect(new URLSearchParams(String(net.calls[0]?.init?.body)).get("code")).toBe("abc");
    expect(ig.status()).toMatchObject({
      connected: true,
      account: { id: "1789", username: "orbitalfoundry" },
    });

    const file = path.join(dir, "reel.mp4");
    fs.writeFileSync(file, Buffer.alloc(2048, 2));
    const res = await ig.publishReel({ file, caption: "Hello #science", aiGenerated: true });
    expect(res).toEqual({ mediaId: "M1", url: "https://www.instagram.com/reel/abc/" });
    const container = net.calls.find((c) => c.url.endsWith("/1789/media"));
    const form = new URLSearchParams(String(container?.init?.body));
    expect(form.get("media_type")).toBe("REELS");
    expect(form.get("upload_type")).toBe("resumable");
    expect(form.get("caption")).toBe("Hello #science");
    expect(form.get("is_ai_generated")).toBe("true");
    const upload = net.calls.find((c) => c.url.startsWith("https://rupload.facebook.com"));
    const headers = upload?.init?.headers as Record<string, string>;
    expect(headers).toMatchObject({ offset: "0", file_size: "2048", authorization: "OAuth long" });

    // Within 10 days of expiry (and older than a day), the token refreshes itself.
    now += 55 * 86_400_000;
    expect(await ig.accessToken()).toBe("long2");
  });
});

describe("uplink routes", () => {
  it("leaves the sign-in callbacks open but guards everything else", async () => {
    const dir = fs.mkdtempSync(path.join(root, "routes-"));
    const db = openDb(path.join(dir, "station.db"));
    const sim = new SimServer({ map: getStationMap(), store: new SimStore(db), seed: 3 });
    cleanups.push(() => {
      sim.stop();
      db.close();
    });
    const youtube = new YouTubeConnector({
      clientId: "cid",
      clientSecret: "s",
      redirectUri: "http://127.0.0.1:8787/api/uplink/youtube/callback",
      secretsDir: dir,
    });
    const t = setup({ videos: (d) => [makeVideo(d, { test: true })] });
    const app = await buildApp(
      sim,
      {
        director: {} as WorkDirector,
        store: {} as WorkStore,
        youtube,
        uplink: t.publisher,
      },
      { token: "secret" },
    );
    cleanups.push(() => void app.close());
    const auth = { authorization: "Bearer secret" };
    expect((await app.inject({ method: "GET", url: "/api/uplink" })).statusCode).toBe(401);
    const bad = await app.inject({
      method: "GET",
      url: "/api/uplink/youtube/callback?state=nope&code=x",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("expired");
    const status = await app.inject({ method: "GET", url: "/api/uplink", headers: auth });
    expect(status.json()).toMatchObject({
      publisher: { mode: "dry-run", killed: false },
      youtube: { configured: true, connected: false },
    });
    const plan = await app.inject({
      method: "POST",
      url: "/api/uplink/posts",
      headers: auth,
      payload: { videoId: "V-0001" },
    });
    expect(plan.statusCode).toBe(409);
    expect(plan.json().error).toContain("Test renders");
  });
});
