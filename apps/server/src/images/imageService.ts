import type { ImageEndpointConfig, Lane } from "@orbital/shared";
import type { ResolvedProviders } from "../config";
import { interpolateEnv, missingEnvVars } from "../env";
import { CircuitBreaker } from "../llm/circuitBreaker";
import {
  type Attempt,
  classifyError,
  type FailureInfo,
  NoCandidateError,
  ProviderHttpError,
  parseRetryAfter,
  RouterError,
  truncate,
} from "../llm/errors";
import type { ProviderGate } from "../llm/rateLimiter";
import type { UsageLog } from "../llm/usage";
import { detectImageMime, type ImageMime } from "./png";

/** Where NVIDIA cloud functions report on requests that outlived the poll window. */
export const NVCF_STATUS_URL = "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status";
const MAX_STATUS_POLLS = 20;
const REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_COOLDOWN_MS = 20_000;
const UNAVAILABLE_TRIP_MS = 60 * 60_000;

export interface ImageRequest {
  prompt: string;
  /** Honoured only by endpoints with `supportsSize`. */
  width?: number;
  height?: number;
  /** Random when omitted (and the endpoint accepts seeds). Returned so results can be reproduced. */
  seed?: number;
  steps?: number;
  purpose?: string;
  signal?: AbortSignal;
}

export interface ImageResult {
  bytes: Buffer;
  mime: ImageMime;
  endpoint: string;
  provider: string;
  /** The seed used, when the endpoint accepts one. */
  seed?: number;
  latencyMs: number;
  attempts: Attempt[];
}

export interface ImageServiceDeps {
  providers: ResolvedProviders;
  endpoints: Record<string, ImageEndpointConfig>;
  gates: Map<string, ProviderGate>;
  usage?: UsageLog;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Lane-aware image generation over NVIDIA genai and Cloudflare Workers AI endpoints. */
export class ImageService {
  private readonly breaker: CircuitBreaker;

  constructor(private readonly deps: ImageServiceDeps) {
    this.breaker = deps.breaker ?? new CircuitBreaker();
  }

  /** Endpoints usable in `lane` (config order), and why the others were skipped. */
  plan(lane: Lane): { ids: string[]; skipped: string[] } {
    const ids: string[] = [];
    const skipped: string[] = [];
    for (const [id, endpoint] of Object.entries(this.deps.endpoints)) {
      const reason = this.unavailable(endpoint, lane);
      if (reason) skipped.push(`${id}: ${reason}`);
      else ids.push(id);
    }
    return { ids, skipped };
  }

  /** Generate with the first endpoint that works in this lane, skipping ones that keep failing. */
  async generate(lane: Lane, req: ImageRequest): Promise<ImageResult> {
    const { ids, skipped } = this.plan(lane);
    if (ids.length === 0) throw new NoCandidateError("image generation", lane, skipped);
    const attempts: Attempt[] = [];
    for (const id of ids) {
      if (this.breaker.isOpen(id)) {
        attempts.push({ ref: id, outcome: "circuit-open" });
        continue;
      }
      try {
        return await this.generateWith(id, lane, req, attempts);
      } catch (err) {
        if (req.signal?.aborted) throw err;
      }
    }
    throw new RouterError("image generation", lane, attempts);
  }

  /** Generate with one specific endpoint. Lane rules still apply. */
  async generateWith(
    id: string,
    lane: Lane,
    req: ImageRequest,
    attempts: Attempt[] = [],
  ): Promise<ImageResult> {
    const endpoint = this.deps.endpoints[id];
    if (!endpoint) throw new Error(`Unknown image endpoint "${id}"`);
    const reason = this.unavailable(endpoint, lane);
    if (reason) throw new NoCandidateError(`image endpoint "${id}"`, lane, [reason]);
    const apiKey = this.deps.providers[endpoint.provider]?.apiKey ?? "";
    const gate = this.deps.gates.get(endpoint.provider);
    const release = gate ? await gate.acquire() : undefined;
    const seed = endpoint.supportsSeed
      ? (req.seed ?? Math.floor(Math.random() * 2_147_483_647))
      : undefined;
    const steps = Math.min(Math.max(1, req.steps ?? endpoint.maxSteps), endpoint.maxSteps);
    const body: Record<string, unknown> = { prompt: req.prompt, steps };
    if (seed !== undefined) body.seed = seed;
    if (endpoint.supportsSize) {
      body.width = req.width ?? 1024;
      body.height = req.height ?? 1024;
    }
    const started = performance.now();
    try {
      const url = interpolateEnv(endpoint.url, this.deps.env);
      const json = await this.postJson(endpoint, url, apiKey, body, req.signal);
      const bytes =
        endpoint.kind === "nvidia-genai" ? decodeNvidiaGenai(json) : decodeCloudflareRun(json);
      const mime = detectImageMime(bytes);
      if (!mime) {
        throw new Error("The endpoint returned bytes that are not a PNG, JPEG or WebP image");
      }
      const ms = Math.round(performance.now() - started);
      this.breaker.recordSuccess(id);
      attempts.push({ ref: id, outcome: "ok", ms });
      this.deps.usage?.record({
        lane,
        provider: endpoint.provider,
        model: id,
        kind: "image",
        outcome: "ok",
        latencyMs: ms,
        purpose: req.purpose,
      });
      return {
        bytes,
        mime,
        endpoint: id,
        provider: endpoint.provider,
        seed,
        latencyMs: ms,
        attempts,
      };
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      const info = classifyError(err);
      this.penalize(id, info, gate);
      attempts.push({ ref: id, outcome: info.kind, message: truncate(info.message), ms });
      this.deps.usage?.record({
        lane,
        provider: endpoint.provider,
        model: id,
        kind: "image",
        outcome: info.kind,
        latencyMs: ms,
        purpose: req.purpose,
        error: info.message,
      });
      throw err;
    } finally {
      release?.();
    }
  }

  private penalize(id: string, info: FailureInfo, gate: ProviderGate | undefined): void {
    if (info.kind === "rate-limited") {
      gate?.cooldown(info.retryAfterMs ?? DEFAULT_COOLDOWN_MS);
    } else if (info.kind === "not-found" || info.kind === "forbidden" || info.kind === "auth") {
      this.breaker.trip(id, UNAVAILABLE_TRIP_MS);
    } else if (info.kind !== "quota") {
      this.breaker.recordFailure(id);
    }
  }

  private unavailable(endpoint: ImageEndpointConfig, lane: Lane): string | undefined {
    const provider = this.deps.providers[endpoint.provider];
    if (!provider) return `unknown provider "${endpoint.provider}"`;
    if (!endpoint.lanes.includes(lane) || !provider.lanes.includes(lane)) {
      return `not allowed in the ${lane} lane`;
    }
    if (!provider.apiKey) return `${provider.apiKeyEnv} is not set`;
    const missing = missingEnvVars(endpoint.url, this.deps.env);
    if (missing.length > 0) return `${missing.join(", ")} not set`;
    return undefined;
  }

  private async postJson(
    endpoint: ImageEndpointConfig,
    url: string,
    apiKey: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const deadline = signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (endpoint.kind === "nvidia-genai") {
      // Ask NVIDIA to answer within the poll window (202 + request id) instead of holding the
      // connection open, so a broken function fails in seconds rather than minutes.
      headers["NVCF-POLL-SECONDS"] = String(endpoint.pollSeconds);
    }
    let res = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: deadline,
    });
    for (let polls = 0; res.status === 202 && polls < MAX_STATUS_POLLS; polls++) {
      const requestId = res.headers.get("nvcf-reqid");
      if (!requestId) break;
      res = await fetchImpl(`${NVCF_STATUS_URL}/${encodeURIComponent(requestId)}`, {
        headers,
        signal: deadline,
      });
    }
    if (res.status === 202) {
      throw new ProviderHttpError(
        endpoint.provider,
        0,
        "the image was still processing after polling",
        undefined,
        "timeout",
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const nvcfStatus = res.headers.get("nvcf-status");
      throw new ProviderHttpError(
        endpoint.provider,
        res.status,
        `HTTP ${res.status}${nvcfStatus ? ` (nvcf-status: ${nvcfStatus})` : ""}: ${truncate(text, 300)}`,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }
    return res.json();
  }
}

/** NVIDIA genai (FLUX on ai.api.nvidia.com): `{ artifacts: [{ base64, finishReason, seed }] }`. */
export function decodeNvidiaGenai(json: unknown): Buffer {
  const body = json as {
    artifacts?: { base64?: string; finishReason?: string }[];
    image?: string;
    data?: { b64_json?: string }[];
  };
  const artifact = body.artifacts?.[0];
  if (artifact?.finishReason && artifact.finishReason !== "SUCCESS") {
    throw new Error(`NVIDIA image generation finished with ${artifact.finishReason}`);
  }
  const base64 = artifact?.base64 ?? body.image ?? body.data?.[0]?.b64_json;
  if (!base64) {
    throw new Error(`Unexpected NVIDIA image response: ${truncate(JSON.stringify(json), 200)}`);
  }
  return Buffer.from(base64, "base64");
}

/** Cloudflare Workers AI REST: `{ success, errors, result: { image } }` (base64 JPEG). */
export function decodeCloudflareRun(json: unknown): Buffer {
  const body = json as {
    success?: boolean;
    errors?: { message?: string }[];
    result?: { image?: string };
  };
  if (body.success === false) {
    const reasons = body.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`Cloudflare Workers AI error: ${reasons || "unknown error"}`);
  }
  const base64 = body.result?.image;
  if (!base64) {
    throw new Error(`Unexpected Cloudflare image response: ${truncate(JSON.stringify(json), 200)}`);
  }
  return Buffer.from(base64, "base64");
}
