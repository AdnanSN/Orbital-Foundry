import { z } from "zod";

/**
 * Lanes decide which providers may serve a request (docs/DECISIONS.md, D-001).
 * - sandbox: development, tests, demos. Outputs are never sold or delivered.
 * - live: anything that reaches customers or marketplaces. Production-allowed providers only.
 */
export const LANES = ["sandbox", "live"] as const;
export const laneSchema = z.enum(LANES);
export type Lane = z.infer<typeof laneSchema>;

/** Capabilities the model census probes for. */
export const CAPABILITIES = ["chat", "json", "tools", "vision", "embed"] as const;
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

/** Tiers that agents ask for; config/tiers.yaml maps each one to concrete models per lane. */
export const TIERS = ["reasoning", "creative", "fast", "vision", "embed"] as const;
export const tierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof tierSchema>;

/** "provider:model", e.g. "nvidia:moonshotai/kimi-k2.6". Only the first ":" separates the two. */
export const modelRefSchema = z.string().regex(/^[a-z0-9-]+:.+$/, 'expected "provider:model"');
export type ModelRef = z.infer<typeof modelRefSchema>;

export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) {
    throw new Error(`Invalid model ref "${ref}" (expected "provider:model")`);
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export const providerLimitsSchema = z.object({
  /** Requests per minute we allow ourselves. Keep it a little under the provider's real cap. */
  rpm: z.number().int().positive(),
  /** Requests per UTC day. Omit for no daily cap. */
  rpd: z.number().int().positive().optional(),
  /** Maximum requests in flight at once. */
  concurrency: z.number().int().positive().default(4),
  /**
   * Cap on the output tokens a request asks for. Providers that count `max_tokens` against a
   * tokens-per-minute limit (Groq's free tier) reject large requests early otherwise.
   */
  maxTokens: z.number().int().positive().optional(),
  /**
   * A caller that needs a longer reply (a long-form outline) may ask for up to this many output
   * tokens; others get `maxTokens`. Defaults to `maxTokens`.
   */
  largeTokens: z.number().int().positive().optional(),
  /**
   * Tokens a minute the provider counts, input plus the output asked for. A request asks for no
   * more output than fits beside its input, since one that passes the limit alone always fails.
   */
  tpm: z.number().int().positive().optional(),
});
export type ProviderLimits = z.infer<typeof providerLimitsSchema>;

export const providerSchema = z.object({
  name: z.string(),
  /** OpenAI-compatible base URL. May contain ${ENV_VAR} placeholders. */
  baseURL: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  /** Lanes this provider may serve. Only include "live" if its terms allow production use. */
  lanes: z.array(laneSchema).min(1),
  /** What the provider's terms say about production use and selling outputs. */
  production: z.enum(["allowed", "forbidden", "unverified"]).default("unverified"),
  /** When the terms were last checked (YYYY-MM-DD), and where (recorded in DECISIONS.md). */
  termsChecked: z.string().optional(),
  limits: providerLimitsSchema,
  /** Whether GET {baseURL}/models works without an API key. */
  publicModelList: z.boolean().default(false),
  /** Provider-specific request tweaks. */
  quirks: z
    .object({
      /** Send NVIDIA-style `input_type` with embedding requests. */
      embedInputType: z.boolean().optional(),
      /** Fold system prompts into the first user message for every model on this provider. */
      systemAsUser: z.boolean().optional(),
    })
    .optional(),
  terms: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof providerSchema>;

export const imageEndpointSchema = z.object({
  /** Key into `providers`: supplies the API key, rate limits and allowed lanes. */
  provider: z.string(),
  /** Request and response format. */
  kind: z.enum(["nvidia-genai", "cloudflare-run"]),
  /** Endpoint URL. May contain ${ENV_VAR} placeholders. */
  url: z.string().min(1),
  lanes: z.array(laneSchema).min(1),
  license: z.string().optional(),
  /** Highest step count the model accepts. */
  maxSteps: z.number().int().positive().default(4),
  /** Whether width/height are honoured (otherwise the model's default size is used). */
  supportsSize: z.boolean().default(false),
  /** Whether the endpoint accepts a `seed` (Cloudflare's FLUX.1-schnell rejects one). */
  supportsSeed: z.boolean().default(true),
  /** NVIDIA genai only: seconds the server may hold a request before answering 202 + request id. */
  pollSeconds: z.number().int().positive().default(30),
});
export type ImageEndpointConfig = z.infer<typeof imageEndpointSchema>;

export const providersFileSchema = z.object({
  providers: z.record(z.string(), providerSchema),
  images: z.record(z.string(), imageEndpointSchema).default({}),
});
export type ProvidersFile = z.infer<typeof providersFileSchema>;

export const tierConfigSchema = z.object({
  description: z.string().optional(),
  /** Capabilities every model in this tier must have (checked against the census). */
  requires: z.array(capabilitySchema).min(1),
  /** Candidate model refs in priority order. */
  sandbox: z.array(modelRefSchema).default([]),
  live: z.array(modelRefSchema).default([]),
});
export type TierConfig = z.infer<typeof tierConfigSchema>;

export const tiersFileSchema = z.object({
  tiers: z.record(tierSchema, tierConfigSchema),
});
export type TiersFile = z.infer<typeof tiersFileSchema>;

export const probeResultSchema = z.object({
  ok: z.boolean(),
  ms: z.number().optional(),
  note: z.string().optional(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const censusEntrySchema = z.object({
  ref: modelRefSchema,
  testedAt: z.string(),
  /** Whether the provider's /models list includes this model (absent = not checked). */
  listed: z.boolean().optional(),
  probes: z.partialRecord(capabilitySchema, probeResultSchema),
});
export type CensusEntry = z.infer<typeof censusEntrySchema>;

export const censusFileSchema = z.object({
  generatedAt: z.string(),
  entries: z.record(z.string(), censusEntrySchema),
});
export type CensusFile = z.infer<typeof censusFileSchema>;
