import {
  type CrewLook,
  type CrewMember,
  type CrewRole,
  crewFromTemplate,
  crewIdFor,
  randomLook,
  roleTemplate,
  type SimStatus,
  STARTING_CREW,
  type StationEvent,
  type StationMap,
  StationSim,
} from "@orbital/shared";
import type { SimStore } from "./store";

export interface HireRequest {
  name: string;
  role: CrewRole;
  room: string;
  look?: CrewLook;
}

export interface SimServerOptions {
  map: StationMap;
  store: SimStore;
  seed?: number;
  /** Invent rate limits and outages (Stage 3). Real provider status takes over in Stage 4. */
  mockProviders?: boolean;
  /** How often the sim advances, in real ms. */
  tickMs?: number;
  /** How often the engine state is saved, in real ms. */
  saveEveryMs?: number;
}

type Listener = (events: StationEvent[]) => void;

/**
 * The server-side station: owns the sim engine and its clock, persists events and saves, and
 * broadcasts every batch of events to subscribers (WebSocket clients).
 */
export class SimServer {
  readonly sim: StationSim;
  readonly restored: boolean;
  private readonly listeners = new Set<Listener>();
  private readonly store: SimStore;
  private pending: StationEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private lastSave = 0;
  private readonly tickMs: number;
  private readonly saveEveryMs: number;

  constructor(options: SimServerOptions) {
    this.store = options.store;
    this.tickMs = options.tickMs ?? 100;
    this.saveEveryMs = options.saveEveryMs ?? 2_000;
    const save = options.store.loadSave();
    const simOptions = {
      seed: options.seed ?? Date.now() % 1_000_000,
      mockProviders: options.mockProviders ?? true,
    };
    if (save) {
      this.sim = StationSim.restore(options.map, save, {
        ...simOptions,
        minSeq: options.store.lastSeq(),
      });
      this.restored = true;
    } else {
      this.sim = new StationSim(options.map, STARTING_CREW, simOptions);
      options.store.seedCrew(STARTING_CREW);
      this.restored = false;
    }
  }

  /** Start the real-time clock. */
  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.lastSave = this.lastTick;
    this.timer = setInterval(() => {
      const now = Date.now();
      // A stalled process (laptop asleep) resumes where it was instead of fast-forwarding.
      this.tick(Math.min(now - this.lastTick, 1_000));
      this.lastTick = now;
      if (now - this.lastSave >= this.saveEveryMs) this.save();
    }, this.tickMs);
  }

  /** Stop the clock and save. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.save();
  }

  /** Advance by a real-time step. Returns the events it produced (also broadcast). */
  tick(realMs: number): StationEvent[] {
    const status = this.sim.simStatus;
    const target = status.paused ? this.sim.now : this.sim.now + Math.max(0, realMs) * status.speed;
    return this.publish(this.sim.advanceTo(target));
  }

  save(): void {
    this.store.write(this.pending, this.sim.save());
    this.pending = [];
    this.lastSave = Date.now();
  }

  /** Extra records (objectives, approvals, deliverables) included in every snapshot. */
  extras:
    | (() => Pick<
        Extract<StationEvent, { type: "snapshot" }>,
        "objectives" | "approvals" | "artifacts"
      >)
    | null = null;

  snapshot(): StationEvent {
    const snap = this.sim.snapshot();
    if (snap.type !== "snapshot" || !this.extras) return snap;
    return { ...snap, ...this.extras() };
  }

  /** Change the station through the engine and publish whatever events that produced. */
  mutate<T>(fn: (sim: StationSim) => T): T {
    const result = fn(this.sim);
    this.publish(this.sim.drain());
    return result;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSim(change: Partial<SimStatus>): SimStatus {
    const next = { ...this.sim.simStatus, ...change };
    if (!(next.speed > 0 && next.speed <= 16)) throw new Error("Speed must be between 0 and 16");
    this.sim.setSimStatus(next);
    this.publish(this.sim.drain());
    return next;
  }

  hire(req: HireRequest): CrewMember {
    const template = roleTemplate(req.role);
    if (!template.hireable) throw new Error(`The ${template.title} role cannot be hired`);
    if (!this.sim.workRooms().includes(req.room) || req.room === "bridge") {
      throw new Error(`Room "${req.room}" has no free workstations for new crew`);
    }
    const id = crewIdFor(
      req.name,
      this.sim.crew.map((c) => c.id),
    );
    const member = crewFromTemplate(
      id,
      req.name,
      req.role,
      req.room,
      req.look ?? randomLook(req.role),
    );
    this.sim.hire(member);
    const events = this.sim.drain();
    this.publish(events);
    // Hires are saved straight away: they should survive even an immediate restart.
    this.save();
    const spawned = events.find((e) => e.type === "agent.spawned");
    return spawned?.type === "agent.spawned" ? spawned.crew : member;
  }

  reassign(id: string, room: string): CrewMember {
    if (!this.sim.workRooms().includes(room) || room === "bridge") {
      throw new Error(`Room "${room}" has no workstations`);
    }
    const crew = this.sim.reassign(id, room);
    this.publish(this.sim.drain());
    this.save();
    return crew;
  }

  private publish(events: StationEvent[]): StationEvent[] {
    if (events.length === 0) return events;
    this.pending.push(...events);
    for (const l of this.listeners) l(events);
    return events;
  }
}
