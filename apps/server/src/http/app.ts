import fs from "node:fs";
import websocket from "@fastify/websocket";
import {
  ARTIFACT_REVIEWS,
  CREW_ROLES,
  crewLookSchema,
  ROLE_TEMPLATES,
  simStatusSchema,
} from "@orbital/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { CUTOUTS } from "../creative/config";
import type { CreativeStudio } from "../creative/studio";
import type { SimServer } from "../sim/simServer";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";

const hireSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,7}$/, "Names are 1-8 letters, digits or dashes"),
  role: z.enum(CREW_ROLES),
  room: z.string().min(1),
  look: crewLookSchema.optional(),
});

const reassignSchema = z.object({ room: z.string().min(1) });
const objectiveSchema = z.object({ text: z.string().trim().min(5).max(1_000) });
const decideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2_000).optional(),
});

const listSchema = z.object({
  kind: z.string().max(40).optional(),
  room: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(60),
});
const reviewSchema = z.object({
  review: z.enum(ARTIFACT_REVIEWS),
  note: z.string().max(1_000).optional(),
});
const pipelineSchema = z.object({
  prompt: z.string().trim().min(3).max(800),
  style: z.string().max(40).optional(),
  aspect: z.string().max(10).optional(),
  seed: z.coerce.number().int().optional(),
  upscale: z.union([z.literal(0), z.literal(2), z.literal(4)]).default(4),
  cutout: z.enum(["auto", ...CUTOUTS]).default("auto"),
  qa: z.boolean().default(true),
  room: z.string().max(40).optional(),
  purpose: z.string().max(200).optional(),
});

/** Real work (Stage 4). Without it the server runs the mock crew only. */
export interface WorkApi {
  director: WorkDirector;
  store: WorkStore;
  /** The creative toolchain (Stage 5). */
  studio?: CreativeStudio;
}

/**
 * The station's HTTP and WebSocket API (ROADMAP §8). Clients get a snapshot on connect and then
 * every event as it happens; commands are REST calls. Binds to localhost by default; remote
 * access (with authentication) is Stage 11.
 */
export async function buildApp(sim: SimServer, work?: WorkApi): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 400;
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(status >= 400 && status < 600 ? status : 400).send({ error: message });
  });

  app.get("/api/health", async () => {
    const snap = sim.snapshot();
    return {
      ok: true,
      t: snap.t,
      seq: snap.seq,
      crew: snap.type === "snapshot" ? snap.crew.length : 0,
      restored: sim.restored,
    };
  });

  app.get("/api/state", async () => sim.snapshot());

  app.get("/api/roles", async () => ROLE_TEMPLATES);

  app.post("/api/sim", async (req) => {
    const change = simStatusSchema.partial().parse(req.body ?? {});
    return sim.setSim(change);
  });

  app.post("/api/agents", async (req, reply) => {
    const body = hireSchema.parse(req.body ?? {});
    const crew = sim.hire(body);
    return reply.code(201).send(crew);
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    const body = reassignSchema.parse(req.body ?? {});
    return sim.reassign(req.params.id, body.room);
  });

  if (work) {
    app.post("/api/objectives", async (req, reply) => {
      const body = objectiveSchema.parse(req.body ?? {});
      return reply.code(201).send(work.director.createObjective(body.text));
    });
    app.get("/api/objectives", async () => work.store.objectives(50));
    app.get("/api/approvals", async () => work.store.approvals(undefined, 100));
    app.post<{ Params: { id: string } }>("/api/approvals/:id/decide", async (req) => {
      const body = decideSchema.parse(req.body ?? {});
      return work.director.decide(req.params.id, body.decision, body.note);
    });
    app.get("/api/artifacts", async (req) => {
      const q = listSchema.parse(req.query ?? {});
      return work.store.findArtifacts({
        limit: q.limit,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.room ? { room: q.room } : {}),
      });
    });
    app.get<{ Params: { id: string } }>("/api/artifacts/:id/file", async (req, reply) => {
      const file = work.studio?.file(req.params.id);
      if (!file) return reply.code(404).send({ error: "No such file" });
      // Files never change once written (every edit makes a new artifact).
      reply.header("content-type", file.mime);
      reply.header("cache-control", "private, max-age=31536000, immutable");
      return reply.send(fs.createReadStream(file.path));
    });
    app.patch<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => {
      const body = reviewSchema.parse(req.body ?? {});
      if (!work.studio) return reply.code(503).send({ error: "The creative studio is offline" });
      return work.studio.review(req.params.id, body.review, body.note);
    });
    app.get("/api/creative/styles", async () => ({
      styles: work.studio?.styles() ?? [],
      aspects: work.studio?.aspects() ?? [],
    }));
    app.post("/api/creative/pipeline", async (req, reply) => {
      if (!work.studio) return reply.code(503).send({ error: "The creative studio is offline" });
      const { room, ...input } = pipelineSchema.parse(req.body ?? {});
      const result = await work.studio.pipeline(input, {
        createdBy: "owner",
        room: room ?? null,
      });
      return reply.code(201).send(result);
    });
    app.post<{ Params: { id: string } }>("/api/creative/qa/:id", async (req, reply) => {
      if (!work.studio) return reply.code(503).send({ error: "The creative studio is offline" });
      return work.studio.qa(req.params.id);
    });
    app.get<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => {
      const artifact = work.store.artifact(req.params.id);
      if (!artifact) return reply.code(404).send({ error: "No such deliverable" });
      return { ...artifact.meta, content: artifact.content };
    });
    app.post("/api/overseer/standup", async (_req, reply) => {
      const meta = await work.director.standup();
      return meta
        ? reply.code(201).send(meta)
        : reply.code(409).send({ error: "No Overseer aboard" });
    });
  }

  app.get("/ws", { websocket: true }, (socket) => {
    socket.send(JSON.stringify(sim.snapshot()));
    const unsubscribe = sim.subscribe((events) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(events));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  return app;
}
