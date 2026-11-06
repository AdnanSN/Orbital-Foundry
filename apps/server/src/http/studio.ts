import fs from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotEnoughStatsError, type StudioAnalytics } from "../studio/analytics";
import type { StudioBoard } from "../studio/board";
import type { EditBay } from "../studio/editbay";
import type { GpuQueue } from "../studio/gpu";
import type { StudioSchedule } from "../studio/schedule";
import type { WritersRoom } from "../studio/writers";
import { PLATFORMS } from "../uplink/publisher";

/** The studio's routes (Stage 15 on): channels, the niche study, ideas, scripts and videos. */
export interface StudioApi {
  writers: WritersRoom;
  editbay?: EditBay;
  /** The GPU lane (Stage 18). */
  gpu?: GpuQueue;
  /** Stats and the learning loop (Stage 19). */
  analytics?: StudioAnalytics;
  /** The always-on studio and the Studio panel's board (Stage 20). */
  schedule?: StudioSchedule;
  board?: StudioBoard;
}

const statsSchema = z
  .object({
    /** A post's numbers, or (with `platform` and no post) the account's. */
    postId: z.string().max(20).optional(),
    platform: z.enum(PLATFORMS).optional(),
    metrics: z.record(z.string().max(40), z.number().min(0)),
  })
  .refine((b) => b.postId || b.platform, { message: "Give a postId or a platform." });

const videoSchema = z.object({
  scriptId: z.string().min(1).max(20),
  test: z.boolean().default(false),
});

/** Streams a file with byte ranges, so the Desk's player can seek. */
export function sendRange(req: FastifyRequest, reply: FastifyReply, file: string, type: string) {
  const size = fs.statSync(file).size;
  reply.header("accept-ranges", "bytes").type(type);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end)
      return reply.code(416).header("content-range", `bytes */${size}`).send();
    reply
      .code(206)
      .header("content-range", `bytes ${start}-${end}/${size}`)
      .header("content-length", end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header("content-length", size);
  return reply.send(fs.createReadStream(file));
}

const ideasSchema = z.object({
  channel: z.string().min(1),
  count: z.coerce.number().int().min(1).max(12).default(8),
});
const scriptSchema = z.object({
  channel: z.string().min(1),
  format: z.enum(["short", "long"]),
  ideaId: z.string().max(20).optional(),
  /** A rewrite: the script it replaces, the note to follow and, optionally, corrected facts. */
  from: z.string().max(20).optional(),
  note: z.string().max(2000).optional(),
  facts: z
    .array(z.object({ fact: z.string().min(5).max(400), source: z.number().int().min(0) }))
    .max(60)
    .optional(),
});
const listSchema = z.object({
  channel: z.string().max(40).optional(),
  status: z.string().max(20).optional(),
});

export function registerStudioRoutes(app: FastifyInstance, api: StudioApi): void {
  const { writers } = api;
  app.get("/api/studio/channels", async () => writers.channels());

  app.post("/api/studio/niche-study", async (_req, reply) =>
    reply.code(201).send(await writers.nicheStudy()),
  );

  app.get("/api/studio/ideas", async (req) => {
    const q = listSchema.parse(req.query);
    return writers.ideas(q.channel, q.status as never);
  });
  app.post("/api/studio/ideas", async (req, reply) => {
    const body = ideasSchema.parse(req.body);
    return reply.code(201).send(await writers.proposeIdeas(body.channel, body.count));
  });

  app.get("/api/studio/scripts", async (req) => {
    const q = listSchema.parse(req.query);
    return writers.scripts(q.channel, q.status as never);
  });
  app.get<{ Params: { id: string } }>("/api/studio/scripts/:id", async (req, reply) => {
    const doc = writers.script(req.params.id);
    return doc ?? reply.code(404).send({ error: "No such script" });
  });
  app.post("/api/studio/scripts", async (req, reply) => {
    const body = scriptSchema.parse(req.body);
    const from = body.from ? writers.script(body.from) : null;
    if (body.from && !from) return reply.code(404).send({ error: `No script ${body.from}.` });
    return reply.code(202).send(
      writers.start(body.channel, {
        format: body.format,
        ...(body.ideaId ? { ideaId: body.ideaId } : {}),
        ...(from ? { from } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.facts ? { facts: body.facts } : {}),
      }),
    );
  });

  const { gpu } = api;
  if (gpu) app.get("/api/studio/gpu", async () => gpu.status());

  const { board, schedule } = api;
  if (board) app.get("/api/studio/board", async () => board.build());
  if (schedule) {
    /** Runs today's schedule now: the scripts the cadence needs (each waits at the Desk). */
    app.post("/api/studio/schedule/run", async () => schedule.run());
    app.post("/api/studio/cleanup", async () => schedule.cleanup());
  }

  const { analytics } = api;
  if (analytics) {
    app.get("/api/studio/analytics", async (req) => {
      const q = z.object({ channel: z.string().max(60).optional() }).parse(req.query ?? {});
      return {
        ...analytics.report(q.channel),
        learning: q.channel
          ? {
              weights: analytics.weights(q.channel),
              cadence: analytics.cadence(q.channel),
              lessons: analytics.lessons(q.channel),
            }
          : null,
      };
    });
    app.post("/api/studio/analytics/collect", async () => analytics.collect());
    app.post("/api/studio/analytics/retro", async (req, reply) => {
      const body = z.object({ channel: z.string().min(1).max(60) }).parse(req.body ?? {});
      try {
        return (await analytics.retro(body.channel)).plan;
      } catch (err) {
        if (err instanceof NotEnoughStatsError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    });
    /** Numbers typed in by hand: TikTok's, until its API gives them. */
    app.post("/api/studio/stats", async (req, reply) => {
      const body = statsSchema.parse(req.body ?? {});
      try {
        if (body.postId) analytics.record(body.postId, body.metrics);
        else if (body.platform) analytics.recordAccount(body.platform, body.metrics);
        return { ok: true };
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  const { editbay } = api;
  if (!editbay) return;
  app.get("/api/studio/videos", async (req) => {
    const q = listSchema.parse(req.query);
    return editbay.videos(q.channel, q.status as never);
  });
  app.get<{ Params: { id: string } }>("/api/studio/videos/:id", async (req, reply) => {
    return editbay.video(req.params.id) ?? reply.code(404).send({ error: "No such video" });
  });
  app.post("/api/studio/videos", async (req, reply) => {
    const body = videoSchema.parse(req.body);
    return reply.code(202).send(editbay.produce(body.scriptId, { test: body.test }));
  });
  app.get<{ Params: { id: string } }>("/api/studio/videos/:id/file", async (req, reply) => {
    const v = editbay.video(req.params.id);
    if (!v?.file || !fs.existsSync(v.file))
      return reply.code(404).send({ error: "No such video file" });
    return sendRange(req, reply, v.file, "video/mp4");
  });
  app.get<{ Params: { id: string } }>("/api/studio/videos/:id/thumbnail", async (req, reply) => {
    const v = editbay.video(req.params.id);
    if (!v?.thumbnail || !fs.existsSync(v.thumbnail))
      return reply.code(404).send({ error: "No thumbnail" });
    return reply.type("image/png").send(fs.createReadStream(v.thumbnail));
  });
}
