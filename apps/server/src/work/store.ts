import type { Approval, ArtifactMeta, ArtifactReview, Objective } from "@orbital/shared";
import type Database from "better-sqlite3";

export interface Memory {
  id: number;
  agentId: string;
  scope: "agent" | "station";
  text: string;
  tags: string[];
  embedding: number[] | null;
  createdAt: string;
}

export interface Note {
  taskId: string;
  agentId: string;
  text: string;
  createdAt: string;
}

/**
 * Real work records (Stage 4): objectives, Owner's Desk items, deliverables, long-term memory and
 * per-task notes. Tasks themselves live in the sim's `tasks` table (written from events).
 */
export class WorkStore {
  constructor(private readonly db: Database.Database) {}

  /** Next id for a prefix, e.g. "O" → "O-0007". Counters live in `kv`. */
  nextId(prefix: string): string {
    const key = `counter.${prefix}`;
    const next = this.db.transaction(() => {
      const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      const n = (row ? Number(row.value) : 0) + 1;
      this.db
        .prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, String(n), new Date().toISOString());
      return n;
    })();
    return `${prefix}-${String(next).padStart(4, "0")}`;
  }

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  // -- Objectives ----------------------------------------------------------------------------

  saveObjective(o: Objective): void {
    this.db
      .prepare(
        `INSERT INTO objectives (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(o.id, o.status, JSON.stringify(o), o.createdAt, o.updatedAt);
  }

  objective(id: string): Objective | null {
    const row = this.db.prepare("SELECT data FROM objectives WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Objective) : null;
  }

  objectives(limit = 50): Objective[] {
    const rows = this.db
      .prepare("SELECT data FROM objectives ORDER BY created_at DESC LIMIT ?")
      .all(limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Objective);
  }

  openObjectives(): Objective[] {
    const rows = this.db
      .prepare(
        "SELECT data FROM objectives WHERE status IN ('planning', 'active', 'awaiting_owner') ORDER BY created_at",
      )
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Objective);
  }

  // -- Owner's Desk --------------------------------------------------------------------------

  saveApproval(a: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, kind, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(a.id, a.kind, a.status, JSON.stringify(a), a.createdAt, a.decidedAt ?? a.createdAt);
  }

  approval(id: string): Approval | null {
    const row = this.db.prepare("SELECT data FROM approvals WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Approval) : null;
  }

  approvals(status?: Approval["status"], limit = 100): Approval[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT data FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?")
            .all(status, limit)
        : this.db.prepare("SELECT data FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Approval);
  }

  // -- Deliverables --------------------------------------------------------------------------

  saveArtifact(meta: ArtifactMeta, content: string | null, filePath: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, kind, title, mime, task_id, objective_id, created_by,
           created_at, size, content, path, room, review, parent_id, info)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.id,
        meta.kind,
        meta.title,
        meta.mime,
        meta.taskId,
        meta.objectiveId,
        meta.createdBy,
        meta.createdAt,
        meta.size,
        content,
        filePath,
        meta.room ?? null,
        meta.review ?? null,
        meta.parentId ?? null,
        meta.info ? JSON.stringify(meta.info) : null,
      );
  }

  /** Change an artifact's gallery review or merge new details into its info. */
  updateArtifact(
    id: string,
    patch: { review?: ArtifactReview | null; info?: Record<string, unknown>; title?: string },
  ): ArtifactMeta | null {
    const current = this.artifact(id);
    if (!current) return null;
    const meta: ArtifactMeta = {
      ...current.meta,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.review !== undefined ? { review: patch.review } : {}),
      ...(patch.info ? { info: { ...(current.meta.info ?? {}), ...patch.info } } : {}),
    };
    this.db
      .prepare("UPDATE artifacts SET title = ?, review = ?, info = ? WHERE id = ?")
      .run(meta.title, meta.review ?? null, meta.info ? JSON.stringify(meta.info) : null, id);
    return meta;
  }

  /** Artifacts, newest first, optionally only one kind or one room's. */
  findArtifacts(filter: { kind?: string; room?: string; limit?: number } = {}): ArtifactMeta[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.kind) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.room) {
      where.push("room = ?");
      args.push(filter.room);
    }
    const sql = `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, filter.limit ?? 60) as ArtifactRow[];
    return rows.map(artifactMeta);
  }

  artifact(id: string): { meta: ArtifactMeta; content: string | null; path: string | null } | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | ArtifactRow
      | undefined;
    return row ? { meta: artifactMeta(row), content: row.content, path: row.path } : null;
  }

  artifacts(limit = 50): ArtifactMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?")
      .all(limit) as ArtifactRow[];
    return rows.map(artifactMeta);
  }

  // -- Memory --------------------------------------------------------------------------------

  saveMemory(m: Omit<Memory, "id" | "createdAt">): number {
    const res = this.db
      .prepare(
        "INSERT INTO memories (agent_id, scope, text, tags, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        m.agentId,
        m.scope,
        m.text,
        JSON.stringify(m.tags),
        m.embedding ? JSON.stringify(m.embedding) : null,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  /** Memories visible to an agent: its own plus station-wide ones, newest first. */
  memories(agentId: string, limit = 500): Memory[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE agent_id = ? OR scope = 'station' ORDER BY id DESC LIMIT ?",
      )
      .all(agentId, limit) as MemoryRow[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      scope: r.scope,
      text: r.text,
      tags: JSON.parse(r.tags) as string[],
      embedding: r.embedding ? (JSON.parse(r.embedding) as number[]) : null,
      createdAt: r.created_at,
    }));
  }

  // -- Notes ---------------------------------------------------------------------------------

  addNote(taskId: string, agentId: string, text: string): void {
    this.db
      .prepare("INSERT INTO notes (task_id, agent_id, text, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, agentId, text, new Date().toISOString());
  }

  notes(taskId: string): Note[] {
    const rows = this.db
      .prepare("SELECT * FROM notes WHERE task_id = ? ORDER BY id")
      .all(taskId) as { task_id: string; agent_id: string; text: string; created_at: string }[];
    return rows.map((r) => ({
      taskId: r.task_id,
      agentId: r.agent_id,
      text: r.text,
      createdAt: r.created_at,
    }));
  }
}

interface ArtifactRow {
  id: string;
  kind: string;
  title: string;
  mime: string;
  task_id: string | null;
  objective_id: string | null;
  created_by: string;
  created_at: number;
  size: number;
  content: string | null;
  path: string | null;
  room: string | null;
  review: string | null;
  parent_id: string | null;
  info: string | null;
}

interface MemoryRow {
  id: number;
  agent_id: string;
  scope: "agent" | "station";
  text: string;
  tags: string;
  embedding: string | null;
  created_at: string;
}

function artifactMeta(r: ArtifactRow): ArtifactMeta {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    mime: r.mime,
    taskId: r.task_id,
    objectiveId: r.objective_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    size: r.size,
    ...(r.room ? { room: r.room } : {}),
    ...(r.review ? { review: r.review as ArtifactReview } : {}),
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
    ...(r.info ? { info: JSON.parse(r.info) as Record<string, unknown> } : {}),
  };
}
