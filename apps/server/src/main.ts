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
import { loadAnalyticsConfig, StudioAnalytics } from "./studio/analytics";
import { StudioBoard } from "./studio/board";
import { EditBay, type VideoDoc } from "./studio/editbay";
import {
  ComfyUIGenerator,
  FalGenerator,
  GpuQueue,
  loadGpuConfig,
  ModalGenerator,
} from "./studio/gpu";
import { AssetLibrary } from "./studio/library";
import { loadMediaConfig, MediaHub, MediaUsage } from "./studio/media";
import { backupSkip, loadStudioConfig, StudioSchedule } from "./studio/schedule";
import { SignalService } from "./studio/signals";
import { SoundKit } from "./studio/sound";
import { generateStill } from "./studio/stills";
import { StockService } from "./studio/stock";
import { VoiceService } from "./studio/voice";
import { WritersRoom } from "./studio/writers";
import { ThumbnailStudio } from "./thumbs/studio";
import { InstagramConnector } from "./uplink/instagram";
import { loadUplinkConfig, UplinkPublisher } from "./uplink/publisher";
import { TikTokConnector } from "./uplink/tiktok";
import { YouTubeConnector } from "./uplink/youtube";
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
  // Finished videos are backed up; the render's working files are not (D-062).
  skip: backupSkip,
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
// Stage 15: the studio's Writers' Room (niche study, ideas, research, scripts at the Desk).
const media = new MediaHub(loadMediaConfig(), new MediaUsage(station.db));
const sayRole = (role: string, text: string) =>
  sim.mutate((s) => {
    const who = s.crew.find((c) => c.role === role);
    if (who) s.sayNow(who.id, text);
  });
const writers = new WritersRoom({
  router: station.router,
  lane,
  web: new WebClient(loadWebConfig()),
  signals: new SignalService({
    hub: media,
    db: station.db,
    log: (m) => console.log(`[signals] ${m}`),
  }),
  store: work,
  db: station.db,
  director,
  dir: path.join(ARTIFACTS_DIR, "studio", "scripts"),
  say: sayRole,
  log: (m) => console.log(`[writers] ${m}`),
});
// Stage 16: the Edit Bay turns approved scripts into finished videos (a test render on request).
const library = new AssetLibrary(station.db, path.join(DATA_DIR, "library"));
// Stage 18: the GPU lane makes AI clips for "ai-video" shots (D-060). Without a ready generator
// the jobs expire at their deadline and those shots use footage or a still instead.
const gpuConfig = loadGpuConfig();
const modalUrl = process.env[gpuConfig.modal.urlEnv];
const gpu = new GpuQueue({
  db: station.db,
  hub: media,
  library,
  store: work,
  generators: [
    new ComfyUIGenerator(gpuConfig.comfyui),
    new ModalGenerator({
      ...(modalUrl ? { url: modalUrl } : {}),
      ...(process.env.MODAL_KEY ? { key: process.env.MODAL_KEY } : {}),
      ...(process.env.MODAL_SECRET ? { secret: process.env.MODAL_SECRET } : {}),
      costPerSecond: gpuConfig.modal.costPerSecond,
      estimateSeconds: gpuConfig.modal.estimateSeconds,
    }),
    new FalGenerator({
      ...(process.env.FAL_KEY ? { key: process.env.FAL_KEY } : {}),
      model: gpuConfig.fal.model,
      costPerClip: gpuConfig.fal.costPerClip,
      enabled:
        media.has("fal-video") && media.setting<boolean>("fal-video", "enabled", false) === true,
    }),
  ],
  config: gpuConfig,
  dir: path.join(ARTIFACTS_DIR, "gpu"),
  busy: () => editbay.busy(),
  onSettled: (scriptId) => editbay.resume(scriptId),
  log: (m) => console.log(`[gpu] ${m}`),
});
const voices = new VoiceService({ hub: media, log: (m) => console.log(`[voice] ${m}`) });
// The Edit Bay's screen on the station follows the cut in progress (Stage 20).
const publishProgress = (v: VideoDoc) =>
  sim.mutate((s) =>
    s.publish({
      type: "studio.progress",
      t: s.now,
      video: {
        id: v.id,
        title: v.title.slice(0, 120),
        format: v.format,
        status: v.status,
        stage: v.stage,
        progress: Math.max(0, Math.min(100, v.progress)),
        test: v.test,
      },
    }),
  );
const editbay = new EditBay({
  writers,
  router: station.router,
  voices,
  stock: new StockService({
    hub: media,
    library,
    db: station.db,
    log: (m) => console.log(`[stock] ${m}`),
  }),
  stills: (prompt, orientation) =>
    generateStill(station.images, library, { prompt, lane, orientation }, blocklist),
  library,
  kit: new SoundKit(library),
  store: work,
  db: station.db,
  director,
  lane,
  dir: path.join(ARTIFACTS_DIR, "studio", "videos"),
  blocklist,
  renderOptions: {
    workers: media.setting("hyperframes", "workers", 3),
    gpu: media.setting("hyperframes", "gpuEncode", true),
    quality: media.setting("hyperframes", "quality", "looks"),
  },
  gpu,
  onProgress: publishProgress,
  say: sayRole,
  log: (m) => console.log(`[editbay] ${m}`),
});
gpu.start();
// The snapshot doesn't carry the cut in progress, so it is repeated for clients that just joined.
const studioPulse = setInterval(() => {
  for (const v of [
    ...editbay.videos(undefined, "producing"),
    ...editbay.videos(undefined, "waiting"),
  ])
    publishProgress(v);
}, 15_000);
// Stage 17: the Uplink posts approved videos (a dry run unless PUBLISH_MODE=live, D-059).
const secretsDir = path.join(DATA_DIR, "secrets");
const youtube = new YouTubeConnector({
  ...(process.env.YOUTUBE_CLIENT_ID ? { clientId: process.env.YOUTUBE_CLIENT_ID } : {}),
  ...(process.env.YOUTUBE_CLIENT_SECRET ? { clientSecret: process.env.YOUTUBE_CLIENT_SECRET } : {}),
  redirectUri: `http://127.0.0.1:${port}/api/uplink/youtube/callback`,
  secretsDir,
  log: (m) => console.log(`[youtube] ${m}`),
});
const instagram = new InstagramConnector({
  ...(process.env.INSTAGRAM_APP_ID ? { appId: process.env.INSTAGRAM_APP_ID } : {}),
  ...(process.env.INSTAGRAM_APP_SECRET ? { appSecret: process.env.INSTAGRAM_APP_SECRET } : {}),
  redirectUri:
    process.env.INSTAGRAM_REDIRECT_URI ||
    "https://adnansn.github.io/Orbital-Foundry/instagram-callback.html",
  stationPort: port,
  secretsDir,
  log: (m) => console.log(`[instagram] ${m}`),
});
const uplink = new UplinkPublisher({
  videos: editbay,
  store: work,
  db: station.db,
  outbox: new Outbox(station.db),
  director,
  youtube,
  instagram,
  tiktok,
  config: loadUplinkConfig(),
  mode: process.env.PUBLISH_MODE === "live" ? "live" : "dry-run",
  lane,
  dir: path.join(DATA_DIR, "uplink"),
  notify: (text) => telegram?.message(text),
  say: sayRole,
  log: (m) => console.log(`[uplink] ${m}`),
});
uplink.start();
// Stage 19: real stats, costs and the studio's weekly retro, which the owner approves (D-061).
const analytics = new StudioAnalytics({
  db: station.db,
  store: work,
  router: station.router,
  lane,
  director,
  videos: editbay,
  posts: uplink,
  writers,
  youtube,
  instagram,
  gpuJobs: (scriptId) => gpu.jobs({ scriptId }),
  config: loadAnalyticsConfig(),
  say: sayRole,
  log: (m) => console.log(`[analytics] ${m}`),
});
writers.setLearning(analytics);
director.standupSource(() => analytics.standupFacts());
analytics.start();
// Stage 20: the always-on studio. The production schedule keeps scripts coming for the cadence
// (each still waits at the Owner's Desk), the clean-up keeps the disk in check, and the Studio
// panel reads one board (D-062).
const schedule = new StudioSchedule({
  store: work,
  writers,
  videos: editbay,
  cadence: (id) => analytics.cadence(id),
  library,
  videosDir: path.join(ARTIFACTS_DIR, "studio", "videos"),
  config: loadStudioConfig(),
  say: sayRole,
  log: (m) => console.log(`[schedule] ${m}`),
});
schedule.start();
const startOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const board = new StudioBoard({
  writers,
  videos: editbay,
  posts: uplink,
  gpu,
  voices,
  hub: media,
  stillsToday: () =>
    library
      .all("image")
      .filter((a) => a.source === "generated" && Date.parse(a.createdAt) >= startOfToday()).length,
  schedule,
  analytics,
  diskPath: DATA_DIR,
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
    youtube,
    instagram,
    uplink,
    faceless: { writers, editbay, gpu, analytics, schedule, board },
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
  `Orbital Foundry station server on http://${host}:${port} (${production ? "PRODUCTION, live lane" : "development, sandbox lane"}; ${sim.restored ? "resumed" : "new station"}, ${snap.type === "snapshot" ? snap.crew.length : 0} crew; Printify: ${publisher.mode}; posting: ${uplink.mode})`,
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
  uplink.stop();
  gpu.stop();
  analytics.stop();
  schedule.stop();
  clearInterval(studioPulse);
  telegram?.stop();
  sim.stop();
  await app.close();
  station.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
