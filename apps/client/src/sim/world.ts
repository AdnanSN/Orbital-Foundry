import {
  type AgentState,
  type Direction,
  findPath,
  type ProviderState,
  pathDurationMs,
  type StationEvent,
  type StationMap,
  samplePath,
  type Task,
  type Tile,
} from "@orbital/shared";

/**
 * The client's model of the station, built only from station events. Rendering and the React
 * panels read from it; nothing writes to it except `apply`. That keeps the client a pure view of
 * whatever produces the events: the mock director now, the server from Stage 3.
 */

export interface AgentPose {
  /** Tile coordinates; fractional while walking. */
  x: number;
  y: number;
  facing: Direction;
  moving: boolean;
}

export interface LogEntry {
  /** Unique per world, for list keys. */
  id: number;
  t: number;
  text: string;
}

export interface AgentStats {
  tasksDone: number;
  reworks: number;
  breaks: number;
  /** Status lines spoken while working. Stage 4 turns each into a real LLM or tool call. */
  calls: number;
}

export interface AgentView {
  state: AgentState;
  move: { path: Tile[]; t0: number; end: number } | null;
  /** When `state.facing` was last set by an event. */
  facingAt: number;
  bubble: { text: string; at: number; until: number } | null;
  log: LogEntry[];
  stats: AgentStats;
}

const LOG_LIMIT = 14;

export class World {
  readonly agents = new Map<string, AgentView>();
  readonly tasks = new Map<string, Task>();
  readonly providers = new Map<string, ProviderState>();
  /** Bumped on every applied event; React panels re-render when it changes. */
  version = 0;
  /** Sim time of the latest applied event. */
  lastEventAt = 0;

  private lastSeq = -1;
  private logCount = 0;
  private dirty = false;
  private readonly listeners = new Set<() => void>();

  constructor(readonly map: StationMap) {}

  apply(e: StationEvent): void {
    if (e.type === "snapshot") {
      this.reset(e);
    } else {
      // Drop duplicates and anything older than the snapshot (Stage 3 resync after reconnect).
      if (e.seq <= this.lastSeq) return;
      this.lastSeq = e.seq;
      this.applyIncremental(e);
    }
    this.lastEventAt = e.t;
    this.version += 1;
    this.dirty = true;
  }

  /** Notify subscribers once after a batch of events. */
  commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Where an agent is drawn at sim time `now`. */
  pose(id: string, now: number): AgentPose | undefined {
    const v = this.agents.get(id);
    if (!v) return undefined;
    const move = v.move;
    if (move && now < move.end) {
      const s = samplePath(move.path, now - move.t0);
      return { x: s.x, y: s.y, facing: s.facing ?? v.state.facing, moving: !s.done };
    }
    let facing = v.state.facing;
    if (move && v.facingAt < move.end) {
      // Arrived, and no event has said which way to face since the walk began.
      facing = samplePath(move.path, move.end - move.t0).facing ?? facing;
    }
    return { x: v.state.tile.x, y: v.state.tile.y, facing, moving: false };
  }

  /** Deliverables waiting on the QA intake table (in review, not yet picked up by Lens). */
  intakeCount(): number {
    const held = new Set<string>();
    for (const v of this.agents.values()) {
      if (v.state.taskId && v.state.activity === "review") held.add(v.state.taskId);
    }
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === "review" && !held.has(t.id)) n++;
    return n;
  }

  tasksFor(agentId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.assignee === agentId);
  }

  private reset(e: Extract<StationEvent, { type: "snapshot" }>): void {
    this.agents.clear();
    this.tasks.clear();
    this.providers.clear();
    this.lastSeq = e.seq;
    for (const a of e.agents) this.addAgent(a, e.t);
    for (const t of e.tasks) this.tasks.set(t.id, { ...t });
    for (const p of e.providers) this.providers.set(p.provider, { ...p });
  }

  private addAgent(state: AgentState, t: number): void {
    this.agents.set(state.id, {
      state: { ...state, tile: { ...state.tile } },
      move: null,
      facingAt: t,
      bubble: null,
      log: [],
      stats: { tasksDone: 0, reworks: 0, breaks: 0, calls: 0 },
    });
  }

  private applyIncremental(e: Exclude<StationEvent, { type: "snapshot" }>): void {
    switch (e.type) {
      case "agent.spawned":
        this.addAgent(e.agent, e.t);
        return;
      case "agent.moved": {
        const v = this.agents.get(e.id);
        if (!v) return;
        const path = findPath(this.map, e.from, e.to) ?? [e.to];
        v.move = { path, t0: e.t0, end: e.t0 + pathDurationMs(path) };
        v.state.tile = { x: e.to.x, y: e.to.y };
        return;
      }
      case "agent.activity": {
        const v = this.agents.get(e.id);
        if (!v) return;
        const s = v.state;
        if (e.activity !== s.activity) {
          s.since = e.t;
          if (e.activity === "coffee") v.stats.breaks += 1;
        }
        s.activity = e.activity;
        if (e.facing !== undefined) {
          s.facing = e.facing;
          v.facingAt = e.t;
        }
        if (e.carrying !== undefined) s.carrying = e.carrying;
        if (e.anchor !== undefined) s.anchor = e.anchor;
        if (e.taskId !== undefined) s.taskId = e.taskId;
        if (e.status !== undefined && e.status !== s.status) {
          s.status = e.status;
          if (e.status) this.log(v, e.t, e.status);
        }
        return;
      }
      case "agent.say": {
        const v = this.agents.get(e.id);
        if (!v) return;
        v.bubble = { text: e.text, at: e.t, until: e.t + e.ttl };
        if (v.state.activity === "work" || v.state.activity === "review") v.stats.calls += 1;
        this.log(v, e.t, `“${e.text}”`);
        return;
      }
      case "task.updated": {
        const before = this.tasks.get(e.task.id);
        this.tasks.set(e.task.id, { ...e.task });
        const v = this.agents.get(e.task.assignee);
        if (!v || before?.status === e.task.status) return;
        if (e.task.status === "done") v.stats.tasksDone += 1;
        if (e.task.status === "rework") v.stats.reworks += 1;
        this.log(v, e.t, `${e.task.id} ${STATUS_WORDS[e.task.status]}`);
        return;
      }
      case "provider.status":
        this.providers.set(e.status.provider, { ...e.status });
        return;
    }
  }

  private log(v: AgentView, t: number, text: string): void {
    this.logCount += 1;
    v.log.push({ id: this.logCount, t, text });
    if (v.log.length > LOG_LIMIT) v.log.splice(0, v.log.length - LOG_LIMIT);
  }
}

const STATUS_WORDS: Record<Task["status"], string> = {
  assigned: "assigned",
  in_progress: "started",
  review: "sent to QA",
  rework: "sent back for rework",
  awaiting_approval: "waiting for approval",
  done: "done",
  failed: "failed",
};
