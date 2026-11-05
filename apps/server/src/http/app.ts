import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import websocket from "@fastify/websocket";
import {
  ARTIFACT_REVIEWS,
  CREW_ROLES,
  crewLookSchema,
  type Lane,
  ROLE_TEMPLATES,
  simStatusSchema,
} from "@orbital/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { CUTOUTS } from "../creative/config";
import type { CreativeStudio } from "../creative/studio";
import { type AssetForge, packRequestSchema } from "../forge/forge";
import type { Achievements } from "../ops/achievements";
import type { OpsService } from "../ops/ops";
import type { PodFactory } from "../pod/factory";
import type { PodPublisher } from "../printify/publisher";
import type { SimServer } from "../sim/simServer";
import { type ThumbnailStudio, thumbBriefSchema } from "../thumbs/studio";
import type { TikTokConnector } from "../uplink/tiktok";
import { type Economy, SimulationOffError } from "../vault/economy";
import type { KpiService } from "../vault/kpis";
import { LEDGER_KINDS, type Ledger } from "../vault/ledger";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";
import { registerUplinkRoutes, TIKTOK_CALLBACK_PATH } from "./uplink";

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
  /** The lane every model call uses: "live" in production (D-046). */
  lane?: Lane;
  /** The creative toolchain (Stage 5). */
  studio?: CreativeStudio;
  /** Factory 1, the Etsy POD studio (Stage 6). */
  pod?: PodFactory;
  /** Publishing through Printify (Stage 7). */
  publisher?: PodPublisher;
  /** The Vault's ledger (Stage 7 records, Stage 10 reports). */
  ledger?: Ledger;
  /** Factory 2, the Thumbnail Studio (Stage 8). */
  thumbs?: ThumbnailStudio;
  /** Factory 3, the Asset Forge (Stage 9). */
  forge?: AssetForge;
  /** The Vault's numbers and the learning loop (Stage 10). */
  kpis?: KpiService;
  economy?: Economy;
  /** Always-on operations (Stage 11). */
  ops?: OpsService;
  achievements?: Achievements;
  telegram?: boolean;
  /** The Uplink's TikTok connection (Stage 17, built early for TikTok's app review). */
  tiktok?: TikTokConnector;
  /** Where deliverable ZIPs live (served by GET /api/artifacts/:id/zip). */
  artifactsDir?: string;
}

const reviseSchema = z.object({ note: z.string().trim().min(3).max(1_000) });
const entrySchema = z.object({
  business: z.string().min(1).max(40),
  kind: z.enum(LEDGER_KINDS),
  amount: z.coerce.number().min(-100_000).max(100_000),
  note: z.string().trim().max(300).optional(),
});

const killSchema = z.object({ on: z.boolean() });
const ledgerQuerySchema = z.object({
  business: z.string().max(40).optional(),
  simulated: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(2_000).default(200),
});

const storeSettingsSchema = z.object({
  listingsPerDay: z.coerce.number().int().min(0).max(20).optional(),
  paused: z.boolean().optional(),
});
const listingRequestSchema = z.object({ note: z.string().trim().max(1_000).optional() });

/**
 * The station's HTTP and WebSocket API (ROADMAP §8). Clients get a snapshot on connect and then
 * every event as it happens; commands are REST calls. Binds to localhost by default; remote
 * access (with authentication) is Stage 11.
 */
export interface AppOptions {
  /**
   * When set, every /api and /ws request needs it (Authorization: Bearer, or ?token= for
   * WebSocket, image and download URLs). Set it before exposing the station beyond localhost.
   */
  token?: string;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(
  sim: SimServer,
  work?: WorkApi,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const token = options.token;
  if (token) {
    app.addHook("onRequest", async (req, reply) => {
      const url = new URL(req.url, "http://station.local");
      // TikTok's sign-in comes back through the website, without the token; `state` guards it.
      if (url.pathname === "/api/health" || url.pathname === TIKTOK_CALLBACK_PATH) return;
      if (!url.pathname.startsWith("/api") && !url.pathname.startsWith("/ws")) return;
      const header = req.headers.authorization;
      const given = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
      if (!given || !sameSecret(given, token)) {
        return reply.code(401).send({ error: "This station needs its access token." });
      }
    });
  }

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
      lane: work?.lane ?? "sandbox",
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
    const pod = work.pod;
    if (pod) {
      app.get("/api/pod/stores", async () =>
        pod.businesses.map((b) => ({
          ...b,
          settings: pod.settings(b.id),
          today: pod.countToday(b.id),
          running: pod.isRunning(b.id),
          packages: pod.packages(b.id, 8),
        })),
      );
      app.post<{ Params: { id: string } }>("/api/pod/stores/:id/listings", async (req, reply) => {
        const body = listingRequestSchema.parse(req.body ?? {});
        return reply.code(202).send(pod.start(req.params.id, body.note ? { note: body.note } : {}));
      });
      app.patch<{ Params: { id: string } }>("/api/pod/stores/:id", async (req) => {
        const body = storeSettingsSchema.parse(req.body ?? {});
        return pod.updateSettings(req.params.id, {
          ...(body.listingsPerDay !== undefined ? { listingsPerDay: body.listingsPerDay } : {}),
          ...(body.paused !== undefined ? { paused: body.paused } : {}),
        });
      });
      app.get<{ Params: { id: string } }>("/api/pod/packages/:id/zip", async (req, reply) => {
        const file = pod.zipPath(req.params.id);
        if (!file) return reply.code(404).send({ error: "No such package" });
        reply.header("content-type", "application/zip");
        reply.header("content-disposition", `attachment; filename="${req.params.id}.zip"`);
        return reply.send(fs.createReadStream(file));
      });
    }
    const publisher = work.publisher;
    if (publisher) {
      app.get("/api/pod/publishing", async () => ({
        mode: publisher.mode,
        dailyCap: publisher.dailyCap,
        killed: publisher.killed(),
      }));
      app.post("/api/kill", async (req) => {
        const body = killSchema.parse(req.body ?? {});
        publisher.setKill(body.on);
        return { killed: publisher.killed() };
      });
      app.post("/api/pod/sync", async () => publisher.syncOrders());
    }
    const ledger = work.ledger;
    if (ledger) {
      app.get("/api/vault/ledger", async (req) => {
        const q = ledgerQuerySchema.parse(req.query ?? {});
        const filter = {
          ...(q.business ? { business: q.business } : {}),
          ...(q.simulated !== undefined ? { simulated: q.simulated } : {}),
        };
        return {
          entries: ledger.entries({ ...filter, limit: q.limit }),
          totals: ledger.totals(filter),
        };
      });
    }
    const thumbs = work.thumbs;
    if (thumbs) {
      app.get("/api/thumbs", async () =>
        thumbs.list().map((j) => ({ ...j, running: thumbs.isRunning(j.id) })),
      );
      // A client photo can be several megabytes of base64.
      app.post("/api/thumbs", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
        return reply.code(202).send(thumbs.start(thumbBriefSchema.parse(req.body ?? {})));
      });
      app.post<{ Params: { id: string } }>("/api/thumbs/:id/revise", async (req, reply) => {
        const body = reviseSchema.parse(req.body ?? {});
        void thumbs.revise(req.params.id, body.note).catch(() => {});
        return reply.code(202).send({ ok: true });
      });
      app.post("/api/thumbs/gig-kit", async (_req, reply) =>
        reply.code(201).send(await thumbs.gigKit()),
      );
    }
    const forge = work.forge;
    if (forge) {
      app.get("/api/forge", async () => forge.list());
      app.post("/api/forge", async (req, reply) =>
        reply.code(202).send(forge.start(packRequestSchema.parse(req.body ?? {}))),
      );
    }
    const { kpis, economy } = work;
    if (kpis && economy && work.ledger) {
      const ledger = work.ledger;
      app.get("/api/vault", async () => ({
        ...kpis.snapshot({ simNow: sim.sim.now }),
        simulation: economy.simulation,
        experiments: economy.experiments(),
        lastRetro: JSON.parse(work.store.getKv("economy.lastRetro") ?? "null") as unknown,
      }));
      app.post("/api/vault/entries", async (req, reply) => {
        const body = entrySchema.parse(req.body ?? {});
        const signed = body.kind === "sale" ? Math.abs(body.amount) : -Math.abs(body.amount);
        const added = ledger.add({
          business: body.business,
          source: "manual",
          kind: body.kind,
          amount: body.kind === "adjustment" ? body.amount : signed,
          ref: `manual:${Date.now()}`,
          note: body.note ?? "Entered by hand",
        });
        return reply.code(added ? 201 : 409).send({ added });
      });
      app.post("/api/vault/simulate", async (req, reply) => {
        const seed = z
          .object({ seed: z.coerce.number().int().optional() })
          .parse(req.body ?? {}).seed;
        if (!economy.simulation)
          return reply.code(409).send({ error: new SimulationOffError().message });
        return economy.simulateWeek(seed ?? Date.now() % 100_000);
      });
      app.post("/api/vault/retro", async (req, reply) => {
        const body = z.object({ simulated: z.boolean().optional() }).parse(req.body ?? {});
        if (body.simulated && !economy.simulation) {
          return reply.code(409).send({ error: new SimulationOffError().message });
        }
        const { plan, artifact } = await economy.retro(body.simulated ? { simulated: true } : {});
        return reply.code(201).send({ plan, artifact });
      });
    }
    const { ops, achievements } = work;
    if (ops) {
      app.get("/api/ops", async () => ({
        quiet: ops.quiet(),
        lastBackup: ops.lastBackup(),
        backupDir: ops.backupDir,
        telegram: work.telegram ?? false,
        authRequired: Boolean(token),
        achievements: achievements?.list() ?? [],
      }));
      app.post("/api/ops/backup", async (_req, reply) => reply.code(201).send(await ops.backup()));
    }
    const zipRoot = work.artifactsDir ? path.resolve(work.artifactsDir) : null;
    app.get<{ Params: { id: string } }>("/api/artifacts/:id/zip", async (req, reply) => {
      const a = work.store.artifact(req.params.id);
      const file = a?.path ? path.resolve(a.path) : null;
      if (
        !file ||
        !zipRoot ||
        !file.endsWith(".zip") ||
        !file.startsWith(zipRoot + path.sep) ||
        !fs.existsSync(file)
      ) {
        return reply.code(404).send({ error: "No ZIP for this deliverable" });
      }
      reply.header("content-type", "application/zip");
      reply.header("content-disposition", `attachment; filename="${path.basename(file)}"`);
      return reply.send(fs.createReadStream(file));
    });
    app.post("/api/overseer/standup", async (_req, reply) => {
      const meta = await work.director.standup();
      return meta
        ? reply.code(201).send(meta)
        : reply.code(409).send({ error: "No Overseer aboard" });
    });
    if (work.tiktok) registerUplinkRoutes(app, work.tiktok);
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
