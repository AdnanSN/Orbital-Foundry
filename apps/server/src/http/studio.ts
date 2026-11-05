import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WritersRoom } from "../studio/writers";

/** The studio's routes (Stage 15 on): channels, the niche study, ideas and scripts. */
export interface StudioApi {
  writers: WritersRoom;
}

const ideasSchema = z.object({
  channel: z.string().min(1),
  count: z.coerce.number().int().min(1).max(12).default(8),
});
const scriptSchema = z.object({
  channel: z.string().min(1),
  format: z.enum(["short", "long"]),
  ideaId: z.string().max(20).optional(),
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
    return reply
      .code(202)
      .send(
        writers.start(body.channel, {
          format: body.format,
          ...(body.ideaId ? { ideaId: body.ideaId } : {}),
        }),
      );
  });
}
