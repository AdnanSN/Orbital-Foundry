// Keeps the station server running: `npm run station` (ROADMAP Stage 11, docs/OPERATIONS.md).
//
// - Starts the server (`npm start`) and restarts it when it exits, waiting longer after each
//   crash in a row (2 s up to 60 s), and resetting once it has run for 10 minutes.
// - Checks /api/health every minute; three failed checks in a row restart the server.
// - Writes everything to data/logs/station-YYYY-MM-DD.log and deletes logs older than
//   ORBITAL_LOG_DAYS (default 14).
//
// It needs no service install: run it in a terminal, from Task Scheduler at log-on, or under pm2.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(root, "data", "logs");
const keepDays = Number(process.env.ORBITAL_LOG_DAYS ?? 14);
const port = Number(process.env.ORBITAL_PORT ?? 8787);
const health = `http://127.0.0.1:${port}/api/health`;
fs.mkdirSync(logDir, { recursive: true });

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let logDay = "";
let logStream = null;
function log(line) {
  const day = today();
  if (day !== logDay) {
    logStream?.end();
    logDay = day;
    logStream = fs.createWriteStream(path.join(logDir, `station-${day}.log`), { flags: "a" });
    rotate();
  }
  const text = `${new Date().toISOString()} ${line}`;
  logStream.write(`${text}\n`);
  process.stdout.write(`${text}\n`);
}

function rotate() {
  const cutoff = Date.now() - keepDays * 86_400_000;
  for (const f of fs.readdirSync(logDir)) {
    if (!/^station-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
    const file = path.join(logDir, f);
    if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}

let child = null;
let stopping = false;
let crashes = 0;
let startedAt = 0;
let failedChecks = 0;

function start() {
  startedAt = Date.now();
  failedChecks = 0;
  log(`[supervisor] starting the station (attempt after ${crashes} crash(es))`);
  child = spawn("npm", ["start"], { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(line);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    if (Date.now() - startedAt > 10 * 60_000) crashes = 0;
    crashes += 1;
    const wait = Math.min(60_000, 2_000 * 2 ** Math.min(5, crashes - 1));
    log(`[supervisor] the station stopped (${code ?? signal}); restarting in ${wait / 1000} s`);
    setTimeout(start, wait);
  });
}

function kill() {
  if (!child) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
}

setInterval(async () => {
  if (!child || Date.now() - startedAt < 90_000) return;
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(10_000) });
    failedChecks = res.ok ? 0 : failedChecks + 1;
  } catch {
    failedChecks += 1;
  }
  if (failedChecks >= 3) {
    log("[supervisor] three health checks failed; restarting the station");
    failedChecks = 0;
    kill();
  }
}, 60_000);

function stop() {
  if (stopping) return;
  stopping = true;
  log("[supervisor] stopping");
  kill();
  setTimeout(() => process.exit(0), 3_000);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

start();
