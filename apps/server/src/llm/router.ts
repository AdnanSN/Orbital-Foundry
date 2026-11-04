import {
  type Capability,
  type CensusFile,
  type Lane,
  parseModelRef,
  type Tier,
  type TiersFile,
} from "@orbital/shared";
import type { z } from "zod";
import type { ResolvedProviders } from "../config";
import { CircuitBreaker } from "./circuitBreaker";
import {
  type Attempt,
  classifyError,
  type FailureInfo,
  NoCandidateError,
  RouterError,
  truncate,
} from "./errors";
import { jsonInstruction, parseStructured } from "./json";
import type { ProviderGate } from "./rateLimiter";
import type { ChatMessage, ChatResult, ToolCall, ToolSpec, Transport } from "./transport";
import type { UsageLog } from "./usage";

const REPAIR_ROUNDS = 1;
const DEFAULT_COOLDOWN_MS = 20_000;
const FALLBACK_AFTER_MS = 8_000;
const UNAVAILABLE_TRIP_MS = 60 * 60_000;

export interface GenerateOptions<T = unknown> {
  tier: Tier;
  lane: Lane;
  /** System prompt: persona and rules. */
  system?: string;
  /** A single user turn. Use `messages` for a full conversation (or both). */
  prompt?: string;
  messages?: ChatMessage[];
  /** The reply must be JSON matching this schema. One repair round is attempted per model. */
  schema?: z.ZodType<T>;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Label for the usage log, e.g. "agent:scout". */
  purpose?: string;
  signal?: AbortSignal;
}

export interface GenerateResult<T = unknown> {
  text: string;
  /** Parsed and validated JSON when `schema` was given. */
  data: T | undefined;
  toolCalls: ToolCall[];
  finishReason?: string;
  ref: string;
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Every model tried, in order, including the one that succeeded. */
  attempts: Attempt[];
}

export interface EmbedOptions {
  lane: Lane;
  input: string[];
  inputType?: "query" | "passage";
  purpose?: string;
  signal?: AbortSignal;
}

export interface EmbedOutput {
  vectors: number[][];
  ref: string;
  latencyMs: number;
  attempts: Attempt[];
}

export interface CandidatePlan {
  refs: string[];
  skipped: string[];
  required: Capability[];
}

export type RouterEvent =
  | { type: "attempt"; ref: string; tier: Tier; lane: Lane }
  | { type: "success"; ref: string; tier: Tier; lane: Lane; ms: number }
  | { type: "failure"; ref: string; tier: Tier; lane: Lane; outcome: string; message: string };

export interface RouterDeps {
  providers: ResolvedProviders;
  tiers: TiersFile;
  census: CensusFile | null;
  transport: Transport;
  gates: Map<string, ProviderGate>;
  breaker?: CircuitBreaker;
  usage?: UsageLog;
  onEvent?: (event: RouterEvent) => void;
  /** Cooldown after a 429 that has no Retry-After header. */
  defaultCooldownMs?: number;
  /** Skip a busy provider when another candidate could start this much sooner. */
  fallbackAfterMs?: number;
}

interface ChatCall {
  result: ChatResult;
  ms: number;
}

/**
 * Picks a model for each request: tier → candidate list for the lane → first usable model.
 * Enforces lanes, rate limits and census results; falls back on errors; repairs invalid JSON once.
 */
export class ModelRouter {
  private readonly breaker: CircuitBreaker;
  /** Providers switched off for this process, with the reason (e.g. a rejected API key). */
  private readonly disabled = new Map<string, string>();

  constructor(private readonly deps: RouterDeps) {
    this.breaker = deps.breaker ?? new CircuitBreaker();
  }

  /** Candidate refs for a tier and lane in priority order, and why the others were skipped. */
  plan(tier: Tier, lane: Lane, extra: readonly Capability[] = []): CandidatePlan {
    const config = this.deps.tiers.tiers[tier];
    const required = [...new Set<Capability>([...config.requires, ...extra])];
    const refs: string[] = [];
    const skipped: string[] = [];
    for (const ref of config[lane]) {
      const reason = this.unavailable(ref, lane, required);
      if (reason) skipped.push(`${ref}: ${reason}`);
      else refs.push(ref);
    }
    return { refs, skipped, required };
  }

  async generate<T = unknown>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> {
    const extra: Capability[] = [];
    if (opts.schema) extra.push("json");
    if (opts.tools?.length) extra.push("tools");
    if (hasImages(opts.messages)) extra.push("vision");
    const what = `tier "${opts.tier}"`;
    const { refs, skipped } = this.plan(opts.tier, opts.lane, extra);
    if (refs.length === 0) throw new NoCandidateError(what, opts.lane, skipped);

    const attempts: Attempt[] = [];
    for (const [index, ref] of refs.entries()) {
      if (this.breaker.isOpen(ref)) {
        attempts.push({ ref, outcome: "circuit-open" });
        continue;
      }
      const { provider, model } = parseModelRef(ref);
      const off = this.disabled.get(provider);
      if (off) {
        attempts.push({ ref, outcome: "auth", message: off });
        continue;
      }
      if (this.shouldDefer(ref, refs.slice(index + 1))) {
        attempts.push({ ref, outcome: "busy", message: "long queue; trying a less busy provider" });
        continue;
      }
      let messages = buildMessages(opts);
      let maxTokens = opts.maxTokens;
      let boosted = false;
      let repairs = 0;
      // At most: the first call, one retry with a bigger token budget, and the JSON repair rounds.
      for (let step = 0; step < 2 + REPAIR_ROUNDS; step++) {
        const call = await this.callChat(
          ref,
          provider,
          model,
          messages,
          { ...opts, maxTokens },
          attempts,
        );
        if (!call) break;
        const { result } = call;
        if (result.finishReason === "length" && !boosted) {
          // Reasoning models can spend the whole budget thinking. Retry once with more room.
          boosted = true;
          maxTokens = boostTokens(maxTokens);
          attempts.push({
            ref,
            outcome: "truncated",
            message: `hit the token limit; retrying with ${maxTokens}`,
          });
          continue;
        }
        if (!opts.schema) {
          if (!result.content && result.toolCalls.length === 0) {
            this.invalid(ref, opts, attempts, "empty reply");
            break;
          }
          return this.finish(ref, provider, model, call, undefined, attempts, opts);
        }
        const parsed = parseStructured(result.content, opts.schema);
        if (parsed.ok) return this.finish(ref, provider, model, call, parsed.data, attempts, opts);
        this.invalid(ref, opts, attempts, parsed.error);
        if (repairs >= REPAIR_ROUNDS) break;
        repairs++;
        messages = [
          ...messages,
          { role: "assistant", content: result.content },
          {
            role: "user",
            content: `That reply did not match the required JSON schema:\n${parsed.error}\nReply again with ONLY the corrected JSON.`,
          },
        ];
      }
    }
    throw new RouterError(what, opts.lane, attempts);
  }

  async embed(opts: EmbedOptions): Promise<EmbedOutput> {
    const what = 'tier "embed"';
    const { refs, skipped } = this.plan("embed", opts.lane);
    if (refs.length === 0) throw new NoCandidateError(what, opts.lane, skipped);

    const attempts: Attempt[] = [];
    for (const ref of refs) {
      if (this.breaker.isOpen(ref)) {
        attempts.push({ ref, outcome: "circuit-open" });
        continue;
      }
      const { provider, model } = parseModelRef(ref);
      const gate = this.deps.gates.get(provider);
      if (!gate || this.disabled.has(provider)) continue;
      let release: (() => void) | undefined;
      try {
        release = await gate.acquire();
      } catch (err) {
        const info = classifyError(err);
        attempts.push({ ref, outcome: info.kind, message: info.message });
        continue;
      }
      const started = performance.now();
      try {
        const res = await this.deps.transport.embed(
          provider,
          { model, input: opts.input, inputType: opts.inputType },
          opts.signal,
        );
        const ms = Math.round(performance.now() - started);
        this.breaker.recordSuccess(ref);
        this.deps.usage?.record({
          lane: opts.lane,
          tier: "embed",
          provider,
          model,
          kind: "embed",
          outcome: "ok",
          latencyMs: ms,
          inputTokens: res.inputTokens,
          purpose: opts.purpose,
        });
        attempts.push({ ref, outcome: "ok", ms });
        return { vectors: res.vectors, ref, latencyMs: ms, attempts };
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        if (opts.signal?.aborted) throw err;
        const info = classifyError(err);
        this.penalize(ref, provider, info, gate);
        attempts.push({ ref, outcome: info.kind, message: truncate(info.message), ms });
        this.deps.usage?.record({
          lane: opts.lane,
          tier: "embed",
          provider,
          model,
          kind: "embed",
          outcome: info.kind,
          latencyMs: ms,
          purpose: opts.purpose,
          error: info.message,
        });
      } finally {
        release?.();
      }
    }
    throw new RouterError(what, opts.lane, attempts);
  }

  private unavailable(
    ref: string,
    lane: Lane,
    required: readonly Capability[],
  ): string | undefined {
    const { provider } = parseModelRef(ref);
    const p = this.deps.providers[provider];
    if (!p) return "unknown provider";
    if (!p.lanes.includes(lane)) return `provider "${provider}" is not allowed in the ${lane} lane`;
    if (!p.apiKey) return `${p.apiKeyEnv} is not set`;
    if (p.missingEnv.length > 0) return `${p.missingEnv.join(", ")} not set`;
    const off = this.disabled.get(provider);
    if (off) return off;
    const problems = censusProblems(this.deps.census, ref, required);
    if (problems.length > 0) return `census: ${problems.join(", ")}`;
    return undefined;
  }

  private async callChat<T>(
    ref: string,
    provider: string,
    model: string,
    messages: ChatMessage[],
    opts: GenerateOptions<T>,
    attempts: Attempt[],
  ): Promise<ChatCall | undefined> {
    const gate = this.deps.gates.get(provider);
    if (!gate) {
      attempts.push({
        ref,
        outcome: "unknown",
        message: `no rate gate for provider "${provider}"`,
      });
      return undefined;
    }
    let current = this.deps.providers[provider]?.quirks?.systemAsUser
      ? mergeSystemIntoUser(messages)
      : messages;
    for (let tries = 0; tries < 2; tries++) {
      let release: (() => void) | undefined;
      try {
        release = await gate.acquire();
      } catch (err) {
        const info = classifyError(err);
        attempts.push({ ref, outcome: info.kind, message: info.message });
        return undefined;
      }
      this.emit({ type: "attempt", ref, tier: opts.tier, lane: opts.lane });
      const started = performance.now();
      try {
        const result = await this.deps.transport.chat(
          provider,
          {
            model,
            messages: current,
            tools: opts.tools,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
          },
          opts.signal,
        );
        const ms = Math.round(performance.now() - started);
        this.breaker.recordSuccess(ref);
        this.record(opts, provider, model, "ok", ms, result);
        return { result, ms };
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        if (opts.signal?.aborted) throw err;
        const info = classifyError(err);
        this.record(opts, provider, model, info.kind, ms, undefined, info.message);
        const rejectsSystem =
          info.kind === "bad-request" &&
          /system/i.test(info.message) &&
          current.some((m) => m.role === "system");
        if (tries === 0 && rejectsSystem) {
          current = mergeSystemIntoUser(current); // some models (e.g. Gemma) have no system role
          continue;
        }
        this.penalize(ref, provider, info, gate);
        attempts.push({ ref, outcome: info.kind, message: truncate(info.message), ms });
        this.emit({
          type: "failure",
          ref,
          tier: opts.tier,
          lane: opts.lane,
          outcome: info.kind,
          message: info.message,
        });
        return undefined;
      } finally {
        release?.();
      }
    }
    return undefined;
  }

  private penalize(ref: string, provider: string, info: FailureInfo, gate: ProviderGate): void {
    switch (info.kind) {
      case "rate-limited":
        gate.cooldown(info.retryAfterMs ?? this.deps.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS);
        break;
      case "auth":
        this.disabled.set(provider, `API key rejected (${truncate(info.message, 120)})`);
        break;
      case "not-found":
      case "forbidden":
        this.breaker.trip(ref, UNAVAILABLE_TRIP_MS);
        break;
      case "quota":
        break;
      default:
        this.breaker.recordFailure(ref);
    }
  }

  /** True when this provider's queue is long and a later candidate elsewhere could start sooner. */
  private shouldDefer(ref: string, later: string[]): boolean {
    const threshold = this.deps.fallbackAfterMs ?? FALLBACK_AFTER_MS;
    const { provider } = parseModelRef(ref);
    const wait = this.deps.gates.get(provider)?.estimatedWaitMs() ?? 0;
    if (wait <= threshold) return false;
    return later.some((other) => {
      const otherProvider = parseModelRef(other).provider;
      if (otherProvider === provider) return false;
      if (this.breaker.isOpen(other) || this.disabled.has(otherProvider)) return false;
      const otherWait =
        this.deps.gates.get(otherProvider)?.estimatedWaitMs() ?? Number.POSITIVE_INFINITY;
      return otherWait + threshold < wait;
    });
  }

  private finish<T>(
    ref: string,
    provider: string,
    model: string,
    call: ChatCall,
    data: T | undefined,
    attempts: Attempt[],
    opts: GenerateOptions<T>,
  ): GenerateResult<T> {
    attempts.push({ ref, outcome: "ok", ms: call.ms });
    this.emit({ type: "success", ref, tier: opts.tier, lane: opts.lane, ms: call.ms });
    return {
      text: call.result.content,
      data,
      toolCalls: call.result.toolCalls,
      finishReason: call.result.finishReason,
      ref,
      provider,
      model,
      latencyMs: call.ms,
      inputTokens: call.result.inputTokens,
      outputTokens: call.result.outputTokens,
      attempts,
    };
  }

  private record<T>(
    opts: GenerateOptions<T>,
    provider: string,
    model: string,
    outcome: string,
    latencyMs: number,
    result?: ChatResult,
    error?: string,
  ): void {
    this.deps.usage?.record({
      lane: opts.lane,
      tier: opts.tier,
      provider,
      model,
      kind: "chat",
      outcome,
      latencyMs,
      inputTokens: result?.inputTokens,
      outputTokens: result?.outputTokens,
      purpose: opts.purpose,
      error,
    });
  }

  private invalid<T>(
    ref: string,
    opts: GenerateOptions<T>,
    attempts: Attempt[],
    message: string,
  ): void {
    attempts.push({ ref, outcome: "invalid-output", message: truncate(message) });
    this.emit({
      type: "failure",
      ref,
      tier: opts.tier,
      lane: opts.lane,
      outcome: "invalid-output",
      message,
    });
  }

  private emit(event: RouterEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      // A broken listener must never break a model call.
    }
  }
}

/** Census results that rule a ref out for the required capabilities. */
export function censusProblems(
  census: CensusFile | null,
  ref: string,
  required: readonly Capability[],
): string[] {
  const entry = census?.entries[ref];
  if (!entry) return [];
  const probed = Object.keys(entry.probes).length > 0;
  if (entry.listed === false && !probed) return ["not in the provider's model list"];
  return required.filter((cap) => entry.probes[cap]?.ok === false).map((cap) => `failed ${cap}`);
}

/** A bigger budget for the retry after a model hit its token limit (often while reasoning). */
function boostTokens(current: number | undefined): number {
  return Math.min(Math.max((current ?? 1024) * 4, 2048), 8192);
}

function hasImages(messages: ChatMessage[] | undefined): boolean {
  return (messages ?? []).some(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "image_url"),
  );
}

function buildMessages<T>(opts: GenerateOptions<T>): ChatMessage[] {
  const system = [opts.system, opts.schema ? jsonInstruction(opts.schema) : undefined]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  if (opts.messages) messages.push(...opts.messages);
  if (opts.prompt) messages.push({ role: "user", content: opts.prompt });
  if (!messages.some((m) => m.role !== "system")) {
    throw new Error("generate() needs a prompt or messages");
  }
  return messages;
}

/** Fold system messages into the first user turn, for models without a system role. */
export function mergeSystemIntoUser(messages: ChatMessage[]): ChatMessage[] {
  const system = messages
    .filter((m): m is Extract<ChatMessage, { role: "system" }> => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  if (!system) return rest;
  const firstUser = rest.findIndex((m) => m.role === "user");
  if (firstUser === -1) return [{ role: "user", content: system }, ...rest];
  return rest.map((m, i) => {
    if (i !== firstUser || m.role !== "user") return m;
    return typeof m.content === "string"
      ? { role: "user", content: `${system}\n\n${m.content}` }
      : { role: "user", content: [{ type: "text", text: system }, ...m.content] };
  });
}
