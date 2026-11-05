import {
  type ArtifactMeta,
  type ArtifactReview,
  type CrewLook,
  type CrewRole,
  crewFromTemplate,
  crewIdFor,
  randomLook,
  type SimStatus,
  type StationEvent,
  type StationSim,
  stationEventSchema,
} from "@orbital/shared";
import type { SimClock } from "./clock";
import type { World } from "./world";

/** A hire from the Recruitment Bay. */
export interface HireRequest {
  name: string;
  role: CrewRole;
  room: string;
  look?: CrewLook;
}

/** Things the owner can do to the station: REST calls to the server, or local in mock mode. */
export interface StationCommands {
  setSim(change: Partial<SimStatus>): Promise<void>;
  hire(req: HireRequest): Promise<void>;
  reassign(id: string, room: string): Promise<void>;
  /** Real work (station server only). */
  createObjective(text: string): Promise<void>;
  decide(id: string, decision: "approve" | "reject", note?: string): Promise<void>;
  standup(): Promise<void>;
  artifact(id: string): Promise<{ title: string; content: string | null; mime: string }>;
  /** The creative studio (Stage 5, station server only). */
  listArtifacts(filter: { kind?: string; room?: string; limit?: number }): Promise<ArtifactMeta[]>;
  reviewArtifact(id: string, review: ArtifactReview, note?: string): Promise<void>;
  runPipeline(input: PipelineRequest): Promise<{ final: ArtifactMeta; steps: ArtifactMeta[] }>;
  creativeStyles(): Promise<{ styles: StyleInfo[]; aspects: string[] }>;
  qaArtifact(id: string): Promise<void>;
  /** The URL of an image artifact's file ("" without a server). */
  fileUrl(id: string): string;
  /** Factory 1, the Etsy POD studio (Stage 6, station server only). */
  stores(): Promise<StoreInfo[]>;
  startListing(id: string, note?: string): Promise<void>;
  updateStore(id: string, patch: { listingsPerDay?: number; paused?: boolean }): Promise<void>;
  packageZipUrl(id: string): string;
  /** Publishing (Stage 7): dry run or live, the daily cap, and the station kill switch. */
  publishing(): Promise<{ mode: string; dailyCap: number; killed: boolean } | null>;
  setKill(on: boolean): Promise<void>;
  /** Factory 2, the Thumbnail Studio (Stage 8). */
  thumbJobs(): Promise<ThumbJobInfo[]>;
  startThumbs(brief: {
    title: string;
    topic?: string;
    channelStyle?: string;
    brandColors?: string[];
    facePhoto?: string;
  }): Promise<void>;
  reviseThumbs(id: string, note: string): Promise<void>;
  gigKit(): Promise<ArtifactMeta>;
  /** Download URL for a deliverable's ZIP (packages, thumbnails, asset packs). */
  zipUrl(id: string): string;
  /** Factory 3, the Asset Forge (Stage 9). */
  packs(): Promise<PackInfo[]>;
  forgePack(req: { theme: string; size: number; count: number }): Promise<void>;
  /** The Vault (Stage 10). */
  vault(): Promise<VaultInfo>;
  simulateWeek(): Promise<{ sales: number; revenue: number }>;
  weeklyRetro(simulated: boolean): Promise<void>;
  addEntry(e: { business: string; kind: string; amount: number; note?: string }): Promise<void>;
  /** Always-on operations (Stage 11). */
  ops(): Promise<OpsInfo | null>;
  backupNow(): Promise<void>;
}

export interface OpsInfo {
  quiet: boolean;
  lastBackup: { at: string; database: string; files: number } | null;
  telegram: boolean;
  authRequired: boolean;
  achievements: { id: string; title: string; at: string | null }[];
}

export interface VaultInfo {
  real: { id: string; name: string; orders: number; sales: number; net: number }[];
  simulated: { id: string; name: string; orders: number; sales: number; net: number }[];
  month: { net: number; goal: number; progress: number };
  joke: { goal: number; logProgress: number };
  rooms: {
    room: string;
    done: number;
    failed: number;
    reworkRate: number;
    qaPassRate: number | null;
    approvalRate: number | null;
  }[];
  crew: { id: string; done: number; failed: number; reworks: number }[];
  usage: { provider: string; tier: string; calls: number; failures: number; shadowCost: number }[];
  shadowCost: number;
  experiments: { store: string; kind: string; change: string }[];
}

export interface PackInfo {
  id: string;
  request: { theme: string; size: number; count: number };
  plan: { title: string } | null;
  icons: { id: string; name: string }[];
  preview: string | null;
  score: number | null;
  outliers: number[];
  deliveryId: string | null;
  status: "working" | "delivered" | "failed";
  running: boolean;
  error: string | null;
  uploaded: { mode: string; command: string } | null;
}

export interface ThumbJobInfo {
  id: string;
  taskId: string;
  brief: { title: string; hasPhoto: boolean };
  status: "working" | "delivered" | "failed";
  running: boolean;
  error: string | null;
  seconds: number | null;
  versions: {
    version: number;
    concepts: { angle: string; hook: string }[];
    images: string[];
    mobile: string[];
    qa: { score: number | null; pass: boolean }[];
    deliveryId: string;
  }[];
}

export interface StoreInfo {
  id: string;
  name: string;
  crew: string;
  niche: string;
  products: string[];
  settings: { listingsPerDay: number; paused: boolean };
  today: number;
  running: boolean;
  packages: ArtifactMeta[];
}

export interface PipelineRequest {
  prompt: string;
  style?: string;
  aspect?: string;
  upscale: 0 | 2 | 4;
  cutout: "auto" | "none" | "edges" | "chroma" | "rembg";
  qa: boolean;
  room?: string;
}

export interface StyleInfo {
  id: string;
  description: string;
  aspect: string;
  cutout: string;
}

/**
 * The station's access token, when the server requires one (ORBITAL_TOKEN): taken from the page
 * address (?token=…) once and remembered in this browser, then removed from the address bar.
 */
export function accessToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      window.localStorage.setItem("orbital.token", fromUrl);
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.toString());
      return fromUrl;
    }
    return window.localStorage.getItem("orbital.token");
  } catch {
    return null;
  }
}

/** Adds the token to URLs the browser loads itself (WebSocket, images, downloads). */
export function withToken(url: string): string {
  const token = accessToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = accessToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : extra;
}

const SERVER_ONLY = async (): Promise<never> => {
  throw new Error("Real work needs the station server (npm run dev).");
};

export type LinkStatus = "mock" | "connecting" | "online" | "offline";

/**
 * Where station events come from: the station server over WebSocket (a snapshot on connect, then
 * increments), or a local sim in mock mode. Either way the world model only sees events.
 */
export interface StationLink {
  readonly kind: "mock" | "server";
  readonly commands: StationCommands;
  status(): LinkStatus;
  onStatus(listener: (s: LinkStatus) => void): () => void;
  /** Start delivering events. */
  start(): void;
  /** Called once per frame with the current sim time. */
  update(now: number): void;
  stop(): void;
}

/** Runs the sim engine in the browser: no server needed (`?mock=1`, or when offline). */
export class MockLink implements StationLink {
  readonly kind = "mock";
  readonly commands: StationCommands;

  constructor(
    private readonly sim: StationSim,
    private readonly world: World,
    private readonly clock: SimClock,
  ) {
    this.commands = {
      setSim: async (change) => {
        const next = { ...this.sim.simStatus, ...change };
        if (next.paused) this.clock.pause();
        else this.clock.resume();
        this.clock.setSpeed(next.speed);
        this.sim.setSimStatus(next);
        this.flush();
      },
      hire: async (req) => {
        const id = crewIdFor(
          req.name,
          this.sim.crew.map((c) => c.id),
        );
        this.sim.hire(
          crewFromTemplate(id, req.name, req.role, req.room, req.look ?? randomLook(req.role)),
        );
        this.flush();
      },
      reassign: async (id, room) => {
        this.sim.reassign(id, room);
        this.flush();
      },
      createObjective: SERVER_ONLY,
      decide: SERVER_ONLY,
      standup: SERVER_ONLY,
      artifact: SERVER_ONLY,
      listArtifacts: async () => [],
      reviewArtifact: SERVER_ONLY,
      runPipeline: SERVER_ONLY,
      creativeStyles: async () => ({ styles: [], aspects: [] }),
      qaArtifact: SERVER_ONLY,
      fileUrl: () => "",
      stores: async () => [],
      startListing: SERVER_ONLY,
      updateStore: SERVER_ONLY,
      packageZipUrl: () => "",
      publishing: async () => null,
      setKill: SERVER_ONLY,
      thumbJobs: async () => [],
      startThumbs: SERVER_ONLY,
      reviseThumbs: SERVER_ONLY,
      gigKit: SERVER_ONLY,
      zipUrl: () => "",
      packs: async () => [],
      forgePack: SERVER_ONLY,
      vault: SERVER_ONLY,
      simulateWeek: SERVER_ONLY,
      weeklyRetro: SERVER_ONLY,
      addEntry: SERVER_ONLY,
      ops: async () => null,
      backupNow: SERVER_ONLY,
    };
  }

  status(): LinkStatus {
    return "mock";
  }

  onStatus(): () => void {
    return () => {};
  }

  start(): void {
    this.world.apply(this.sim.snapshot());
    this.world.commit();
  }

  update(now: number): void {
    for (const e of this.sim.advanceTo(now)) this.world.apply(e);
    this.world.commit();
  }

  stop(): void {}

  private flush(): void {
    for (const e of this.sim.drain()) this.world.apply(e);
    this.world.commit();
  }
}

/**
 * The station server over WebSocket. Reconnects with back-off and resyncs from the fresh snapshot
 * the server sends on every connect. The sim clock follows the server's time.
 */
export class SocketLink implements StationLink {
  readonly kind = "server";
  readonly commands: StationCommands;
  private ws: WebSocket | null = null;
  private current: LinkStatus = "connecting";
  private readonly listeners = new Set<(s: LinkStatus) => void>();
  private retry = 0;
  private timer: number | null = null;
  private stopped = false;

  constructor(
    private readonly world: World,
    private readonly clock: SimClock,
    private readonly base = "",
  ) {
    const post = async (path: string, body: unknown, method = "POST") => {
      const res = await fetch(`${this.base}/api${path}`, {
        method,
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `${method} ${path} failed (${res.status})`);
      }
    };
    /** GET (no body) or POST (with one), returning the JSON reply; errors carry the server's message. */
    const json = async (path: string, body?: unknown): Promise<unknown> => {
      const res = await fetch(`${this.base}/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? { headers: authHeaders() }
          : {
              headers: authHeaders({ "content-type": "application/json" }),
              body: JSON.stringify(body),
            }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `${path} failed (${res.status})`);
      return data;
    };
    this.commands = {
      setSim: (change) => post("/sim", change),
      hire: (req) => post("/agents", req),
      reassign: (id, room) => post(`/agents/${encodeURIComponent(id)}`, { room }, "PATCH"),
      createObjective: (text) => post("/objectives", { text }),
      decide: (id, decision, note) =>
        post(`/approvals/${encodeURIComponent(id)}/decide`, {
          decision,
          ...(note ? { note } : {}),
        }),
      standup: () => post("/overseer/standup", {}),
      artifact: async (id) => {
        const res = await fetch(`${this.base}/api/artifacts/${encodeURIComponent(id)}`, {
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`Could not load ${id} (${res.status})`);
        return (await res.json()) as { title: string; content: string | null; mime: string };
      },
      listArtifacts: async (filter) => {
        const q = new URLSearchParams();
        if (filter.kind) q.set("kind", filter.kind);
        if (filter.room) q.set("room", filter.room);
        if (filter.limit) q.set("limit", String(filter.limit));
        return (await json(`/artifacts?${q}`)) as ArtifactMeta[];
      },
      reviewArtifact: (id, review, note) =>
        post(
          `/artifacts/${encodeURIComponent(id)}`,
          { review, ...(note ? { note } : {}) },
          "PATCH",
        ),
      runPipeline: async (input) =>
        (await json("/creative/pipeline", input)) as { final: ArtifactMeta; steps: ArtifactMeta[] },
      creativeStyles: async () =>
        (await json("/creative/styles")) as { styles: StyleInfo[]; aspects: string[] },
      qaArtifact: (id) => post(`/creative/qa/${encodeURIComponent(id)}`, {}),
      fileUrl: (id) => withToken(`${this.base}/api/artifacts/${encodeURIComponent(id)}/file`),
      stores: async () => (await json("/pod/stores")) as StoreInfo[],
      startListing: (id, note) =>
        post(`/pod/stores/${encodeURIComponent(id)}/listings`, note ? { note } : {}),
      updateStore: (id, patch) => post(`/pod/stores/${encodeURIComponent(id)}`, patch, "PATCH"),
      packageZipUrl: (id) =>
        withToken(`${this.base}/api/pod/packages/${encodeURIComponent(id)}/zip`),
      publishing: async () =>
        (await json("/pod/publishing")) as { mode: string; dailyCap: number; killed: boolean },
      setKill: (on) => post("/kill", { on }),
      thumbJobs: async () => (await json("/thumbs")) as ThumbJobInfo[],
      startThumbs: (brief) => post("/thumbs", brief),
      reviseThumbs: (id, note) => post(`/thumbs/${encodeURIComponent(id)}/revise`, { note }),
      gigKit: async () => (await json("/thumbs/gig-kit", {})) as ArtifactMeta,
      zipUrl: (id) => withToken(`${this.base}/api/artifacts/${encodeURIComponent(id)}/zip`),
      packs: async () => (await json("/forge")) as PackInfo[],
      forgePack: (req) => post("/forge", req),
      vault: async () => (await json("/vault")) as VaultInfo,
      simulateWeek: async () =>
        (await json("/vault/simulate", {})) as { sales: number; revenue: number },
      weeklyRetro: async (simulated) => {
        await json("/vault/retro", { simulated });
      },
      addEntry: (e) => post("/vault/entries", e),
      ops: async () => (await json("/ops")) as OpsInfo,
      backupNow: async () => {
        await json("/ops/backup", {});
      },
    };
  }

  status(): LinkStatus {
    return this.current;
  }

  onStatus(listener: (s: LinkStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.connect();
  }

  update(): void {
    // Events arrive on their own; the clock is corrected as they come in.
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.ws?.close();
  }

  private setStatus(s: LinkStatus): void {
    if (s === this.current) return;
    this.current = s;
    for (const l of this.listeners) l(s);
  }

  private connect(): void {
    if (this.stopped) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = this.base
      ? `${this.base.replace(/^http/, "ws")}/ws`
      : `${proto}://${window.location.host}/ws`;
    this.setStatus(this.retry === 0 ? "connecting" : "offline");
    const ws = new WebSocket(withToken(url));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("online");
    };
    ws.onmessage = (m) => this.receive(m.data);
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.setStatus("offline");
      this.retry += 1;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.retry, 5));
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const events = Array.isArray(raw) ? raw : [raw];
    for (const item of events) {
      const parsed = stationEventSchema.safeParse(item);
      if (!parsed.success) continue;
      this.follow(parsed.data);
      this.world.apply(parsed.data);
    }
    this.world.commit();
  }

  /** Keep the local clock on the server's sim time. */
  private follow(e: StationEvent): void {
    if (e.type === "snapshot" || e.type === "sim.status") {
      const status = e.type === "snapshot" ? e.sim : e.status;
      if (status.paused) this.clock.pause();
      else this.clock.resume();
      this.clock.setSpeed(status.speed);
    }
    const drift = e.t - this.clock.now();
    if (e.type === "snapshot" || drift > 300 || drift < -3_000) this.clock.set(e.t);
  }
}
