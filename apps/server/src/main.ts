import path from "node:path";
import { getStationMap } from "@orbital/shared";
import { loadBlocklist, loadCreativeConfig, loadStyles } from "./creative/config";
import { CreativeStudio } from "./creative/studio";
import { creativeTools } from "./creative/tools";
import { loadEnv } from "./env";
import { buildApp } from "./http/app";
import { ARTIFACTS_DIR } from "./paths";
import { SimServer } from "./sim/simServer";
import { SimStore } from "./sim/store";
import { createStation } from "./station";
import { WorkDirector } from "./work/director";
import { loadRoles } from "./work/roles";
import { WorkStore } from "./work/store";
import { BUILTIN_TOOLS, ToolRegistry } from "./work/tools";
import { loadWebConfig, WebClient } from "./work/web";

/**
 * The station server: restores the station from SQLite (or starts fresh), runs the sim clock and
 * the agents' work (Overseer, runtime, reviews), and serves the client over HTTP and WebSocket on
 * http://127.0.0.1:8787. All model calls use the sandbox lane.
 */
loadEnv();
const host = process.env.ORBITAL_HOST ?? "127.0.0.1";
const port = Number(process.env.ORBITAL_PORT ?? 8787);

let director: WorkDirector | null = null;
const station = createStation({ onEvent: (e) => director?.onRouterEvent(e) });
const store = new SimStore(station.db);
store.prune();
// Real provider status drives the racks and café breaks now; the sim invents none.
const sim = new SimServer({ map: getStationMap(), store, mockProviders: false });
const work = new WorkStore(station.db);
const styles = loadStyles();
const studio = new CreativeStudio({
  images: station.images,
  router: station.router,
  store: work,
  dir: path.join(ARTIFACTS_DIR, "images"),
  lane: "sandbox",
  config: loadCreativeConfig(),
  styles,
  blocklist: loadBlocklist(),
  now: () => sim.sim.now,
  onArtifact: (artifact, change) =>
    sim.mutate((s) =>
      change === "created"
        ? s.publish({ type: "artifact.created", t: s.now, artifact })
        : s.publish({ type: "artifact.updated", t: s.now, artifact }),
    ),
  say: (room, text) => {
    const crew = sim.sim.crew.filter((c) => c.role !== "overseer" && c.role !== "reviewer");
    const who = crew.find((c) => c.room === room) ?? crew.find((c) => c.role === "thumbnailer");
    if (who) sim.mutate((s) => s.sayNow(who.id, text));
  },
});
director = new WorkDirector({
  router: station.router,
  store: work,
  world: sim,
  roles: loadRoles(),
  tools: new ToolRegistry([...BUILTIN_TOOLS, ...creativeTools(Object.keys(styles))]),
  studio,
  web: new WebClient(loadWebConfig()),
  gates: station.gates,
  log: (m) => console.log(`[work] ${m}`),
});
const app = await buildApp(sim, { director, store: work, studio });
sim.start();
director.start();
await app.listen({ host, port });
const snap = sim.snapshot();
console.log(
  `Orbital Foundry station server on http://${host}:${port} (${sim.restored ? "resumed" : "new station"}, ${snap.type === "snapshot" ? snap.crew.length : 0} crew)`,
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`${signal}: saving the station and shutting down`);
  director?.stop();
  sim.stop();
  await app.close();
  station.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
