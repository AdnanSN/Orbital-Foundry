import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TikTokConnector } from "../uplink/tiktok";

const MB = 1024 * 1024;
/** The video types TikTok takes, uploaded from the Uplink panel as raw bytes. */
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "application/octet-stream"];
export const UPLINK_UPLOAD_LIMIT = 512 * MB;

/** Reached from TikTok's redirect via the website's callback page, so it can't carry the API token. */
export const TIKTOK_CALLBACK_PATH = "/api/uplink/tiktok/callback";

const connectSchema = z.object({ returnTo: z.string().url().max(500) });
const callbackSchema = z.object({
  code: z.string().max(2_000).optional(),
  state: z.string().max(200).optional(),
  scopes: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
});

function page(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px"><h1>${esc(title)}</h1><p>${esc(message)}</p><p>Go back to the station and press Connect TikTok to try again.</p></body></html>`;
}

/** The Uplink's routes (Stage 17, TikTok first). Uploads are drafts the owner posts in TikTok. */
export function registerUplinkRoutes(app: FastifyInstance, tiktok: TikTokConnector): void {
  app.addContentTypeParser(
    VIDEO_TYPES,
    { parseAs: "buffer", bodyLimit: UPLINK_UPLOAD_LIMIT },
    (_req, body, done) => done(null, body),
  );

  app.get("/api/uplink/tiktok", async () => tiktok.status());

  app.post("/api/uplink/tiktok/connect", async (req) => ({
    url: tiktok.startConnect(connectSchema.parse(req.body).returnTo),
  }));

  app.get(TIKTOK_CALLBACK_PATH, async (req, reply) => {
    try {
      const result = await tiktok.finishConnect(callbackSchema.parse(req.query));
      const back = new URL(result.returnTo);
      back.searchParams.set("panel", "uplink");
      back.searchParams.set("tiktok", result.error ? "denied" : "connected");
      return reply.redirect(back.toString(), 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).type("text/html").send(page("TikTok sign-in didn't finish", message));
    }
  });

  app.post("/api/uplink/tiktok/disconnect", async () => {
    await tiktok.disconnect();
    return tiktok.status();
  });

  app.post("/api/uplink/tiktok/upload", { bodyLimit: UPLINK_UPLOAD_LIMIT }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: "Send the video file itself (MP4, MOV or WebM)." });
    }
    const raw = req.headers["x-file-name"];
    const name = typeof raw === "string" ? decodeURIComponent(raw) : "video.mp4";
    return reply.code(202).send(await tiktok.upload(name, req.body));
  });
}
