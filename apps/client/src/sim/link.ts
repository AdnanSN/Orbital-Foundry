import {
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
}

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
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `${method} ${path} failed (${res.status})`);
      }
    };
    this.commands = {
      setSim: (change) => post("/sim", change),
      hire: (req) => post("/agents", req),
      reassign: (id, room) => post(`/agents/${encodeURIComponent(id)}`, { room }, "PATCH"),
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
    const ws = new WebSocket(url);
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
