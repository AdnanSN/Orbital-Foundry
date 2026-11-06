import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "./paths";

/** Ordered schema migrations. Append new ones; never edit an applied migration. */
const MIGRATIONS: string[] = [
  `CREATE TABLE llm_calls (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     lane TEXT NOT NULL,
     tier TEXT,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     kind TEXT NOT NULL,
     ok INTEGER NOT NULL,
     outcome TEXT NOT NULL,
     latency_ms INTEGER,
     input_tokens INTEGER,
     output_tokens INTEGER,
     purpose TEXT,
     error TEXT
   );
   CREATE INDEX idx_llm_calls_provider_ts ON llm_calls (provider, ts);`,
  // Stage 3: the station's world state. Times in these tables are sim milliseconds.
  `CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     hired_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     room TEXT NOT NULL,
     assignee TEXT NOT NULL,
     status TEXT NOT NULL,
     reworks INTEGER NOT NULL,
     created_at REAL NOT NULL,
     updated_at REAL NOT NULL
   );
   CREATE INDEX idx_tasks_status ON tasks (status);
   CREATE TABLE events (
     seq INTEGER PRIMARY KEY,
     t REAL NOT NULL,
     type TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE TABLE kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // Stage 4: real work. Objectives, Owner's Desk items, deliverables, memory and task notes.
  `ALTER TABLE tasks ADD COLUMN objective_id TEXT;
   ALTER TABLE tasks ADD COLUMN brief TEXT;
   ALTER TABLE tasks ADD COLUMN artifact_id TEXT;
   ALTER TABLE tasks ADD COLUMN feedback TEXT;
   ALTER TABLE tasks ADD COLUMN mock INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE objectives (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at REAL NOT NULL,
     updated_at REAL NOT NULL
   );
   CREATE TABLE approvals (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at REAL NOT NULL,
     updated_at REAL NOT NULL
   );
   CREATE INDEX idx_approvals_status ON approvals (status);
   CREATE TABLE artifacts (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     mime TEXT NOT NULL,
     task_id TEXT,
     objective_id TEXT,
     created_by TEXT NOT NULL,
     created_at REAL NOT NULL,
     size INTEGER NOT NULL,
     content TEXT,
     path TEXT
   );
   CREATE TABLE memories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     text TEXT NOT NULL,
     tags TEXT NOT NULL,
     embedding TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX idx_notes_task ON notes (task_id);`,
  // Stage 5: images in the artifact store, with a gallery per room.
  `ALTER TABLE artifacts ADD COLUMN room TEXT;
   ALTER TABLE artifacts ADD COLUMN review TEXT;
   ALTER TABLE artifacts ADD COLUMN parent_id TEXT;
   ALTER TABLE artifacts ADD COLUMN info TEXT;
   CREATE INDEX idx_artifacts_kind ON artifacts (kind, created_at);`,
  // Stage 7: idempotent external writes, and the Vault ledger (money in and out per business).
  `CREATE TABLE outbox (
     key TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     result TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     business TEXT NOT NULL,
     source TEXT NOT NULL,
     kind TEXT NOT NULL,
     amount REAL NOT NULL,
     currency TEXT NOT NULL DEFAULT 'USD',
     ref TEXT NOT NULL,
     note TEXT,
     simulated INTEGER NOT NULL DEFAULT 0,
     UNIQUE (source, ref, kind)
   );
   CREATE INDEX idx_ledger_business ON ledger (business, at);`,
  // Stage 10: ambient tasks from before the mock flag existed (ids T-…) are not real work.
  "UPDATE tasks SET mock = 1 WHERE id LIKE 'T-%' AND mock = 0;",
  // Gateways (FreeLLMAPI) report which upstream answered; keep it for the terms audit.
  "ALTER TABLE llm_calls ADD COLUMN routed_via TEXT;",
  // Stage 13: the studio's media calls (voice, stock, render), beside llm_calls (D-050).
  `CREATE TABLE media_calls (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     provider TEXT NOT NULL,
     kind TEXT NOT NULL,
     lane TEXT NOT NULL,
     units REAL NOT NULL DEFAULT 0,
     unit TEXT,
     ms INTEGER,
     ok INTEGER NOT NULL,
     error TEXT,
     ref TEXT
   );
   CREATE INDEX idx_media_calls ON media_calls (provider, ts);`,
  // Stage 14: the clip library (every asset with its licence and credit) and a 24-hour cache of
  // stock searches (Pixabay's terms ask for one).
  `CREATE TABLE assets (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     source TEXT NOT NULL,
     source_id TEXT,
     title TEXT,
     tags TEXT NOT NULL DEFAULT '',
     licence TEXT NOT NULL,
     credit TEXT NOT NULL DEFAULT '',
     url TEXT,
     path TEXT NOT NULL,
     bytes INTEGER,
     duration REAL,
     width INTEGER,
     height INTEGER,
     uses INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     last_used_at TEXT
   );
   CREATE INDEX idx_assets_kind ON assets (kind, source);
   CREATE TABLE media_cache (
     key TEXT PRIMARY KEY,
     body TEXT NOT NULL,
     fetched_at TEXT NOT NULL
   );`,
  // Stage 15: the Writers' Room's idea backlog and scripts (JSON documents, a few indexed fields).
  `CREATE TABLE ideas (
     id TEXT PRIMARY KEY,
     channel TEXT NOT NULL,
     title TEXT NOT NULL,
     score REAL NOT NULL DEFAULT 0,
     status TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX idx_ideas_channel ON ideas (channel, status, score);
   CREATE TABLE scripts (
     id TEXT PRIMARY KEY,
     channel TEXT NOT NULL,
     format TEXT NOT NULL,
     status TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_scripts_channel ON scripts (channel, status, created_at);`,
  // Stage 16: the Edit Bay's videos (one row per cut, long-form and its shorts).
  `CREATE TABLE videos (
     id TEXT PRIMARY KEY,
     script_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     format TEXT NOT NULL,
     status TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_videos_channel ON videos (channel, status, created_at);`,
  // Stage 17: the Uplink's posts, one per video and platform (D-059).
  `CREATE TABLE posts (
     id TEXT PRIMARY KEY,
     video_id TEXT NOT NULL,
     platform TEXT NOT NULL,
     status TEXT NOT NULL,
     at TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_posts_video ON posts (video_id, platform);
   CREATE INDEX idx_posts_status ON posts (status, at);`,
  // Stage 18: the GPU lane's AI clip jobs (D-060).
  `CREATE TABLE gpu_jobs (
     id TEXT PRIMARY KEY,
     script_id TEXT NOT NULL,
     status TEXT NOT NULL,
     deadline TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_gpu_jobs_script ON gpu_jobs (script_id);
   CREATE INDEX idx_gpu_jobs_status ON gpu_jobs (status, deadline);`,
  // Stage 19: daily stats per post, lifetime totals as of that day (D-061).
  `CREATE TABLE video_stats (
     post_id TEXT NOT NULL,
     video_id TEXT NOT NULL,
     platform TEXT NOT NULL,
     day TEXT NOT NULL,
     data TEXT NOT NULL,
     fetched_at TEXT NOT NULL,
     PRIMARY KEY (post_id, day)
   );
   CREATE INDEX idx_video_stats_video ON video_stats (video_id, day);`,
];

export function openDb(file: string = DB_PATH): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[];
  const applied = new Set(rows.map((row) => row.version));
  const apply = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      version,
      new Date().toISOString(),
    );
  });
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (!applied.has(version)) apply(version, sql);
  });
}
