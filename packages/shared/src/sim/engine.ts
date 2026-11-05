import {
  type Activity,
  type AgentState,
  type Anchor,
  type CarryItem,
  type CrewMember,
  type CrewRole,
  type Direction,
  directionTowards,
  findPath,
  type ProviderState,
  pathDurationMs,
  type SimStatus,
  type StationEvent,
  type StationMap,
  sameTile,
  type Task,
  type TaskStatus,
  type Tile,
  type UnsequencedEvent,
} from "../station";
import { CREW_REPLIES, fill, LENS_LINES, linesFor, type RoleLines, WARDEN_LINES } from "./lines";
import { Rng } from "./rng";

/**
 * The station's sim engine. It owns the logical state of the crew (where each one stands, what
 * they are doing, their tasks) and emits station events (packages/shared events.ts).
 *
 * Crew on autopilot run mock behaviours: work at a console, carry deliverables to the QA Bay,
 * take café breaks for rate limits, and WARDEN patrols and nudges idle crew. From Stage 4 the
 * agent runtime takes control of a crew member and drives it with commands instead.
 *
 * It is deterministic for a seed, independent of frame rate, has no browser or Node
 * dependencies, and makes no model or API calls. The server runs it (Stage 3); the client can
 * run it offline (`?mock=1`).
 */

export const MOCK_PROVIDERS = ["nvidia", "cloudflare", "groq"] as const;

export interface SimTiming {
  /** How long one work session at a station lasts; a task takes two or three. */
  workMs: readonly [number, number];
  /** WARDEN nudges crew who have been idle this long. */
  nudgeAfterMs: number;
  /** Idle crew go back to work on their own after this long. */
  idleMaxMs: number;
  /** Chance that a crew member idles after finishing a task. */
  idleChance: number;
  /** Time between mock rate limits. */
  rateLimitEveryMs: readonly [number, number];
  /** How long a rate-limit back-off lasts. */
  backoffMs: readonly [number, number];
  /** Time between mock provider outages, and how long they last. */
  outageEveryMs: readonly [number, number];
  outageMs: readonly [number, number];
}

export const DEFAULT_TIMING: SimTiming = {
  workMs: [7_000, 12_000],
  nudgeAfterMs: 6_000,
  idleMaxMs: 40_000,
  idleChance: 0.22,
  rateLimitEveryMs: [35_000, 65_000],
  backoffMs: [16_000, 28_000],
  outageEveryMs: [140_000, 240_000],
  outageMs: [14_000, 22_000],
};

export interface SimOptions {
  seed?: number;
  /** Simulation start time (ms). */
  start?: number;
  providers?: readonly string[];
  timing?: Partial<SimTiming>;
  /**
   * Invent rate limits and outages (the default). Turn off once real provider status drives the
   * Server Room and café breaks (Stage 4).
   */
  mockProviders?: boolean;
  /**
   * Crew on autopilot invent ambient tasks ("Label: lavender candle") so the station looks busy
   * (the default, for the client's offline mode and the seeded tests). Production turns it off:
   * crew without real work stand easy, and no invented task reaches the board (D-046).
   */
  ambientWork?: boolean;
  /** On restore: never reuse sequence numbers already in the event log. */
  minSeq?: number;
  /**
   * Crew banter (Stage 11 polish): two crew members in the café or on the Bridge now and then
   * swap a line. Off by default so seeded tests stay exact; it draws on its own random stream.
   */
  banter?: boolean;
}

/** What the agent runtime can tell a controlled crew member to do. */
export type SimCommand =
  /** Go to a workstation (or a given anchor) and keep working there. */
  | { kind: "work"; status: string; taskId?: string | null; anchor?: string }
  /** Carry something to the QA Bay, the Bridge or the Owner's Desk, and wait there. */
  | {
      kind: "deliver";
      to: "qa" | "bridge" | "desk";
      item: CarryItem;
      status: string;
      taskId?: string | null;
    }
  /** A café break (rate limit or back-off) until `until`, then wait at the table. */
  | { kind: "break"; status: string; until: number }
  /** Stand somewhere free in the home room. */
  | { kind: "idle"; status?: string | null }
  /** Wait at the Owner's Desk for an approval (❗). */
  | { kind: "await"; status: string; taskId?: string | null }
  /** Stuck: stand at the workstation with a red alert light until told otherwise. */
  | { kind: "blocked"; status: string; taskId?: string | null }
  /** Walk to a room and stand there. */
  | { kind: "go"; room: string; status?: string | null };

/** Everything needed to resume the station after a restart. */
export interface SimSave {
  version: 1;
  t: number;
  seq: number;
  taskCount: number;
  rng: number;
  nextRateLimit: number;
  nextOutage: number;
  recoveries: { at: number; provider: string }[];
  sim: SimStatus;
  crew: CrewMember[];
  agents: AgentState[];
  tasks: Task[];
  providers: ProviderState[];
  intake: string[];
  actorTasks: Record<string, string | null>;
  rework: Record<string, string[]>;
  controlled: string[];
}

interface ActFields {
  activity: Activity;
  facing?: Direction;
  carrying?: CarryItem | null;
  anchor?: string | null;
  taskId?: string | null;
  status?: string | null;
}

type Step =
  | { kind: "act"; fields: ActFields }
  | { kind: "say"; text: string; ttl?: number }
  | { kind: "wait"; ms: number }
  | { kind: "walk"; to: Tile }
  /** Runs at execution time; returned steps run next. Used for choices that depend on state. */
  | { kind: "call"; fn: () => Step[] | undefined };

interface Actor {
  crew: CrewMember;
  state: AgentState;
  plan: Step[];
  busyUntil: number;
  /** When the current walk ends. */
  moveEnd: number;
  /** The anchor this actor has reserved, if any. */
  held: string | null;
  task: Task | null;
  rework: Task[];
  /** Set while WARDEN is on the way to nudge this actor. */
  nudgedBy: string | null;
  /** When the actor settled into being idle (after walking to its idle spot). */
  idleSince: number | null;
  /** Driven by the agent runtime instead of the mock behaviours. */
  controlled: boolean;
  completed: number;
  /** Overseers only: recently visited patrol anchors. */
  visited: string[];
  rounds: number;
}

type Delivery = "qa" | "bridge" | "ledger";

const DELIVERY_BY_ROLE: Partial<Record<CrewRole, Delivery>> = {
  operator: "qa",
  thumbnailer: "qa",
  forger: "qa",
  researcher: "bridge",
  bookkeeper: "ledger",
};

const REVIEW_ROOM = "qa-bay";
const BRIDGE = "bridge";

/** Short exchanges for crew banter: an opener and a reply. */
const BANTER: readonly (readonly [string, string])[] = [
  ["Is the coffee real or generated?", "Upscaled from a 64-pixel bean."],
  ["Lens sent my mug back again.", "Mine too. Halo on the left, apparently."],
  ["How many tags is that now?", "Thirteen. Always thirteen."],
  ["Did WARDEN sleep last night?", "WARDEN doesn't sleep. WARDEN plans."],
  ["The free tier ran dry again.", "Then we draw the scenes ourselves."],
  ["Wall art is selling.", "Of course it is. Calm sells."],
  ["Who keeps naming icons 'Shape 7'?", "Lens, when the sheet is blurry."],
  ["Any orders overnight?", "Only simulated ones. Patience."],
  ["Is it a rate limit or a break?", "Can't it be both?"],
  ["Ledger says we're at 0.0000001% of a trillion.", "That's not nothing."],
];
const DESK_ROOM = "owners-desk";
const BUBBLE_MS = 3_200;
const MAX_REWORKS = 2;
/** Finished tasks kept in memory; the server keeps the full history. */
const FINISHED_KEPT = 300;
/** Real work (objectives' tasks, factory listings) stays in memory much longer than ambient work. */
const REAL_FINISHED_KEPT = 1_000;

export class StationSim {
  private readonly rng: Rng;
  private readonly timing: SimTiming;
  private readonly mockProviders: boolean;
  private readonly ambientWork: boolean;
  private readonly actors: Actor[] = [];
  private readonly byId = new Map<string, Actor>();
  private readonly tasks = new Map<string, Task>();
  private readonly finished: string[] = [];
  private readonly finishedReal: string[] = [];
  private readonly providers = new Map<string, ProviderState>();
  private readonly reserved = new Map<string, string>();
  /** Task ids waiting on the QA intake table, oldest first. */
  private readonly intake: string[] = [];
  private recoveries: { at: number; provider: string }[] = [];
  private status: SimStatus = { paused: false, speed: 1 };
  private t: number;
  private seq = 0;
  private taskCount = 0;
  private nextRateLimit: number;
  private readonly banterOn: boolean;
  private readonly banterRng: Rng;
  private nextBanter: number;
  private readonly replies: { at: number; id: string; text: string }[] = [];
  private nextOutage: number;
  private out: StationEvent[] = [];

  constructor(
    private readonly map: StationMap,
    crew: readonly CrewMember[],
    options: SimOptions = {},
  ) {
    this.rng = new Rng(options.seed ?? 1);
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.mockProviders = options.mockProviders ?? true;
    this.ambientWork = options.ambientWork ?? true;
    this.banterOn = options.banter ?? false;
    this.banterRng = new Rng((options.seed ?? 1) * 7919 + 17);
    this.nextBanter = (options.start ?? 0) + 45_000;
    this.t = options.start ?? 0;
    for (const p of options.providers ?? MOCK_PROVIDERS) {
      this.providers.set(p, { provider: p, state: "ok", until: null, note: null });
    }
    for (const c of crew) {
      const home = map.anchor(c.workstations[0] as string);
      const actor = this.makeActor(c, {
        id: c.id,
        tile: { x: home.x, y: home.y },
        facing: home.facing,
        activity: "idle",
        carrying: null,
        anchor: home.id,
        taskId: null,
        status: null,
        since: this.t,
      });
      // Stagger the first moves so the crew does not start in lockstep.
      actor.busyUntil = this.t + this.rng.range(200, 3_000);
      this.hold(actor, home.id);
    }
    this.nextRateLimit = this.t + this.rng.range(...this.timing.rateLimitEveryMs) * 0.5;
    this.nextOutage = this.t + this.rng.range(...this.timing.outageEveryMs);
  }

  /** Rebuild a sim from a save. State resumes exactly; plans start fresh. */
  static restore(map: StationMap, save: SimSave, options: SimOptions = {}): StationSim {
    const sim = new StationSim(map, [], { ...options, start: save.t });
    sim.seq = save.seq;
    sim.taskCount = save.taskCount;
    sim.rng.state = save.rng;
    sim.nextRateLimit = save.nextRateLimit;
    sim.nextOutage = save.nextOutage;
    sim.recoveries = [...save.recoveries];
    sim.status = { ...save.sim };
    sim.providers.clear();
    for (const p of save.providers) sim.providers.set(p.provider, { ...p });
    for (const task of save.tasks) {
      // Saves from before real work existed held only ambient tasks.
      const legacy = task.mock === undefined && task.objectiveId === undefined;
      // Production leaves invented tasks out, so the crew and the board start clean.
      if ((legacy || task.mock === true) && options.ambientWork === false) continue;
      sim.tasks.set(task.id, legacy ? { ...task, mock: true } : { ...task });
      if (task.status === "done" || task.status === "failed") sim.markFinished(task.id);
    }
    sim.intake.push(...save.intake.filter((id) => sim.tasks.has(id)));
    const states = new Map(save.agents.map((a) => [a.id, a]));
    for (const c of save.crew) {
      const saved = states.get(c.id);
      const home = map.anchor(c.workstations[0] as string);
      const state: AgentState = saved
        ? { ...saved, tile: { ...saved.tile } }
        : {
            id: c.id,
            tile: { x: home.x, y: home.y },
            facing: home.facing,
            activity: "idle",
            carrying: null,
            anchor: home.id,
            taskId: null,
            status: null,
            since: save.t,
          };
      const actor = sim.makeActor(c, state);
      actor.busyUntil = save.t + sim.rng.range(200, 1_500);
      actor.controlled = save.controlled.includes(c.id);
      const taskId = save.actorTasks[c.id];
      actor.task = taskId ? (sim.tasks.get(taskId) ?? null) : null;
      actor.rework = (save.rework[c.id] ?? [])
        .map((id) => sim.tasks.get(id))
        .filter((t): t is Task => t !== undefined);
      const anchor = state.anchor && map.hasAnchor(state.anchor) ? map.anchor(state.anchor) : null;
      if (anchor && sameTile(anchor, state.tile)) sim.hold(actor, anchor.id);
    }
    sim.seq = Math.max(sim.seq, options.minSeq ?? 0);
    return sim;
  }

  get now(): number {
    return this.t;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get simStatus(): SimStatus {
    return { ...this.status };
  }

  get crew(): CrewMember[] {
    return this.actors.map((a) => a.crew);
  }

  /** The full current state, as a server sends it to a client that has just connected. */
  snapshot(): StationEvent {
    return {
      seq: this.seq,
      t: this.t,
      type: "snapshot",
      crew: this.actors.map((a) => structuredClone(a.crew)),
      agents: this.actors.map((a) => ({ ...a.state, tile: { ...a.state.tile } })),
      tasks: [...this.tasks.values()].map((t) => ({ ...t })),
      providers: [...this.providers.values()].map((p) => ({ ...p })),
      sim: { ...this.status },
    };
  }

  /** Everything needed to resume after a restart. */
  save(): SimSave {
    return {
      version: 1,
      t: this.t,
      seq: this.seq,
      taskCount: this.taskCount,
      rng: this.rng.state,
      nextRateLimit: this.nextRateLimit,
      nextOutage: this.nextOutage,
      recoveries: this.recoveries.map((r) => ({ ...r })),
      sim: { ...this.status },
      crew: this.actors.map((a) => structuredClone(a.crew)),
      agents: this.actors.map((a) => ({ ...a.state, tile: { ...a.state.tile } })),
      tasks: [...this.tasks.values()].map((t) => ({ ...t })),
      providers: [...this.providers.values()].map((p) => ({ ...p })),
      intake: [...this.intake],
      actorTasks: Object.fromEntries(this.actors.map((a) => [a.crew.id, a.task?.id ?? null])),
      rework: Object.fromEntries(this.actors.map((a) => [a.crew.id, a.rework.map((t) => t.id)])),
      controlled: this.actors.filter((a) => a.controlled).map((a) => a.crew.id),
    };
  }

  /** Runs the simulation up to `target` and returns the events it produced, in time order. */
  advanceTo(target: number): StationEvent[] {
    for (let guard = 0; guard < 100_000; guard++) {
      const next = this.nextDue();
      if (!next || next.at > target) break;
      this.t = Math.max(this.t, next.at);
      next.run();
    }
    this.t = Math.max(this.t, target);
    return this.drain();
  }

  /** Pending events, including those from commands (hire, reassign...) since the last call. */
  drain(): StationEvent[] {
    const events = this.out;
    this.out = [];
    return events;
  }

  // -- Station commands (REST in Stage 3) ----------------------------------------------------

  /** Records a pause or speed change so clients' clocks follow. */
  setSimStatus(status: SimStatus): void {
    this.status = { ...status };
    this.emit({ type: "sim.status", t: this.t, status: { ...status } });
  }

  /** Rooms a crew member can work in: rooms with at least one workstation. */
  workRooms(): string[] {
    return [...new Set(this.map.anchorsFor("work").map((a) => a.room))];
  }

  /**
   * Hire a crew member. They arrive through the airlock and walk to their room. Workstations
   * left empty are filled with the room's work anchors.
   */
  hire(member: CrewMember): AgentState {
    if (this.byId.has(member.id)) throw new Error(`Crew member "${member.id}" already exists`);
    const crew: CrewMember = {
      ...structuredClone(member),
      workstations:
        member.workstations.length > 0 ? [...member.workstations] : this.stationsFor(member.room),
    };
    if (crew.workstations.length === 0) {
      throw new Error(`Room "${member.room}" has no workstations`);
    }
    const spawnAnchor = this.map.anchorsFor("spawn")[0];
    const taken = this.occupied(null);
    let spawn: Tile = spawnAnchor ?? this.map.anchor(crew.workstations[0] as string);
    if (taken.has(`${spawn.x},${spawn.y}`)) {
      const room = spawnAnchor ? spawnAnchor.room : crew.room;
      spawn = this.looseSpotIn(room, taken) ?? spawn;
    }
    const actor = this.makeActor(crew, {
      id: crew.id,
      tile: { x: spawn.x, y: spawn.y },
      facing: spawnAnchor?.facing ?? "down",
      activity: "idle",
      carrying: null,
      anchor: null,
      taskId: null,
      status: "Just arrived",
      since: this.t,
    });
    actor.busyUntil = this.t + 600;
    actor.plan = [
      this.say("Reporting for duty!"),
      this.wait(1_200),
      ...this.walkHome(actor, `Heading to ${this.map.room(crew.room).name}`),
    ];
    this.emit({
      type: "agent.spawned",
      t: this.t,
      crew: structuredClone(crew),
      agent: { ...actor.state, tile: { ...actor.state.tile } },
    });
    return { ...actor.state };
  }

  /** Move a crew member to another room. They finish walking, then head over. */
  reassign(id: string, roomId: string): CrewMember {
    const actor = this.actor(id);
    this.map.room(roomId);
    const stations = this.stationsFor(roomId, id);
    if (stations.length === 0) throw new Error(`Room "${roomId}" has no workstations`);
    actor.crew = { ...actor.crew, room: roomId, workstations: stations };
    this.emit({ type: "crew.updated", t: this.t, crew: structuredClone(actor.crew) });
    this.interrupt(actor, [
      this.say(`Moving to ${this.map.room(roomId).name}.`),
      ...this.walkHome(actor, `Moving to ${this.map.room(roomId).name}`),
    ]);
    return structuredClone(actor.crew);
  }

  /** Hand a crew member to the agent runtime (or back to autopilot). */
  control(id: string, on: boolean): void {
    const actor = this.actor(id);
    if (actor.controlled === on) return;
    actor.controlled = on;
    actor.nudgedBy = null;
    if (on) {
      // Autopilot work in progress is dropped; its task goes back to "assigned".
      if (actor.task && actor.task.status === "in_progress")
        this.updateTask(actor.task, "assigned");
      actor.task = null;
      this.interrupt(actor, [this.act({ activity: "idle", status: null, taskId: null })]);
    } else {
      this.interrupt(actor, []);
    }
  }

  isControlled(id: string): boolean {
    return this.actor(id).controlled;
  }

  /** Tell a controlled crew member what to do. Walks in progress finish first. */
  command(id: string, cmd: SimCommand): void {
    const actor = this.actor(id);
    if (!actor.controlled) throw new Error(`"${id}" is on autopilot; call control() first`);
    const steps = this.commandSteps(actor, cmd);
    // The new activity shows straight away, even if a walk in progress finishes first.
    while (steps[0]?.kind === "act") this.execute(actor, steps.shift() as Step);
    this.interrupt(actor, steps);
  }

  /** A speech bubble, without changing what the crew member is doing. */
  sayNow(id: string, text: string, ttl = BUBBLE_MS): void {
    this.actor(id);
    this.emit({ type: "agent.say", t: this.t, id, text: text.slice(0, 80), ttl });
  }

  /** Create or update a task (the runtime's tasks, from Stage 4). */
  upsertTask(task: Task): void {
    const existing = this.tasks.get(task.id);
    const merged: Task = { ...existing, ...task, updatedAt: this.t };
    this.tasks.set(task.id, merged);
    if (merged.status === "done" || merged.status === "failed") this.markFinished(merged.id);
    this.emit({ type: "task.updated", t: this.t, task: { ...merged } });
  }

  /** Publish another station record (objective, approval, deliverable) in the event stream. */
  publish(event: UnsequencedEvent): void {
    this.emit({ ...event, t: this.t } as UnsequencedEvent);
  }

  /** Real provider status (Stage 4); also shows on the Server Room racks. */
  setProviderStatus(
    provider: string,
    state: ProviderState["state"],
    until: number | null,
    note: string | null,
  ): void {
    const current = this.providers.get(provider);
    if (current && current.state === state && current.until === until && current.note === note) {
      return;
    }
    this.setProvider(provider, state, until, note);
  }

  /** Tasks in memory: open ones and recently finished ones. */
  get taskList(): Task[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  task(id: string): Task | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  agentState(id: string): AgentState {
    const a = this.actor(id);
    return { ...a.state, tile: { ...a.state.tile } };
  }

  // -- Scheduling ---------------------------------------------------------------------------

  private actor(id: string): Actor {
    const a = this.byId.get(id);
    if (!a) throw new Error(`Unknown crew member "${id}"`);
    return a;
  }

  private makeActor(crew: CrewMember, state: AgentState): Actor {
    const actor: Actor = {
      crew,
      state,
      plan: [],
      busyUntil: this.t,
      moveEnd: this.t,
      held: null,
      task: null,
      rework: [],
      nudgedBy: null,
      idleSince: null,
      controlled: false,
      completed: 0,
      visited: [],
      rounds: 0,
    };
    this.actors.push(actor);
    this.byId.set(crew.id, actor);
    return actor;
  }

  /** Work anchors in a room, the free ones (nobody's home) first. */
  private stationsFor(roomId: string, self?: string): string[] {
    const homes = new Set(
      this.actors.filter((a) => a.crew.id !== self).map((a) => a.crew.workstations[0]),
    );
    const anchors = this.map.anchorsFor("work", roomId).map((a) => a.id);
    return [...anchors.filter((id) => !homes.has(id)), ...anchors.filter((id) => homes.has(id))];
  }

  private nextDue(): { at: number; run: () => void } | null {
    let best: { at: number; run: () => void } | null = null;
    for (const a of this.actors) {
      if (!best || a.busyUntil < best.at) best = { at: a.busyUntil, run: () => this.runActor(a) };
    }
    const recovery = this.recoveries[0];
    if (recovery && (!best || recovery.at < best.at)) {
      best = { at: recovery.at, run: () => this.recover() };
    }
    if (this.banterOn && (!best || this.nextBanter < best.at)) {
      best = { at: this.nextBanter, run: () => this.banter() };
    }
    const reply = this.replies[0];
    if (reply && (!best || reply.at < best.at)) {
      best = {
        at: reply.at,
        run: () => {
          this.replies.shift();
          this.sayNow(reply.id, reply.text);
        },
      };
    }
    if (this.mockProviders) {
      if (!best || this.nextRateLimit < best.at) {
        best = { at: this.nextRateLimit, run: () => this.rateLimit() };
      }
      if (this.nextOutage < best.at) best = { at: this.nextOutage, run: () => this.outage() };
    }
    return best;
  }

  private runActor(actor: Actor): void {
    for (let i = 0; actor.busyUntil <= this.t; i++) {
      if (i > 200) {
        // A plan made only of instant steps; back off instead of spinning.
        actor.busyUntil = this.t + 1_000;
        break;
      }
      if (actor.plan.length === 0) actor.plan = this.planFor(actor);
      const step = actor.plan.shift();
      if (!step) continue;
      this.execute(actor, step);
    }
  }

  private execute(actor: Actor, step: Step): void {
    switch (step.kind) {
      case "act":
        this.activity(actor, step.fields);
        return;
      case "say":
        this.emit({
          type: "agent.say",
          t: this.t,
          id: actor.crew.id,
          text: step.text,
          ttl: step.ttl ?? BUBBLE_MS,
        });
        return;
      case "wait":
        actor.busyUntil = this.t + Math.max(0, step.ms);
        return;
      case "walk": {
        const from = { x: actor.state.tile.x, y: actor.state.tile.y };
        const to = { x: step.to.x, y: step.to.y };
        if (sameTile(from, to)) return;
        const path = findPath(this.map, from, to);
        if (!path) return;
        this.emit({ type: "agent.moved", t: this.t, id: actor.crew.id, from, to, t0: this.t });
        const duration = pathDurationMs(path);
        const before = path[path.length - 2] ?? from;
        actor.state.tile = to;
        actor.state.facing = directionTowards(before, to, actor.state.facing);
        actor.moveEnd = this.t + duration;
        actor.busyUntil = this.t + duration;
        return;
      }
      case "call": {
        const more = step.fn();
        if (more && more.length > 0) actor.plan.unshift(...more);
        return;
      }
    }
  }

  /** Replace an actor's plan. A walk in progress always finishes first. */
  private interrupt(actor: Actor, steps: Step[]): void {
    actor.plan = steps;
    actor.busyUntil = Math.max(this.t, actor.moveEnd);
  }

  // -- Events -------------------------------------------------------------------------------

  private emit(event: UnsequencedEvent): void {
    this.out.push({ ...event, seq: ++this.seq } as StationEvent);
  }

  private activity(actor: Actor, f: ActFields): void {
    const s = actor.state;
    if (f.activity !== s.activity) s.since = this.t;
    if (f.activity !== "idle") actor.idleSince = null;
    s.activity = f.activity;
    if (f.facing !== undefined) s.facing = f.facing;
    if (f.carrying !== undefined) s.carrying = f.carrying;
    if (f.anchor !== undefined) s.anchor = f.anchor;
    if (f.taskId !== undefined) s.taskId = f.taskId;
    if (f.status !== undefined) s.status = f.status;
    const event: UnsequencedEvent = {
      type: "agent.activity",
      t: this.t,
      id: s.id,
      activity: f.activity,
    };
    if (f.facing !== undefined) event.facing = f.facing;
    if (f.carrying !== undefined) event.carrying = f.carrying;
    if (f.anchor !== undefined) event.anchor = f.anchor;
    if (f.taskId !== undefined) event.taskId = f.taskId;
    if (f.status !== undefined) event.status = f.status;
    this.emit(event);
  }

  private updateTask(task: Task, status: TaskStatus): void {
    task.status = status;
    task.updatedAt = this.t;
    this.tasks.set(task.id, task);
    if (status === "done" || status === "failed") this.markFinished(task.id);
    this.emit({ type: "task.updated", t: this.t, task: { ...task } });
  }

  /**
   * Finished tasks stay in memory for a while, then rotate out. Ambient tasks rotate quickly; real
   * ones (mock is false or absent) have their own, much larger history, so the constant ambient
   * churn never pushes out a deliverable the runtime or a factory still refers to.
   */
  private markFinished(id: string): void {
    const real = this.tasks.get(id)?.mock !== true;
    const list = real ? this.finishedReal : this.finished;
    const cap = real ? REAL_FINISHED_KEPT : FINISHED_KEPT;
    if (!list.includes(id)) list.push(id);
    while (list.length > cap) {
      const old = list.shift();
      if (old) this.tasks.delete(old);
    }
  }

  // -- Step helpers -------------------------------------------------------------------------

  private act(fields: ActFields): Step {
    return { kind: "act", fields };
  }

  private say(text: string, ttl?: number): Step {
    return ttl === undefined ? { kind: "say", text } : { kind: "say", text, ttl };
  }

  private wait(ms: number): Step {
    return { kind: "wait", ms };
  }

  private call(fn: () => Step[] | undefined): Step {
    return { kind: "call", fn };
  }

  /** Reserve an anchor (releasing the old one), walk there, and face the way it faces. */
  private goTo(actor: Actor, anchor: Anchor, arrive: ActFields): Step[] {
    return [
      this.call(() => {
        this.hold(actor, anchor.id);
        return undefined;
      }),
      { kind: "walk", to: anchor },
      this.act({ ...arrive, facing: arrive.facing ?? anchor.facing, anchor: anchor.id }),
    ];
  }

  /** Walk to a plain tile, giving up any reserved anchor. */
  private goToTile(actor: Actor, tile: Tile): Step[] {
    return [
      this.call(() => {
        this.hold(actor, null);
        return undefined;
      }),
      { kind: "walk", to: tile },
    ];
  }

  /** Walk to the home workstation (or somewhere free in the home room). */
  private walkHome(actor: Actor, status: string): Step[] {
    return [
      this.act({ activity: "idle", status, carrying: null }),
      this.call(() => {
        const station = this.pickStation(actor, false);
        if (station) return this.goTo(actor, station, { activity: "idle" });
        const spot = this.looseSpot(actor, actor.crew.room);
        return spot ? this.goToTile(actor, spot) : undefined;
      }),
    ];
  }

  private hold(actor: Actor, anchorId: string | null): void {
    if (actor.held && this.reserved.get(actor.held) === actor.crew.id) {
      this.reserved.delete(actor.held);
    }
    actor.held = anchorId;
    if (anchorId) this.reserved.set(anchorId, actor.crew.id);
  }

  private isFree(anchorId: string, actor: Actor): boolean {
    const owner = this.reserved.get(anchorId);
    return owner === undefined || owner === actor.crew.id;
  }

  private freeAnchor(actor: Actor, anchors: readonly Anchor[]): Anchor | undefined {
    const free = anchors.filter((a) => this.isFree(a.id, actor));
    return free.length > 0 ? this.rng.pick(free) : undefined;
  }

  private occupied(except: Actor | null): Set<string> {
    const set = new Set<string>();
    for (const a of this.actors) if (a !== except) set.add(`${a.state.tile.x},${a.state.tile.y}`);
    return set;
  }

  /** A random free floor tile in a room that is not an anchor or someone else's spot. */
  private looseSpot(actor: Actor, roomId: string): Tile | undefined {
    return this.looseSpotIn(roomId, this.occupied(actor));
  }

  private looseSpotIn(roomId: string, taken: Set<string>): Tile | undefined {
    const room = this.map.room(roomId);
    const anchors = new Set(this.map.anchors.map((a) => `${a.x},${a.y}`));
    const options: Tile[] = [];
    for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        const key = `${x},${y}`;
        if (this.map.isWalkable(x, y) && !anchors.has(key) && !taken.has(key)) {
          options.push({ x, y });
        }
      }
    }
    return options.length > 0 ? this.rng.pick(options) : undefined;
  }

  private lines(actor: Actor): RoleLines {
    return linesFor(actor.crew.id, actor.crew.role);
  }

  // -- Commands from the agent runtime -----------------------------------------------------

  private commandSteps(actor: Actor, cmd: SimCommand): Step[] {
    switch (cmd.kind) {
      case "work": {
        const work: ActFields = {
          activity: "work",
          status: cmd.status,
          taskId: cmd.taskId ?? null,
          carrying: null,
        };
        return [
          this.act(work),
          this.call(() => {
            const station =
              cmd.anchor && this.map.hasAnchor(cmd.anchor)
                ? this.map.anchor(cmd.anchor)
                : this.pickStation(actor, false);
            if (station) return this.goTo(actor, station, work);
            const spot = this.looseSpot(actor, actor.crew.room);
            return spot ? [...this.goToTile(actor, spot), this.act(work)] : undefined;
          }),
        ];
      }
      case "deliver": {
        const fields: ActFields = {
          activity: "deliver",
          carrying: cmd.item,
          status: cmd.status,
          taskId: cmd.taskId ?? null,
        };
        const target =
          cmd.to === "qa"
            ? { anchors: this.map.anchorsFor("deliver", REVIEW_ROOM), room: REVIEW_ROOM }
            : cmd.to === "bridge"
              ? { anchors: this.map.anchorsFor("report", BRIDGE), room: BRIDGE }
              : { anchors: this.map.anchorsFor("queue", DESK_ROOM), room: DESK_ROOM };
        return [
          this.act(fields),
          this.call(() => {
            const spot = this.freeAnchor(actor, target.anchors);
            if (spot) return this.goTo(actor, spot, { activity: "deliver" });
            const loose = this.looseSpot(actor, target.room);
            return loose ? this.goToTile(actor, loose) : undefined;
          }),
          this.act({ activity: "deliver", carrying: null }),
        ];
      }
      case "break":
        return this.coffeeBreak(actor, cmd.status, cmd.until, false);
      case "idle":
        return [
          this.act({ activity: "idle", status: cmd.status ?? null, carrying: null, anchor: null }),
          this.call(() => {
            const spot = this.looseSpot(actor, actor.crew.room);
            return spot
              ? [...this.goToTile(actor, spot), this.act({ activity: "idle", facing: "down" })]
              : undefined;
          }),
        ];
      case "await":
        return [
          this.act({
            activity: "await",
            status: cmd.status,
            taskId: cmd.taskId ?? null,
            carrying: "datapad",
          }),
          this.call(() => {
            const spot = this.freeAnchor(actor, this.map.anchorsFor("queue", DESK_ROOM));
            if (spot) return this.goTo(actor, spot, { activity: "await", carrying: null });
            const loose = this.looseSpot(actor, DESK_ROOM);
            return loose
              ? [...this.goToTile(actor, loose), this.act({ activity: "await", carrying: null })]
              : undefined;
          }),
        ];
      case "blocked":
        return [
          this.act({
            activity: "blocked",
            status: cmd.status,
            taskId: cmd.taskId ?? null,
            carrying: null,
          }),
        ];
      case "go":
        return [
          this.act({ activity: "idle", status: cmd.status ?? null, carrying: null }),
          this.call(() => {
            const spot = this.looseSpot(actor, cmd.room);
            return spot ? this.goToTile(actor, spot) : undefined;
          }),
        ];
    }
  }

  // -- Planning (autopilot) ----------------------------------------------------------------

  private planFor(actor: Actor): Step[] {
    // Controlled crew hold still until the runtime sends the next command.
    if (actor.controlled) return [this.wait(60_000)];
    if (actor.crew.role === "overseer") return this.planOverseer(actor);
    if (actor.crew.role === "reviewer") return this.planReviewer(actor);
    return this.planWorker(actor);
  }

  private planWorker(actor: Actor): Step[] {
    const steps: Step[] = [];
    let task = actor.task;
    // A task takes a few work sessions, sometimes at different stations (design, then list).
    let sessions = this.rng.int(2, 3);
    if (task) {
      sessions = 1; // Resuming after a break: finish what is left.
    } else {
      const rework = actor.rework.shift();
      if (rework) {
        task = rework;
        sessions = 1;
        steps.push(this.say(this.rng.pick(CREW_REPLIES.rework)));
      } else if (!this.ambientWork) {
        return this.offDuty(actor);
      } else {
        task = this.newTask(actor);
        const created = task;
        steps.push(
          this.call(() => {
            this.updateTask(created, "assigned");
            return undefined;
          }),
        );
      }
      actor.task = task;
    }
    const current = task;
    const lines = this.lines(actor).work;
    for (let i = 0; i < sessions; i++) {
      steps.push(
        this.call(() => {
          const work: ActFields = { activity: "work", status: current.title, taskId: current.id };
          const station = this.pickStation(actor, i > 0);
          const go = station
            ? this.goTo(actor, station, work)
            : (() => {
                const spot = this.looseSpot(actor, actor.crew.room);
                return spot ? [...this.goToTile(actor, spot), this.act(work)] : [this.act(work)];
              })();
          return [
            this.act({ ...work, carrying: null }),
            ...go,
            this.call(() => {
              if (current.status !== "in_progress") this.updateTask(current, "in_progress");
              return undefined;
            }),
            this.say(this.rng.pick(lines)),
            this.wait(this.rng.range(...this.timing.workMs)),
          ];
        }),
      );
    }
    steps.push(this.call(() => this.finishTask(actor)));
    return steps;
  }

  /**
   * Home most of the time; a later session of a task often moves to another station. Returns
   * null when every station is taken (crew members can share rooms with others' homes).
   */
  private pickStation(actor: Actor, later: boolean): Anchor | null {
    const ids = actor.crew.workstations;
    const homeId = ids[0] as string;
    const here = actor.held;
    if (ids.length > 1 && this.rng.chance(later ? 0.5 : 0.2)) {
      const alt = this.freeAnchor(
        actor,
        ids.filter((id) => id !== here).map((id) => this.map.anchor(id)),
      );
      if (alt) return alt;
    }
    if (here && ids.includes(here)) return this.map.anchor(here);
    if (this.isFree(homeId, actor)) return this.map.anchor(homeId);
    return (
      this.freeAnchor(
        actor,
        ids.map((id) => this.map.anchor(id)),
      ) ?? null
    );
  }

  private newTask(actor: Actor): Task {
    const lines = this.lines(actor);
    this.taskCount += 1;
    const task: Task = {
      id: `T-${String(this.taskCount).padStart(4, "0")}`,
      title: fill(this.rng.pick(lines.tasks), { x: this.rng.pick(lines.subjects) }),
      room: actor.crew.room,
      assignee: actor.crew.id,
      status: "assigned",
      reworks: 0,
      createdAt: this.t,
      updatedAt: this.t,
      mock: true,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  private finishTask(actor: Actor): Step[] {
    const task = actor.task;
    if (!task) return [];
    const delivery = DELIVERY_BY_ROLE[actor.crew.role] ?? "qa";
    if (delivery === "qa") return this.deliverToQa(actor, task);
    if (delivery === "bridge") return this.reportToBridge(actor, task);
    // Bookkeepers file most reports in place and take one in three to the Bridge.
    actor.completed += 1;
    if (actor.completed % 3 === 0) return this.reportToBridge(actor, task);
    this.updateTask(task, "done");
    actor.task = null;
    return [this.wait(800), ...this.maybeIdle(actor)];
  }

  private deliverToQa(actor: Actor, task: Task): Step[] {
    const drops = this.map.anchorsFor("deliver", REVIEW_ROOM);
    return [
      this.act({ activity: "deliver", carrying: "crate", status: `Taking "${task.title}" to QA` }),
      this.call(() => {
        const drop = this.freeAnchor(actor, drops);
        if (drop) return this.goTo(actor, drop, { activity: "deliver" });
        const spot = this.looseSpot(actor, REVIEW_ROOM);
        return spot ? this.goToTile(actor, spot) : undefined;
      }),
      this.act({ activity: "deliver", carrying: null }),
      this.call(() => {
        this.updateTask(task, "review");
        this.intake.push(task.id);
        actor.task = null;
        actor.completed += 1;
        return undefined;
      }),
      this.say(this.rng.pick(CREW_REPLIES.delivered)),
      this.wait(1_200),
      this.call(() => this.maybeIdle(actor)),
    ];
  }

  private reportToBridge(actor: Actor, task: Task): Step[] {
    const spots = this.map.anchorsFor("report", BRIDGE);
    return [
      this.act({ activity: "deliver", carrying: "datapad", status: "Report for WARDEN" }),
      this.call(() => {
        const spot = this.freeAnchor(actor, spots);
        if (spot) return this.goTo(actor, spot, { activity: "deliver" });
        const loose = this.looseSpot(actor, BRIDGE);
        return loose ? this.goToTile(actor, loose) : undefined;
      }),
      this.act({ activity: "deliver", carrying: null }),
      this.call(() => {
        this.updateTask(task, "done");
        actor.task = null;
        this.thankFromOverseer();
        return undefined;
      }),
      this.say(this.rng.pick(CREW_REPLIES.report)),
      this.wait(1_500),
      this.call(() => this.maybeIdle(actor)),
    ];
  }

  /** The Overseer acknowledges a report if it is standing on the Bridge. */
  private thankFromOverseer(): void {
    const overseer = this.actors.find((a) => a.crew.role === "overseer" && !a.controlled);
    if (!overseer || overseer.moveEnd > this.t) return;
    if (this.map.roomAt(overseer.state.tile.x, overseer.state.tile.y)?.id !== BRIDGE) return;
    this.emit({
      type: "agent.say",
      t: this.t,
      id: overseer.crew.id,
      text: this.rng.pick(WARDEN_LINES.reportThanks),
      ttl: BUBBLE_MS,
    });
  }

  /** Production with no real work for this crew member: stand easy in their room for a while. */
  private offDuty(actor: Actor): Step[] {
    const spot = this.looseSpot(actor, actor.crew.room);
    return [
      this.act({ activity: "idle", status: null, taskId: null, carrying: null, anchor: null }),
      ...(spot ? this.goToTile(actor, spot) : []),
      this.act({ activity: "idle", facing: "down" }),
      this.wait(this.rng.range(20_000, 45_000)),
    ];
  }

  private maybeIdle(actor: Actor): Step[] {
    if (!this.rng.chance(this.timing.idleChance)) return [];
    const spot = this.looseSpot(actor, actor.crew.room);
    return [
      this.act({ activity: "idle", status: null, taskId: null, carrying: null, anchor: null }),
      ...(spot ? this.goToTile(actor, spot) : []),
      this.act({ activity: "idle", facing: "down" }),
      // The Overseer's patience counts from arrival at the idle spot.
      this.call(() => {
        actor.idleSince = this.t;
        return undefined;
      }),
      this.wait(this.timing.idleMaxMs),
    ];
  }

  // Reviewers: review whatever is on the intake table, otherwise run policy checks.
  private planReviewer(actor: Actor): Step[] {
    const taskId = this.intake.shift();
    const task = taskId ? this.tasks.get(taskId) : undefined;
    if (!task) {
      // Real reviews are run by the agent runtime; production invents no policy checks.
      if (!this.ambientWork) return this.offDuty(actor);
      const station = this.pickStation(actor, false);
      const work: ActFields = { activity: "work", status: "Policy checks", taskId: null };
      const steps: Step[] = station ? this.goTo(actor, station, work) : [this.act(work)];
      if (this.rng.chance(0.5)) steps.push(this.say(this.rng.pick(LENS_LINES.idle)));
      steps.push(this.wait(this.rng.range(4_000, 7_000)));
      return steps;
    }
    const drops = this.map.anchorsFor("deliver", REVIEW_ROOM);
    const scan = this.map.anchorsFor("review", REVIEW_ROOM)[0];
    const pickUp = this.call(() => {
      const drop = this.freeAnchor(actor, drops);
      return drop ? this.goTo(actor, drop, { activity: "review" }) : undefined;
    });
    // With a backlog, the reviewer checks deliverables right at the intake table.
    if (this.intake.length >= 1 || !scan || !this.isFree(scan.id, actor)) {
      return [
        this.act({ activity: "review", status: `Quick check: "${task.title}"`, taskId: task.id }),
        pickUp,
        this.say(this.rng.pick(LENS_LINES.review)),
        this.wait(this.rng.range(2_500, 3_500)),
        this.call(() => this.verdict(task)),
        this.wait(700),
      ];
    }
    return [
      this.act({ activity: "review", status: `Picking up "${task.title}"`, taskId: task.id }),
      pickUp,
      this.wait(600),
      this.act({ activity: "review", carrying: "crate" }),
      ...this.goTo(actor, scan, {
        activity: "review",
        carrying: null,
        status: `Reviewing "${task.title}"`,
      }),
      this.say(this.rng.pick(LENS_LINES.review)),
      this.wait(this.rng.range(2_200, 3_000)),
      this.say(this.rng.pick(LENS_LINES.review)),
      this.wait(this.rng.range(1_800, 2_600)),
      this.call(() => this.verdict(task)),
      this.wait(1_200),
    ];
  }

  private verdict(task: Task): Step[] {
    const passChance = task.reworks >= MAX_REWORKS ? 1 : task.reworks === 1 ? 0.9 : 0.72;
    if (this.rng.chance(passChance)) {
      this.updateTask(task, "done");
      return [this.say(this.rng.pick(LENS_LINES.pass))];
    }
    task.reworks += 1;
    this.updateTask(task, "rework");
    const assignee = this.byId.get(task.assignee);
    if (assignee && !assignee.controlled) assignee.rework.push(task);
    return [this.say(this.rng.pick(LENS_LINES.fail))];
  }

  // Overseers: nudge idle crew first; otherwise alternate planning and patrols.
  private planOverseer(actor: Actor): Step[] {
    const idle = this.findIdle(actor);
    if (idle) return this.nudge(actor, idle);
    actor.rounds += 1;
    if (actor.rounds % 4 === 1) {
      const command = this.map.anchor(actor.crew.workstations[0] as string);
      if (this.isFree(command.id, actor)) {
        return [
          ...this.goTo(actor, command, {
            activity: "work",
            status: "Planning objectives",
            taskId: null,
          }),
          this.say(this.rng.pick(WARDEN_LINES.plan)),
          this.wait(this.rng.range(3_500, 6_000)),
          this.say(this.rng.pick(WARDEN_LINES.plan)),
          this.wait(this.rng.range(2_500, 4_000)),
        ];
      }
    }
    const choices = this.map
      .anchorsFor("patrol")
      .filter((a) => !actor.visited.includes(a.id) && this.isFree(a.id, actor));
    const target = choices.length > 0 ? this.rng.pick(choices) : undefined;
    if (!target) return [this.wait(2_000)];
    actor.visited = [...actor.visited, target.id].slice(-4);
    const roomName = this.map.room(target.room).name;
    const steps: Step[] = [
      this.act({ activity: "patrol", status: `Patrol: ${roomName}`, taskId: null }),
      ...this.goTo(actor, target, { activity: "patrol" }),
    ];
    if (this.rng.chance(0.4)) steps.push(this.say(this.rng.pick(WARDEN_LINES.patrol)));
    steps.push(this.wait(this.rng.range(1_500, 3_000)));
    return steps;
  }

  private findIdle(overseer: Actor): Actor | undefined {
    // Without invented work, idle crew are simply off duty: nothing to nudge them back to.
    if (!this.ambientWork) return undefined;
    let pick: Actor | undefined;
    for (const a of this.actors) {
      if (a === overseer || a.nudgedBy || a.idleSince === null || a.controlled) continue;
      if (a.state.activity !== "idle" || a.moveEnd > this.t) continue;
      if (this.t - a.idleSince < this.timing.nudgeAfterMs) continue;
      if (!pick || a.idleSince < (pick.idleSince ?? Number.POSITIVE_INFINITY)) pick = a;
    }
    return pick;
  }

  private nudge(overseer: Actor, target: Actor): Step[] {
    target.nudgedBy = overseer.crew.id;
    const spot = this.nudgeSpot(overseer, target);
    const name = target.crew.name;
    if (!spot) {
      target.nudgedBy = null;
      return [this.wait(1_000)];
    }
    return [
      this.act({ activity: "patrol", status: `Checking on ${name}`, taskId: null }),
      ...this.goToTile(overseer, spot),
      this.call(() => {
        const stillIdle = target.state.activity === "idle" && target.moveEnd <= this.t;
        if (!stillIdle || target.nudgedBy !== overseer.crew.id) {
          target.nudgedBy = null;
          return [this.act({ activity: "patrol", status: null }), this.wait(800)];
        }
        const towards = directionTowards(spot, target.state.tile);
        return [
          this.act({ activity: "nudge", facing: towards, status: `Nudging ${name}` }),
          this.say(fill(this.rng.pick(WARDEN_LINES.nudge), { name })),
          this.wait(1_400),
          this.call(() => {
            // The target may have given up waiting and gone back to work meanwhile.
            const listening =
              target.state.activity === "idle" &&
              target.moveEnd <= this.t &&
              target.nudgedBy === overseer.crew.id &&
              !target.controlled;
            if (!listening) {
              target.nudgedBy = null;
              return undefined;
            }
            this.interrupt(target, [
              this.act({
                activity: "idle",
                facing: directionTowards(target.state.tile, spot),
                status: null,
              }),
              this.say(this.rng.pick(CREW_REPLIES.nudged)),
              this.wait(900),
              this.call(() => {
                target.nudgedBy = null;
                return undefined;
              }),
            ]);
            return undefined;
          }),
          this.wait(1_600),
          this.act({ activity: "patrol", status: null }),
        ];
      }),
    ];
  }

  /**
   * A free tile next to the target (or two steps away), as close to the Overseer as possible.
   * Anchor tiles are avoided so the Overseer never stands on someone's workstation.
   */
  private nudgeSpot(overseer: Actor, target: Actor): Tile | undefined {
    const taken = this.occupied(overseer);
    const anchors = new Set(this.map.anchors.map((a) => `${a.x},${a.y}`));
    const ok = (t: Tile) => !taken.has(`${t.x},${t.y}`) && !anchors.has(`${t.x},${t.y}`);
    const near = this.map.walkableNeighbours(target.state.tile);
    let options = near.filter(ok);
    if (options.length === 0) {
      const ring = near.flatMap((t) => this.map.walkableNeighbours(t));
      options = ring.filter((t) => ok(t) && !sameTile(t, target.state.tile));
    }
    let best: Tile | undefined;
    let bestLength = Number.POSITIVE_INFINITY;
    for (const t of options) {
      const path = findPath(this.map, overseer.state.tile, t);
      if (path && path.length < bestLength) {
        best = t;
        bestLength = path.length;
      }
    }
    return best;
  }

  // -- Providers: rate limits send crew to the café; outages spark the Server Room racks. ----

  /** Two crew members sharing the café or the Bridge swap a line. */
  private banter(): void {
    this.nextBanter = this.t + this.banterRng.range(60_000, 150_000);
    const byRoom = new Map<string, Actor[]>();
    for (const a of this.actors) {
      const room = this.map.roomAt(a.state.tile.x, a.state.tile.y)?.id;
      if (room !== "cafe" && room !== BRIDGE) continue;
      byRoom.set(room, [...(byRoom.get(room) ?? []), a]);
    }
    const rooms = [...byRoom.values()].filter((list) => list.length >= 2);
    const crowd = rooms[this.banterRng.int(0, Math.max(0, rooms.length - 1))];
    if (!crowd) return;
    const first = crowd[this.banterRng.int(0, crowd.length - 1)];
    const others = crowd.filter((a) => a !== first);
    const second = others[this.banterRng.int(0, others.length - 1)];
    const pair = BANTER[this.banterRng.int(0, BANTER.length - 1)];
    if (!first || !second || !pair) return;
    this.sayNow(first.state.id, pair[0]);
    this.replies.push({ at: this.t + 2_200, id: second.state.id, text: pair[1] });
  }

  private rateLimit(): void {
    this.nextRateLimit = this.t + this.rng.range(...this.timing.rateLimitEveryMs);
    const provider = this.rng.weighted<string>(
      [...this.providers.keys()].map((p) => [p, p === "nvidia" ? 6 : 2] as const),
    );
    const current = this.providers.get(provider);
    if (current?.state !== "ok") return;
    const backoff = this.rng.range(...this.timing.backoffMs);
    const until = this.t + backoff;
    this.setProvider(
      provider,
      "limited",
      until,
      `HTTP 429, backing off ${Math.round(backoff / 1000)} s`,
    );
    const working = this.actors.filter(
      (a) =>
        a.crew.role !== "overseer" &&
        // Reviewers stay at the QA Bay so deliverables do not pile up during a break.
        a.crew.role !== "reviewer" &&
        !a.controlled &&
        a.state.activity === "work" &&
        a.moveEnd <= this.t &&
        a.busyUntil > this.t &&
        !a.nudgedBy,
    );
    const count = Math.min(working.length, this.rng.int(1, 2));
    for (let i = 0; i < count; i++) {
      const victim = working.splice(this.rng.int(0, working.length - 1), 1)[0];
      if (victim) {
        this.interrupt(
          victim,
          this.coffeeBreak(victim, `Waiting out a ${provider} rate limit`, until, true),
        );
      }
    }
  }

  private coffeeBreak(actor: Actor, status: string, until: number, chatty: boolean): Step[] {
    const machines = this.map.anchorsFor("coffee", "cafe");
    const seats = this.map.anchorsFor("rest", "cafe");
    return [
      ...(chatty ? [this.say(this.rng.pick(CREW_REPLIES.coffee))] : []),
      this.act({ activity: "coffee", status, carrying: null }),
      this.call(() => {
        const machine = this.freeAnchor(actor, machines);
        if (machine) {
          return [...this.goTo(actor, machine, { activity: "coffee" }), this.wait(2_200)];
        }
        const spot = this.looseSpot(actor, "cafe");
        return spot ? this.goToTile(actor, spot) : undefined;
      }),
      this.act({ activity: "coffee", carrying: "cup" }),
      this.call(() => {
        const seat = this.freeAnchor(actor, seats);
        if (seat) return this.goTo(actor, seat, { activity: "coffee" });
        const spot = this.looseSpot(actor, "cafe");
        return spot ? this.goToTile(actor, spot) : undefined;
      }),
      this.call(() => {
        const steps: Step[] = [];
        if (chatty && this.rng.chance(0.5)) {
          steps.push(this.say(this.rng.pick(CREW_REPLIES.coffeeChat)));
        }
        steps.push(this.wait(Math.max(3_000, until - this.t + this.rng.range(500, 2_500))));
        return steps;
      }),
      this.act({ activity: "coffee", carrying: null }),
      ...(chatty ? [this.say(this.rng.pick(CREW_REPLIES.coffeeDone))] : []),
      this.wait(600),
    ];
  }

  private outage(): void {
    this.nextOutage = this.t + this.rng.range(...this.timing.outageEveryMs);
    const healthy = [...this.providers.values()].filter((p) => p.state === "ok");
    if (healthy.length === 0) return;
    const provider = this.rng.pick(healthy).provider;
    const until = this.t + this.rng.range(...this.timing.outageMs);
    this.setProvider(provider, "down", until, "HTTP 503, circuit breaker open");
  }

  private recover(): void {
    const next = this.recoveries.shift();
    if (!next) return;
    const current = this.providers.get(next.provider);
    if (current && current.until !== null && current.until <= this.t) {
      this.setProvider(next.provider, "ok", null, null);
    }
  }

  private setProvider(
    provider: string,
    state: ProviderState["state"],
    until: number | null,
    note: string | null,
  ): void {
    const status: ProviderState = { provider, state, until, note };
    this.providers.set(provider, status);
    if (until !== null) {
      this.recoveries.push({ at: until, provider });
      this.recoveries.sort((a, b) => a.at - b.at);
    }
    this.emit({ type: "provider.status", t: this.t, status: { ...status } });
  }
}
