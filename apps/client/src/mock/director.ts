import {
  type Activity,
  type AgentState,
  type Anchor,
  type CarryItem,
  type CrewMember,
  type Direction,
  directionTowards,
  findPath,
  OVERSEER_ID,
  type ProviderState,
  pathDurationMs,
  type StationEvent,
  type StationMap,
  sameTile,
  type Task,
  type TaskStatus,
  type Tile,
  type UnsequencedEvent,
} from "@orbital/shared";
import { CREW_REPLIES, fill, LENS_LINES, ROLE_LINES, type RoleLines, WARDEN_LINES } from "./lines";
import { Rng } from "./rng";

/**
 * The Stage 2 mock director: a stand-in for the Stage 3 sim engine. It owns the logical state of
 * the crew and emits the same station events the server will send (packages/shared events.ts):
 * work at a console, deliveries to the QA Bay, café breaks for rate limits, and WARDEN patrolling
 * and nudging idle crew. It is deterministic for a given seed, has no browser dependencies, and
 * makes no model or API calls.
 */

export const MOCK_PROVIDERS = ["nvidia", "cloudflare", "groq"] as const;

export interface DirectorTiming {
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

export const DEFAULT_TIMING: DirectorTiming = {
  workMs: [7_000, 12_000],
  nudgeAfterMs: 6_000,
  idleMaxMs: 40_000,
  idleChance: 0.22,
  rateLimitEveryMs: [35_000, 65_000],
  backoffMs: [16_000, 28_000],
  outageEveryMs: [140_000, 240_000],
  outageMs: [14_000, 22_000],
};

export interface DirectorOptions {
  seed?: number;
  /** Simulation start time (ms). */
  start?: number;
  providers?: readonly string[];
  timing?: Partial<DirectorTiming>;
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
  completed: number;
  /** WARDEN only: recently visited patrol anchors. */
  visited: string[];
  rounds: number;
}

type Delivery = "qa" | "bridge" | "ledger";

const DELIVERY_BY_ROOM: Record<string, Delivery> = {
  "factory-1": "qa",
  "factory-2": "qa",
  "factory-3": "qa",
  research: "bridge",
  vault: "ledger",
};

const REVIEWER_ROOM = "qa-bay";
const BUBBLE_MS = 3_200;
const MAX_REWORKS = 2;

export class MockDirector {
  private readonly rng: Rng;
  private readonly timing: DirectorTiming;
  private readonly actors: Actor[] = [];
  private readonly byId = new Map<string, Actor>();
  private readonly tasks = new Map<string, Task>();
  private readonly providers = new Map<string, ProviderState>();
  private readonly reserved = new Map<string, string>();
  /** Task ids waiting on the QA intake table, oldest first. */
  private readonly intake: string[] = [];
  private readonly recoveries: { at: number; provider: string }[] = [];
  private t: number;
  private seq = 0;
  private taskCount = 0;
  private nextRateLimit: number;
  private nextOutage: number;
  private out: StationEvent[] = [];

  constructor(
    private readonly map: StationMap,
    crew: readonly CrewMember[],
    options: DirectorOptions = {},
  ) {
    this.rng = new Rng(options.seed ?? 1);
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.t = options.start ?? 0;
    for (const p of options.providers ?? MOCK_PROVIDERS) {
      this.providers.set(p, { provider: p, state: "ok", until: null, note: null });
    }
    crew.forEach((c) => {
      const home = map.anchor(c.workstations[0] as string);
      const actor: Actor = {
        crew: c,
        state: {
          id: c.id,
          tile: { x: home.x, y: home.y },
          facing: home.facing,
          activity: "idle",
          carrying: null,
          anchor: home.id,
          taskId: null,
          status: null,
          since: this.t,
        },
        plan: [],
        // Stagger the first moves so the crew does not start in lockstep.
        busyUntil: this.t + this.rng.range(200, 3_000),
        moveEnd: this.t,
        held: home.id,
        task: null,
        rework: [],
        nudgedBy: null,
        idleSince: null,
        completed: 0,
        visited: [],
        rounds: 0,
      };
      this.reserved.set(home.id, c.id);
      this.actors.push(actor);
      this.byId.set(c.id, actor);
    });
    this.nextRateLimit = this.t + this.rng.range(...this.timing.rateLimitEveryMs) * 0.5;
    this.nextOutage = this.t + this.rng.range(...this.timing.outageEveryMs);
  }

  get now(): number {
    return this.t;
  }

  /** The full current state, as a server sends it to a client that has just connected. */
  snapshot(): StationEvent {
    return {
      seq: this.seq,
      t: this.t,
      type: "snapshot",
      agents: this.actors.map((a) => ({ ...a.state, tile: { ...a.state.tile } })),
      tasks: [...this.tasks.values()].map((t) => ({ ...t })),
      providers: [...this.providers.values()].map((p) => ({ ...p })),
    };
  }

  /** Runs the simulation up to `target` and returns the events it produced, in time order. */
  advanceTo(target: number): StationEvent[] {
    this.out = [];
    for (let guard = 0; guard < 100_000; guard++) {
      const next = this.nextDue();
      if (!next || next.at > target) break;
      this.t = Math.max(this.t, next.at);
      next.run();
    }
    this.t = Math.max(this.t, target);
    return this.out;
  }

  // -- Scheduling ---------------------------------------------------------------------------

  private nextDue(): { at: number; run: () => void } | null {
    let best: { at: number; run: () => void } | null = null;
    for (const a of this.actors) {
      if (!best || a.busyUntil < best.at) best = { at: a.busyUntil, run: () => this.runActor(a) };
    }
    const recovery = this.recoveries[0];
    if (recovery && (!best || recovery.at < best.at)) {
      best = { at: recovery.at, run: () => this.recover() };
    }
    if (!best || this.nextRateLimit < best.at) {
      best = { at: this.nextRateLimit, run: () => this.rateLimit() };
    }
    if (this.nextOutage < best.at) best = { at: this.nextOutage, run: () => this.outage() };
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
    this.emit({ type: "task.updated", t: this.t, task: { ...task } });
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

  private hold(actor: Actor, anchorId: string | null): void {
    if (actor.held && this.reserved.get(actor.held) === actor.crew.id)
      this.reserved.delete(actor.held);
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

  private occupied(except: Actor): Set<string> {
    const set = new Set<string>();
    for (const a of this.actors) if (a !== except) set.add(`${a.state.tile.x},${a.state.tile.y}`);
    return set;
  }

  /** A random free floor tile in a room that is not an anchor or someone else's spot. */
  private looseSpot(actor: Actor, roomId: string): Tile | undefined {
    const room = this.map.room(roomId);
    const anchors = new Set(this.map.anchors.map((a) => `${a.x},${a.y}`));
    const taken = this.occupied(actor);
    const options: Tile[] = [];
    for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        const key = `${x},${y}`;
        if (this.map.isWalkable(x, y) && !anchors.has(key) && !taken.has(key))
          options.push({ x, y });
      }
    }
    return options.length > 0 ? this.rng.pick(options) : undefined;
  }

  private lines(actor: Actor): RoleLines {
    return ROLE_LINES[actor.crew.id] ?? (ROLE_LINES.ledger as RoleLines);
  }

  // -- Planning -----------------------------------------------------------------------------

  private planFor(actor: Actor): Step[] {
    if (actor.crew.id === OVERSEER_ID) return this.planOverseer(actor);
    if (actor.crew.room === REVIEWER_ROOM) return this.planReviewer(actor);
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
          const station = this.pickStation(actor, i > 0);
          const work: ActFields = { activity: "work", status: current.title, taskId: current.id };
          return [
            this.act({ ...work, carrying: null }),
            ...this.goTo(actor, station, work),
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

  /** Home most of the time; a later session of a task often moves to another station. */
  private pickStation(actor: Actor, later: boolean): Anchor {
    const [homeId, ...others] = actor.crew.workstations as [string, ...string[]];
    const home = this.map.anchor(homeId);
    const here = actor.held;
    if (others.length > 0 && this.rng.chance(later ? 0.5 : 0.2)) {
      const alternatives = [homeId, ...others]
        .filter((id) => id !== here)
        .map((id) => this.map.anchor(id));
      const alt = this.freeAnchor(actor, alternatives);
      if (alt) return alt;
    }
    return here && actor.crew.workstations.includes(here) ? this.map.anchor(here) : home;
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
    };
    this.tasks.set(task.id, task);
    return task;
  }

  private finishTask(actor: Actor): Step[] {
    const task = actor.task;
    if (!task) return [];
    const delivery = DELIVERY_BY_ROOM[actor.crew.room] ?? "qa";
    if (delivery === "qa") return this.deliverToQa(actor, task);
    if (delivery === "bridge") return this.reportToBridge(actor, task);
    // Ledger files most reports in place and takes one in three to the Bridge.
    actor.completed += 1;
    if (actor.completed % 3 === 0) return this.reportToBridge(actor, task);
    this.updateTask(task, "done");
    actor.task = null;
    return [this.wait(800), ...this.maybeIdle(actor)];
  }

  private deliverToQa(actor: Actor, task: Task): Step[] {
    const drops = this.map.anchorsFor("deliver", REVIEWER_ROOM);
    return [
      this.act({ activity: "deliver", carrying: "crate", status: `Taking "${task.title}" to QA` }),
      this.call(() => {
        const drop = this.freeAnchor(actor, drops);
        if (drop) return this.goTo(actor, drop, { activity: "deliver" });
        const spot = this.looseSpot(actor, REVIEWER_ROOM);
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
    const spots = this.map.anchorsFor("report", "bridge");
    return [
      this.act({ activity: "deliver", carrying: "datapad", status: "Report for WARDEN" }),
      this.call(() => {
        const spot = this.freeAnchor(actor, spots);
        if (spot) return this.goTo(actor, spot, { activity: "deliver" });
        const loose = this.looseSpot(actor, "bridge");
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

  /** WARDEN acknowledges a report if it is standing on the Bridge. */
  private thankFromOverseer(): void {
    const warden = this.byId.get(OVERSEER_ID);
    if (!warden || warden.moveEnd > this.t) return;
    if (this.map.roomAt(warden.state.tile.x, warden.state.tile.y)?.id !== "bridge") return;
    this.emit({
      type: "agent.say",
      t: this.t,
      id: warden.crew.id,
      text: this.rng.pick(WARDEN_LINES.reportThanks),
      ttl: BUBBLE_MS,
    });
  }

  private maybeIdle(actor: Actor): Step[] {
    if (!this.rng.chance(this.timing.idleChance)) return [];
    const spot = this.looseSpot(actor, actor.crew.room);
    return [
      this.act({ activity: "idle", status: null, taskId: null, carrying: null, anchor: null }),
      ...(spot ? this.goToTile(actor, spot) : []),
      this.act({ activity: "idle", facing: "down" }),
      // WARDEN's patience counts from arrival at the idle spot.
      this.call(() => {
        actor.idleSince = this.t;
        return undefined;
      }),
      this.wait(this.timing.idleMaxMs),
    ];
  }

  // Lens: review whatever is on the intake table, otherwise run policy checks at the console.
  private planReviewer(actor: Actor): Step[] {
    const taskId = this.intake.shift();
    const task = taskId ? this.tasks.get(taskId) : undefined;
    const consoleAnchor = this.map.anchor(actor.crew.workstations[0] as string);
    if (!task) {
      const steps: Step[] = [];
      steps.push(
        ...this.goTo(actor, consoleAnchor, {
          activity: "work",
          status: "Policy checks",
          taskId: null,
        }),
      );
      if (this.rng.chance(0.5)) steps.push(this.say(this.rng.pick(LENS_LINES.idle)));
      steps.push(this.wait(this.rng.range(4_000, 7_000)));
      return steps;
    }
    const drops = this.map.anchorsFor("deliver", REVIEWER_ROOM);
    const scan = this.map.anchorsFor("review", REVIEWER_ROOM)[0];
    const pickUp = this.call(() => {
      const drop = this.freeAnchor(actor, drops);
      return drop ? this.goTo(actor, drop, { activity: "review" }) : undefined;
    });
    // With a backlog, Lens checks deliverables right at the intake table instead of the scanner.
    if (this.intake.length >= 1 || !scan) {
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
    this.byId.get(task.assignee)?.rework.push(task);
    return [this.say(this.rng.pick(LENS_LINES.fail))];
  }

  // WARDEN: nudge idle crew first; otherwise alternate planning at the holo-table and patrols.
  private planOverseer(actor: Actor): Step[] {
    const idle = this.findIdle(actor);
    if (idle) return this.nudge(actor, idle);
    actor.rounds += 1;
    if (actor.rounds % 4 === 1) {
      const command = this.map.anchor(actor.crew.workstations[0] as string);
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
    const choices = this.map
      .anchorsFor("patrol")
      .filter((a) => !actor.visited.includes(a.id) && this.isFree(a.id, actor));
    const target = choices.length > 0 ? this.rng.pick(choices) : this.map.anchorsFor("patrol")[0];
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
    let pick: Actor | undefined;
    for (const a of this.actors) {
      if (a === overseer || a.nudgedBy || a.idleSince === null) continue;
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
              target.nudgedBy === overseer.crew.id;
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
   * A free tile next to the target (or two steps away), as close to WARDEN as possible. Anchor
   * tiles are avoided so WARDEN never stands on someone's workstation.
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
        a.crew.id !== OVERSEER_ID &&
        // Lens stays at the QA Bay so deliverables do not pile up during a break.
        a.crew.room !== REVIEWER_ROOM &&
        a.state.activity === "work" &&
        a.moveEnd <= this.t &&
        a.busyUntil > this.t &&
        !a.nudgedBy,
    );
    const count = Math.min(working.length, this.rng.int(1, 2));
    for (let i = 0; i < count; i++) {
      const victim = working.splice(this.rng.int(0, working.length - 1), 1)[0];
      if (victim) this.interrupt(victim, this.coffeeBreak(victim, provider, until));
    }
  }

  private coffeeBreak(actor: Actor, provider: string, until: number): Step[] {
    const machines = this.map.anchorsFor("coffee", "cafe");
    const seats = this.map.anchorsFor("rest", "cafe");
    return [
      this.say(this.rng.pick(CREW_REPLIES.coffee)),
      this.act({
        activity: "coffee",
        status: `Waiting out a ${provider} rate limit`,
        carrying: null,
      }),
      this.call(() => {
        const machine = this.freeAnchor(actor, machines);
        if (machine)
          return [...this.goTo(actor, machine, { activity: "coffee" }), this.wait(2_200)];
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
        if (this.rng.chance(0.5)) steps.push(this.say(this.rng.pick(CREW_REPLIES.coffeeChat)));
        steps.push(this.wait(Math.max(3_000, until - this.t + this.rng.range(500, 2_500))));
        return steps;
      }),
      this.act({ activity: "coffee", carrying: null }),
      this.say(this.rng.pick(CREW_REPLIES.coffeeDone)),
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
