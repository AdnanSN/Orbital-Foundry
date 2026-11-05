import type { CrewMember, SimSave, StationEvent, Task } from "@orbital/shared";
import type Database from "better-sqlite3";

/**
 * SQLite persistence for the station (ROADMAP §8): the event log (append-only), tasks, the crew
 * roster, and the sim engine's save in `kv`. Writes happen in one transaction per batch, so the
 * log and the save never disagree by more than one save interval.
 */
export class SimStore {
  private readonly insertEvent: Database.Statement;
  private readonly upsertTask: Database.Statement;
  private readonly upsertAgent: Database.Statement;
  private readonly putKv: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertEvent = db.prepare(
      "INSERT OR IGNORE INTO events (seq, t, type, data) VALUES (?, ?, ?, ?)",
    );
    this.upsertTask = db.prepare(
      `INSERT INTO tasks (id, title, room, assignee, status, reworks, created_at, updated_at,
         objective_id, brief, artifact_id, feedback, mock)
       VALUES (@id, @title, @room, @assignee, @status, @reworks, @createdAt, @updatedAt,
         @objectiveId, @brief, @artifactId, @feedback, @mock)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, room = excluded.room,
         assignee = excluded.assignee, status = excluded.status, reworks = excluded.reworks,
         updated_at = excluded.updated_at, objective_id = excluded.objective_id,
         brief = excluded.brief, artifact_id = excluded.artifact_id,
         feedback = excluded.feedback, mock = excluded.mock`,
    );
    this.upsertAgent = db.prepare(
      `INSERT INTO agents (id, data, hired_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
    this.putKv = db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
  }

  loadSave(): SimSave | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'sim.save'").get() as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as SimSave) : null;
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  /** Append events and, optionally, write a new save, atomically. */
  write(events: readonly StationEvent[], save?: SimSave): void {
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      for (const e of events) {
        if (e.type === "snapshot") continue;
        this.insertEvent.run(e.seq, e.t, e.type, JSON.stringify(e));
        if (e.type === "task.updated") this.upsertTask.run(taskRow(e.task));
        if (e.type === "agent.spawned")
          this.upsertAgent.run(e.crew.id, JSON.stringify(e.crew), now, now);
        if (e.type === "crew.updated")
          this.upsertAgent.run(e.crew.id, JSON.stringify(e.crew), now, now);
      }
      if (save) this.putKv.run("sim.save", JSON.stringify(save), now);
    });
    run();
  }

  /** Record the starting roster on first boot. */
  seedCrew(crew: readonly CrewMember[]): void {
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      for (const c of crew) this.upsertAgent.run(c.id, JSON.stringify(c), now, now);
    });
    run();
  }

  crew(): CrewMember[] {
    const rows = this.db.prepare("SELECT data FROM agents ORDER BY hired_at, id").all() as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as CrewMember);
  }

  eventsSince(seq: number, limit = 1_000): StationEvent[] {
    const rows = this.db
      .prepare("SELECT data FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as StationEvent);
  }

  tasks(status?: Task["status"]): Task[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC")
            .all(status)
        : this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 500").all()
    ) as TaskRow[];
    return rows.map(fromTaskRow);
  }

  /** Keep the event log bounded: drop all but the newest `keep` events. */
  prune(keep = 200_000): number {
    const cutoff = this.lastSeq() - keep;
    if (cutoff <= 0) return 0;
    return this.db.prepare("DELETE FROM events WHERE seq <= ?").run(cutoff).changes;
  }
}

interface TaskRow {
  id: string;
  title: string;
  room: string;
  assignee: string;
  status: Task["status"];
  reworks: number;
  created_at: number;
  updated_at: number;
  objective_id: string | null;
  brief: string | null;
  artifact_id: string | null;
  feedback: string | null;
  mock: number;
}

function taskRow(t: Task) {
  return {
    id: t.id,
    title: t.title,
    room: t.room,
    assignee: t.assignee,
    status: t.status,
    reworks: t.reworks,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    objectiveId: t.objectiveId ?? null,
    brief: t.brief ?? null,
    artifactId: t.artifactId ?? null,
    feedback: t.feedback ?? null,
    mock: t.mock ? 1 : 0,
  };
}

function fromTaskRow(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    room: r.room,
    assignee: r.assignee,
    status: r.status,
    reworks: r.reworks,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.mock ? { mock: true } : {}),
    objectiveId: r.objective_id,
    ...(r.brief ? { brief: r.brief } : {}),
    artifactId: r.artifact_id,
    feedback: r.feedback,
  };
}
