import path from "node:path";
import { getStationMap, type Lane } from "@orbital/shared";
import { loadBlocklist, loadCreativeConfig, loadStyles } from "./creative/config";
import { CreativeStudio } from "./creative/studio";
import { creativeTools } from "./creative/tools";
import { loadEnv } from "./env";
import { AssetForge } from "./forge/forge";
import { buildApp } from "./http/app";
import { Achievements } from "./ops/achievements";
import { loadOpsConfig, OpsService } from "./ops/ops";
import { TelegramNotifier } from "./ops/telegram";
import { ARTIFACTS_DIR, DATA_DIR } from "./paths";
import { checkCatalog, loadBusinesses, loadEtsyRules, loadProducts } from "./pod/config";
import { PodFactory } from "./pod/factory";
import { PrintifyClient } from "./printify/client";
import { PodPublisher } from "./printify/publisher";
import { SimServer } from "./sim/simServer";
import { SimStore } from "./sim/store";
import { createStation } from "./station";
import { ThumbnailStudio } from "./thumbs/studio";
import { TikTokConnector } from "./uplink/tiktok";
import { Economy } from "./vault/economy";
import { KpiService, loadVaultConfig } from "./vault/kpis";
import { Ledger, Outbox } from "./vault/ledger";
import { WorkDirector } from "./work/director";
import { loadRoles } from "./work/roles";
import { WorkStore } from "./work/store";
import { BUILTIN_TOOLS, ToolRegistry } from "./work/tools";
import { loadWebConfig, WebClient } from "./work/web";

/**
 * The station server: restores the station from SQLite (or starts fresh), runs the sim clock and
 * the agents' work (Overseer, runtime, reviews), and serves the client over HTTP and WebSocket on
 * http://127.0.0.1:8787.
 */
loadEnv();
const host = process.env.ORBITAL_HOST ?? "127.0.0.1";
const port = Number(process.env.ORBITAL_PORT ?? 8787);
/**
 * ORBITAL_MODE=production (D-046): every model call uses the live lane (providers whose terms allow
 * selling the output), the crew invent no tasks, and simulated sales are off. Anything else is
 * development: the sandbox lane, ambient crew work and the sales simulator.
 */
const production = process.env.ORBITAL_MODE === "production";
const lane: Lane = production ? "live" : "sandbox";

let director: WorkDirector | null = null;
// Reasoning models think before they answer: background work can wait up to 3 minutes a call.
const station = createStation({
  onEvent: (e) => director?.onRouterEvent(e),
  requestTimeoutMs: 180_000,
});
const store = new SimStore(station.db);
store.prune();
// Real provider status drives the racks and café breaks now; the sim invents none.
const sim = new SimServer({
  map: getStationMap(),
  store,
  mockProviders: false,
  banter: true,
  ambientWork: !production,
});
const work = new WorkStore(station.db);
// A daily image allocation spent earlier today stays spent across restarts (until 00:00 UTC).
{
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const spent = station.db
    .prepare(
      "SELECT DISTINCT model FROM llm_calls WHERE kind = 'image' AND ts >= ? AND error LIKE '%daily free allocation%'",
    )
    .all(since.toISOString()) as { model: string }[];
  for (const { model } of spent) station.images.bench(model, since.getTime() + 86_400_000);
  if (spent.length > 0) {
    console.log(`[images] daily allocation spent today: ${spent.map((s) => s.model).join(", ")}`);
  }
}
const styles = loadStyles();
const blocklist = loadBlocklist();
const studio = new CreativeStudio({
  images: station.images,
  router: station.router,
  store: work,
  dir: path.join(ARTIFACTS_DIR, "images"),
  lane,
  config: loadCreativeConfig(),
  styles,
  blocklist,
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
  lane,
  log: (m) => console.log(`[work] ${m}`),
});
const businesses = loadBusinesses();
const products = loadProducts();
const etsyRules = loadEtsyRules();
const catalogErrors = checkCatalog(businesses, products);
if (catalogErrors.length > 0) throw new Error(catalogErrors.join("\n"));
const pod = new PodFactory({
  router: station.router,
  studio,
  store: work,
  world: sim,
  director,
  businesses,
  products,
  rules: etsyRules,
  blocklist,
  dir: path.join(ARTIFACTS_DIR, "packages"),
  lane,
  // Parked for the studio (D-049): the stores' daily listings start only with ORBITAL_AUTOPILOT=1.
  autopilot: process.env.ORBITAL_AUTOPILOT === "1",
  imagesReadyAt: () => station.images.readyAt(lane),
  log: (m) => console.log(`[pod] ${m}`),
});
const interrupted = pod.recover();
if (interrupted > 0) console.log(`[pod] ${interrupted} interrupted listing(s) marked failed`);
const podTimer = setInterval(() => pod.tick(), 5_000);

// Stage 7: publishing through Printify. Dry run unless PRINTIFY_MODE=live (D-033).
const ledger = new Ledger(station.db);
const printify = new PrintifyClient({
  mode: process.env.PRINTIFY_MODE === "live" ? "live" : "dry-run",
  token: process.env.PRINTIFY_API_TOKEN || undefined,
  onCall: (c) => console.log(`[printify] ${c.dryRun ? "dry run" : "sent"}: ${c.method} ${c.path}`),
});
const publisher = new PodPublisher({
  client: printify,
  store: work,
  studio,
  world: sim,
  ledger,
  outbox: new Outbox(station.db),
  businesses,
  products,
  rules: etsyRules,
  lane,
  shopId: process.env.PRINTIFY_SHOP_ID ? Number(process.env.PRINTIFY_SHOP_ID) : null,
  dailyCap: Number(process.env.ORBITAL_PUBLISH_CAP ?? 3),
  storePaused: (id) => pod.settings(id).paused,
  log: (m) => console.log(`[publish] ${m}`),
});
pod.publisher = publisher;
const syncTimer = setInterval(
  () =>
    void publisher
      .syncOrders()
      .then((r) => r.added > 0 && console.log(`[publish] ${r.added} new order line(s)`))
      .catch((err: unknown) => console.log(`[publish] order sync failed: ${String(err)}`)),
  30 * 60_000,
);
// Stage 8: Factory 2, the Thumbnail Studio.
const thumbs = new ThumbnailStudio({
  router: station.router,
  studio,
  store: work,
  world: sim,
  director,
  lane,
  dir: path.join(ARTIFACTS_DIR, "thumbs"),
  log: (m) => console.log(`[thumbs] ${m}`),
});
// Stage 9: Factory 3, the Asset Forge. butler uploads only when installed and configured.
const forge = new AssetForge({
  router: station.router,
  studio,
  store: work,
  world: sim,
  director,
  lane,
  dir: path.join(ARTIFACTS_DIR, "forge"),
  butler:
    process.env.BUTLER_PATH && process.env.ITCH_TARGET
      ? { path: process.env.BUTLER_PATH, target: process.env.ITCH_TARGET }
      : null,
  log: (m) => console.log(`[forge] ${m}`),
});
// Stage 10: the Vault's numbers and the weekly learning loop.
const kpis = new KpiService(station.db, work, ledger, loadVaultConfig());
const economy = new Economy({
  router: station.router,
  store: work,
  world: sim,
  ledger,
  kpis,
  director,
  pod,
  lane,
  simulation: !production,
  log: (m) => console.log(`[vault] ${m}`),
});
pod.experiments = economy;
const economyTimer = setInterval(() => economy.tick(), 60 * 60_000);
// Stage 11: always-on operations. Backups nightly; phone notifications when configured.
const ops = new OpsService(station.db, loadOpsConfig(), {
  ...(process.env.ORBITAL_BACKUP_DIR ? { backupDir: process.env.ORBITAL_BACKUP_DIR } : {}),
  getKv: (k) => work.getKv(k),
  setKv: (k, v) => work.setKv(k, v),
  log: (m) => console.log(`[ops] ${m}`),
});
const achievements = new Achievements(station.db, work, (title) =>
  sim.mutate((s) => {
    const warden = s.crew.find((c) => c.role === "overseer");
    if (warden) s.sayNow(warden.id, `Achievement: ${title}!`);
  }),
);
let telegram: TelegramNotifier | null = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  const notifier = new TelegramNotifier({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    quiet: () => ops.quiet(),
    decide: (id, decision) => director.decide(id, decision),
    pending: () => work.approvals("pending"),
    log: (m) => console.log(`[telegram] ${m}`),
  });
  sim.subscribe((events) => {
    for (const e of events) {
      if (e.type === "approval.updated" && e.approval.status === "pending") {
        void notifier
          .notify(e.approval)
          .catch((err: unknown) => console.log(`[telegram] ${String(err).slice(0, 120)}`));
      }
    }
  });
  void notifier.run();
  telegram = notifier;
  console.log("[telegram] phone notifications on");
}
// Stage 17, built early: the Uplink's TikTok connection (drafts in the owner's inbox, D-051).
const tiktok = new TikTokConnector({
  ...(process.env.TIKTOK_CLIENT_KEY ? { clientKey: process.env.TIKTOK_CLIENT_KEY } : {}),
  ...(process.env.TIKTOK_CLIENT_SECRET ? { clientSecret: process.env.TIKTOK_CLIENT_SECRET } : {}),
  redirectUri:
    process.env.TIKTOK_REDIRECT_URI ||
    "https://adnansn.github.io/Orbital-Foundry/tiktok-callback.html",
  stationPort: port,
  dir: path.join(DATA_DIR, "uplink"),
  secretsDir: path.join(DATA_DIR, "secrets"),
  killed: () => publisher.killed(),
  log: (m) => console.log(`[tiktok] ${m}`),
});
const opsTimer = setInterval(() => {
  void ops.tick().catch((err: unknown) => console.log(`[ops] backup failed: ${String(err)}`));
  void telegram?.morningSummary().catch(() => {});
}, 10 * 60_000);
const achievementTimer = setInterval(() => achievements.check(), 60_000);
const app = await buildApp(
  sim,
  {
    ops,
    achievements,
    telegram: telegram !== null,
    tiktok,
    kpis,
    economy,
    forge,
    director,
    store: work,
    studio,
    pod,
    publisher,
    ledger,
    thumbs,
    lane,
    artifactsDir: ARTIFACTS_DIR,
  },
  process.env.ORBITAL_TOKEN ? { token: process.env.ORBITAL_TOKEN } : {},
);
sim.start();
director.start();
await app.listen({ host, port });
const snap = sim.snapshot();
console.log(
  `Orbital Foundry station server on http://${host}:${port} (${production ? "PRODUCTION, live lane" : "development, sandbox lane"}; ${sim.restored ? "resumed" : "new station"}, ${snap.type === "snapshot" ? snap.crew.length : 0} crew; publishing: ${publisher.mode})`,
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`${signal}: saving the station and shutting down`);
  director?.stop();
  clearInterval(podTimer);
  clearInterval(syncTimer);
  clearInterval(economyTimer);
  clearInterval(opsTimer);
  clearInterval(achievementTimer);
  telegram?.stop();
  sim.stop();
  await app.close();
  station.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
