import { getStationMap } from "@orbital/shared";
import { openDb } from "./db";
import { loadEnv } from "./env";
import { buildApp } from "./http/app";
import { SimServer } from "./sim/simServer";
import { SimStore } from "./sim/store";

/**
 * The station server: restores the station from SQLite (or starts fresh), runs the sim clock,
 * and serves the client over HTTP and WebSocket on http://127.0.0.1:8787.
 */
loadEnv();
const host = process.env.ORBITAL_HOST ?? "127.0.0.1";
const port = Number(process.env.ORBITAL_PORT ?? 8787);

const db = openDb();
const store = new SimStore(db);
store.prune();
const sim = new SimServer({ map: getStationMap(), store });
const app = await buildApp(sim);
sim.start();
await app.listen({ host, port });
const crew = sim.snapshot();
console.log(
  `Orbital Foundry station server on http://${host}:${port} (${sim.restored ? "resumed" : "new station"}, ${crew.type === "snapshot" ? crew.crew.length : 0} crew)`,
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`${signal}: saving the station and shutting down`);
  sim.stop();
  await app.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
