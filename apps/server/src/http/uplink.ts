import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { InstagramConnector } from "../uplink/instagram";
import { PLATFORMS, type UplinkPublisher } from "../uplink/publisher";
import type { TikTokConnector } from "../uplink/tiktok";
import type { YouTubeConnector } from "../uplink/youtube";

const MB = 1024 * 1024;
/** The video types TikTok takes, uploaded from the Uplink panel as raw bytes. */
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "application/octet-stream"];
export const UPLINK_UPLOAD_LIMIT = 512 * MB;

/** Reached from TikTok's redirect via the website's callback page, so it can't carry the API token. */
export const TIKTOK_CALLBACK_PATH = "/api/uplink/tiktok/callback";
/** Google sends the browser straight back here (a loopback redirect for desktop apps). */
export const YOUTUBE_CALLBACK_PATH = "/api/uplink/youtube/callback";
/** Reached from Instagram's redirect via the website's callback page. */
export const INSTAGRAM_CALLBACK_PATH = "/api/uplink/instagram/callback";
/** Sign-in callbacks: no API token, because `state` guards them. */
export const UPLINK_OPEN_PATHS = [
  TIKTOK_CALLBACK_PATH,
  YOUTUBE_CALLBACK_PATH,
  INSTAGRAM_CALLBACK_PATH,
];

export interface UplinkApi {
  tiktok?: TikTokConnector;
  youtube?: YouTubeConnector;
  instagram?: InstagramConnector;
  publisher?: UplinkPublisher;
}

const connectSchema = z.object({ returnTo: z.string().url().max(500) });
const callbackSchema = z.object({
  code: z.string().max(2_000).optional(),
  state: z.string().max(200).optional(),
  scope: z.string().max(1_000).optional(),
  scopes: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
  error_reason: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
});
const planSchema = z.object({
  videoId: z.string().min(1).max(20),
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(3).optional(),
  now: z.boolean().optional(),
});

function page(name: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = `${name} sign-in didn't finish`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px"><h1>${esc(title)}</h1><p>${esc(message)}</p><p>Go back to the station and press Connect ${esc(name)} to try again.</p></body></html>`;
}

/** Sends the browser back to the station after a sign-in, with the outcome in the query. */
async function finish(
  reply: FastifyReply,
  name: string,
  key: string,
  run: () => Promise<{ returnTo: string; error?: string }>,
) {
  try {
    const result = await run();
    const back = new URL(result.returnTo);
    back.searchParams.set("panel", "uplink");
    back.searchParams.set(key, result.error ? "denied" : "connected");
    return reply.redirect(back.toString(), 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(400).type("text/html").send(page(name, message));
  }
}

/** The Uplink's routes (Stage 17): sign-ins, TikTok drafts, post plans, kits and the posts list. */
export function registerUplinkRoutes(app: FastifyInstance, api: UplinkApi): void {
  const { tiktok, youtube, instagram, publisher } = api;

  app.get("/api/uplink", async () => ({
    publisher: publisher?.status() ?? null,
    tiktok: tiktok?.status() ?? null,
    youtube: youtube?.status() ?? null,
    instagram: instagram?.status() ?? null,
  }));

  if (tiktok) {
    app.addContentTypeParser(
      VIDEO_TYPES,
      { parseAs: "buffer", bodyLimit: UPLINK_UPLOAD_LIMIT },
      (_req, body, done) => done(null, body),
    );

    app.get("/api/uplink/tiktok", async () => tiktok.status());

    app.post("/api/uplink/tiktok/connect", async (req) => ({
      url: tiktok.startConnect(connectSchema.parse(req.body).returnTo),
    }));

    app.get(TIKTOK_CALLBACK_PATH, async (req, reply) =>
      finish(reply, "TikTok", "tiktok", () =>
        tiktok.finishConnect(callbackSchema.parse(req.query)),
      ),
    );

    app.post("/api/uplink/tiktok/disconnect", async () => {
      await tiktok.disconnect();
      return tiktok.status();
    });

    app.post(
      "/api/uplink/tiktok/upload",
      { bodyLimit: UPLINK_UPLOAD_LIMIT },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) {
          return reply.code(415).send({ error: "Send the video file itself (MP4, MOV or WebM)." });
        }
        const raw = req.headers["x-file-name"];
        const name = typeof raw === "string" ? decodeURIComponent(raw) : "video.mp4";
        return reply.code(202).send(await tiktok.upload(name, req.body));
      },
    );
  }

  if (youtube) {
    app.get("/api/uplink/youtube", async () => youtube.status());
    app.post("/api/uplink/youtube/connect", async (req) => ({
      url: youtube.startConnect(connectSchema.parse(req.body).returnTo),
    }));
    app.get(YOUTUBE_CALLBACK_PATH, async (req, reply) =>
      finish(reply, "YouTube", "youtube", () =>
        youtube.finishConnect(callbackSchema.parse(req.query)),
      ),
    );
    app.post("/api/uplink/youtube/disconnect", async () => {
      youtube.disconnect();
      return youtube.status();
    });
  }

  if (instagram) {
    app.get("/api/uplink/instagram", async () => instagram.status());
    app.post("/api/uplink/instagram/connect", async (req) => ({
      url: instagram.startConnect(connectSchema.parse(req.body).returnTo),
    }));
    app.get(INSTAGRAM_CALLBACK_PATH, async (req, reply) =>
      finish(reply, "Instagram", "instagram", () =>
        instagram.finishConnect(callbackSchema.parse(req.query)),
      ),
    );
    app.post("/api/uplink/instagram/disconnect", async () => {
      instagram.disconnect();
      return instagram.status();
    });
  }

  if (publisher) {
    app.get("/api/uplink/posts", async (req) => {
      const q = z.object({ videoId: z.string().max(20).optional() }).parse(req.query ?? {});
      return publisher.posts(q);
    });

    /** Files a post plan at the Owner's Desk (posting itself waits for that approval). */
    app.post("/api/uplink/posts", async (req, reply) => {
      const body = planSchema.parse(req.body ?? {});
      try {
        return reply.code(201).send(publisher.propose(body.videoId, body));
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post<{ Params: { id: string } }>("/api/uplink/posts/:id/resume", async (req, reply) => {
      try {
        return await publisher.resume(req.params.id);
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post<{ Params: { id: string } }>("/api/uplink/posts/:id/cancel", async (req, reply) => {
      try {
        return await publisher.cancel(req.params.id);
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.get<{ Params: { id: string } }>("/api/uplink/posts/:id/kit", async (req, reply) => {
      try {
        const kit = publisher.kitZip(req.params.id);
        reply.header("content-type", "application/zip");
        reply.header("content-disposition", `attachment; filename="${kit.name}"`);
        return reply.send(Buffer.from(kit.data));
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}
