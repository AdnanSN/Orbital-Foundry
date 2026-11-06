/**
 * Back up the station now: a consistent copy of the database and new artifact files.
 *
 *   npm run backup
 *
 * Safe while the station runs (SQLite online backup). ORBITAL_BACKUP_DIR picks another folder.
 */
import { openDb } from "../db";
import { loadEnv } from "../env";
import { loadOpsConfig, OpsService } from "../ops/ops";
import { backupSkip } from "../studio/schedule";
import { WorkStore } from "../work/store";

loadEnv();
const db = openDb();
const store = new WorkStore(db);
const ops = new OpsService(db, loadOpsConfig(), {
  ...(process.env.ORBITAL_BACKUP_DIR ? { backupDir: process.env.ORBITAL_BACKUP_DIR } : {}),
  skip: backupSkip,
  getKv: (k) => store.getKv(k),
  setKv: (k, v) => store.setKv(k, v),
});
const r = await ops.backup();
console.log(`Backed up to ${r.database} (${r.copiedFiles} new artifact file(s)).`);
if (r.removed.length > 0) console.log(`Removed old copies: ${r.removed.join(", ")}`);
db.close();
