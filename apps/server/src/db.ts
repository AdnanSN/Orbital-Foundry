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
