import type Database from "better-sqlite3";
import { loadStationConfig, type StationConfig } from "./config";
import { openDb } from "./db";
import { loadEnv } from "./env";
import { ImageService } from "./images/imageService";
import { CircuitBreaker } from "./llm/circuitBreaker";
import { createGates, type ProviderGate } from "./llm/rateLimiter";
import { ModelRouter, type RouterEvent } from "./llm/router";
import { OpenAICompatibleTransport, type Transport } from "./llm/transport";
import { SqliteUsageLog, type UsageLog } from "./llm/usage";

export interface Station {
  config: StationConfig;
  router: ModelRouter;
  images: ImageService;
  transport: Transport;
  gates: Map<string, ProviderGate>;
  usage: UsageLog;
  db: Database.Database;
  close(): void;
}

export interface StationOptions {
  dbFile?: string;
  onEvent?: (event: RouterEvent) => void;
}

/** Wire config, database, rate gates, transport, router and image service together. */
export function createStation(options: StationOptions = {}): Station {
  loadEnv();
  const config = loadStationConfig();
  const db = openDb(options.dbFile);
  const usage = new SqliteUsageLog(db);
  const gates = createGates(config.providers, (provider) => usage.countToday(provider));
  const transport = new OpenAICompatibleTransport(config.providers);
  const router = new ModelRouter({
    providers: config.providers,
    tiers: config.tiers,
    census: config.census,
    transport,
    gates,
    breaker: new CircuitBreaker(),
    usage,
    onEvent: options.onEvent,
  });
  const images = new ImageService({
    providers: config.providers,
    endpoints: config.images,
    gates,
    usage,
  });
  return { config, router, images, transport, gates, usage, db, close: () => db.close() };
}
