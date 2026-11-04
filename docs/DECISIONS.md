# Decisions

Short records of choices that shape the code, newest last. Add one whenever a stage makes a
choice that future sessions must respect.

## D-001: Two lanes, sandbox and live (2026-11-04)

**Context.** NVIDIA's free API (build.nvidia.com) is a trial. Its terms allow testing and
evaluation only: no production use of the service or its generated content, and no selling or
distributing generated content (NVIDIA API Trial Terms of Service, read 2026-11-04). We still want
its large free catalog for building and testing.

**Decision.** Every model request names a lane.

- `sandbox` may use any configured provider. Its outputs are never sold or delivered.
- `live` may only use providers whose terms allow production use, meaning `live` appears in their
  `lanes` in `config/providers.yaml`.

This is enforced twice: by config validation at load time, and by the router and image service at
call time.

**Consequences.**

- NVIDIA is sandbox-only.
- Live images come from Cloudflare Workers AI: FLUX.1-schnell, Apache-2.0, on a free allowance of
  10,000 neurons a day (about 170 images).
- Live text starts on Cloudflare's small models. Groq and the others are promoted only after a terms
  check in Stage 7.

## D-002: Confirmed defaults (2026-11-04)

The owner kept every default from §11 of the roadmap:

- project `orbital-foundry`, in `C:\Users\adnan\dev\New folder`;
- TypeScript end to end;
- businesses in the order Etsy POD → Thumbnails → Game assets;
- the owner approves every external action;
- live text on Groq's free tier with a local fallback, revisited in Stage 7;
- original pixel art drawn in code;
- the Overseer is named WARDEN;
- it runs on the laptop for now.

## D-003: A plain OpenAI-compatible client instead of the AI SDK (2026-11-04)

**Context.** The roadmap listed the Vercel AI SDK. Every provider we use speaks the OpenAI
chat-completions API. We need tight control over lanes, per-provider rate limits, fallbacks and the
census, and in Stage 4 we need our own agent loop that emits a visual event at every step.

**Decision.** Use the official `openai` npm SDK (v7) purely as an OpenAI-compatible HTTP client,
with `maxRetries: 0` so the router owns retries. Structured output works the same way on every
provider:

1. the JSON Schema (generated from zod) goes in the system prompt;
2. the reply goes through tolerant JSON extraction;
3. zod validates the result;
4. a failed reply gets one repair round.

**Revisit** in Stage 4 if the tool loop gets painful.

## D-004: SQLite via better-sqlite3 with plain SQL migrations (2026-11-04)

There is only one table so far (`llm_calls`). Migrations are an ordered list in
`apps/server/src/db.ts`, tracked in `schema_migrations`. Whether to adopt Drizzle gets decided in
Stage 3, when the schema grows.

## D-005: Model choice is data, checked by a census (2026-11-04)

Free catalogs change monthly. Tiers therefore list candidate `provider:model` refs in
`config/tiers.yaml`, and `npm run census` records which ones pass the chat, JSON, tools, vision and
embedding probes. The router skips any ref that failed a capability the request needs. All 15
NVIDIA candidates were confirmed in NVIDIA's live catalog on 2026-11-04; they have not been probed
yet because no keys are set.

## D-006: Toolchain (2026-11-04)

- Node 22 (installed) with npm workspaces.
- TypeScript 7.0, Vitest 5, Biome 2.6 (recommended preset), tsx 4.
- `@types/node` is pinned to 22.x to match the runtime.
- LF line endings are enforced through `.gitattributes`, so Biome's format check passes on Windows
  checkouts.

## D-007: A provider's catalog is not proof a model works (2026-11-04)

**Context.** The first real run, with keys, showed that public model lists overstate what an
account can use:

- **NVIDIA:** only 7 of the 61 chat-like models in its public `/v1/models` list answered. The rest
  returned 404 ("not found for account") or 503, or hung past 30 seconds. A hung model costs a full
  timeout on every call.
- **Groq:** its catalog had rotated, and the Llama 3.x models were gone. Today it offers
  `openai/gpt-oss-120b`, `openai/gpt-oss-20b` and `qwen/qwen3.8-27b`, and all three pass chat, JSON
  and tools.
- **Cloudflare:** its OpenAI-compatible API has no `GET /models` (it returns 405). The real catalog
  is behind its model-search API. Among the models tested:
  - Llama 3.3 70B passes everything.
  - Llama 3.1 8B fails strict instruction-following.
  - Moondream rejects OpenAI-style image input.

**Decision.**

- `npm run census -- --discover --provider <id>` sends one cheap chat request to every chat-like
  catalog model. Its results are how the tiers get rebuilt.
- The census is the source of truth for which models the router will use.
- The census gives up on a model after a first-probe timeout or a 404, and probes several models
  at once within each provider's limits.
- A full census run forgets entries for models no longer listed in any tier.
- Re-run discovery whenever a provider's catalog changes.

## D-008: Redact account identifiers from provider errors (2026-11-04)

NVIDIA's 404 bodies include the caller's account ID, and error notes end up in a committed file
(`config/models.census.json`) and in the usage log. `ProviderHttpError` and `classifyError`
therefore redact three things:

- account IDs in error text;
- Cloudflare account IDs inside URLs;
- anything shaped like a key (`nvapi-…`, `gsk_…`, `Bearer …`).

Tests use fake IDs only.

## D-009: Vision probes use a shape, not a flat colour (2026-11-04)

NVIDIA screens images before its vision models see them, and it rejects uniform images with
"422 media could not be screened". The vision probe and the smoke test therefore send a red circle
on white (512 px). NVIDIA's Nemotron-3.5 Super VL, and Cloudflare's Mistral Small 3.1 and Llama 4
Scout, all answer "Red".

Images go in OpenAI-style `image_url` parts; NVIDIA's older inline `<img>` format got a wrong
answer. Stage 5's vision QA should expect the same screening on real designs.

## D-010: Retry once with a bigger token budget; empty replies count as failures (2026-11-04)

Reasoning models spend hidden tokens before they answer. With 400 max tokens, Nemotron-3.5
Lightning stopped after one word (`finish_reason: "length"`); with 2,000 it finished using 472.

**Decision.**

- When a reply ends with `length`, the router retries once on the same model with four times the
  budget, between 2,048 and 8,192 tokens.
- A reply with no text and no tool calls counts as invalid output and falls through to the next
  model.

**For Stage 4.** Llama 3.3 70B sent tool arguments as strings (`"17"` instead of `17`). The tool
runner must validate and coerce arguments with zod before it runs a tool.

## D-011: Image endpoints fail fast; sandbox images use Cloudflare for now (2026-11-04)

**Context.** For this account, NVIDIA's FLUX.1-schnell and FLUX.1-dev endpoints hang. With
`NVCF-POLL-SECONDS` they instead return HTTP 504 with `nvcf-status: errored` after about 7 seconds,
which shows the failure is upstream, on NVIDIA's side. SD3 Medium returns 404.

**Decision.**

- NVIDIA genai requests send `NVCF-POLL-SECONDS` and follow the 202 + request-id polling flow, so
  they succeed or fail within seconds instead of hanging for minutes.
- The image service has a circuit breaker. After three failures it skips an endpoint for five
  minutes, or for an hour after a 404 or 403.
- Cloudflare's FLUX.1-schnell rejects a `seed`, so each endpoint declares `supportsSeed`.
- Until NVIDIA's FLUX recovers, sandbox images come from Cloudflare too. They spend the same free
  daily budget as the live lane: 10,000 neurons, about 170 images in total.

## D-012: Llama 3.2 Vision on Cloudflare needs a license agreement (pending: the owner's call)

Before `@cf/meta/llama-3.2-11b-vision-instruct` can be used, Cloudflare requires sending the
prompt "agree" once, which accepts Meta's Llama 3.2 Community License. Accepting a license is the
owner's decision, so it hasn't been done.

It isn't needed today: Mistral Small 3.1 (Apache-2.0) and Llama 4 Scout already pass the live
vision census. The model stays last in the live vision list in case the owner agrees later.
