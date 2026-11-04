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
