import { type Capability, type Lane, TIERS, type Tier, type TiersFile } from "@orbital/shared";
import type { ResolvedProvider } from "../src/config";
import { createGates, type ProviderGate } from "../src/llm/rateLimiter";
import { ModelRouter, type RouterDeps } from "../src/llm/router";
import type {
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  Transport,
} from "../src/llm/transport";
import { MemoryUsageLog } from "../src/llm/usage";

export function provider(
  id: string,
  lanes: Lane[],
  overrides: Partial<ResolvedProvider> = {},
): ResolvedProvider {
  return {
    id,
    name: id,
    baseURL: `https://${id}.test/v1`,
    resolvedBaseURL: `https://${id}.test/v1`,
    apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
    apiKey: "test-key",
    missingEnv: [],
    lanes,
    limits: { rpm: 1000, concurrency: 8 },
    publicModelList: false,
    production: "unverified",
    ...overrides,
  };
}

const DEFAULT_REQUIRES: Record<Tier, Capability[]> = {
  reasoning: ["chat", "json", "tools"],
  creative: ["chat", "json"],
  fast: ["chat", "json"],
  vision: ["chat", "vision"],
  embed: ["embed"],
};

export function tiersWith(
  lists: Partial<Record<Tier, { sandbox?: string[]; live?: string[] }>>,
): TiersFile {
  const tiers = {} as TiersFile["tiers"];
  for (const tier of TIERS) {
    tiers[tier] = {
      requires: DEFAULT_REQUIRES[tier],
      sandbox: lists[tier]?.sandbox ?? [],
      live: lists[tier]?.live ?? [],
    };
  }
  return { tiers };
}

type Handler = (req: ChatRequest, callNumber: number) => ChatResult | Promise<ChatResult>;

/** Scripted transport: one handler per "provider:model"; records every call. */
export class FakeTransport implements Transport {
  readonly calls: { provider: string; req: ChatRequest }[] = [];
  private readonly counts = new Map<string, number>();

  constructor(private readonly handlers: Record<string, Handler> = {}) {}

  async chat(provider: string, req: ChatRequest): Promise<ChatResult> {
    const key = `${provider}:${req.model}`;
    const callNumber = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, callNumber);
    this.calls.push({ provider, req });
    const handler = this.handlers[key];
    if (!handler) throw new Error(`FakeTransport has no handler for ${key}`);
    return handler(req, callNumber);
  }

  async embed(provider: string, req: EmbedRequest): Promise<EmbedResult> {
    this.calls.push({ provider, req: { model: req.model, messages: [] } });
    return { vectors: req.input.map(() => [0.1, 0.2, 0.3]) };
  }

  callsTo(ref: string): number {
    return this.calls.filter((c) => `${c.provider}:${c.req.model}` === ref).length;
  }
}

export function reply(content: string, extra: Partial<ChatResult> = {}): ChatResult {
  return { content, toolCalls: [], ...extra };
}

export interface RouterFixture {
  router: ModelRouter;
  usage: MemoryUsageLog;
  gates: Map<string, ProviderGate>;
}

export function makeRouter(
  deps: Pick<RouterDeps, "providers" | "tiers" | "transport"> & Partial<RouterDeps>,
): RouterFixture {
  const usage = new MemoryUsageLog();
  const gates = deps.gates ?? createGates(deps.providers);
  const router = new ModelRouter({ census: null, usage, ...deps, gates });
  return { router, usage, gates };
}
