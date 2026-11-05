import websocket from "@fastify/websocket";
import { CREW_ROLES, crewLookSchema, ROLE_TEMPLATES, simStatusSchema } from "@orbital/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { SimServer } from "../sim/simServer";

const hireSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,7}$/, "Names are 1-8 letters, digits or dashes"),
  role: z.enum(CREW_ROLES),
  room: z.string().min(1),
  look: crewLookSchema.optional(),
});

const reassignSchema = z.object({ room: z.string().min(1) });

/**
 * The station's HTTP and WebSocket API (ROADMAP §8). Clients get a snapshot on connect and then
 * every event as it happens; commands are REST calls. Binds to localhost by default; remote
 * access (with authentication) is Stage 11.
 */
export async function buildApp(sim: SimServer): Promise<FastifyInstance> {
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
