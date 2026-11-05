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

## D-013: Client stack and rendering (2026-11-04)

**Decision.** `apps/client` uses the latest stable releases on 2026-11-04: Vite 8.3, Phaser 4.2.1,
React 19.3 and Tailwind 4.3.

- Phaser renders with `smoothPixelArt`. Its pixel-art guide recommends this when the camera
  zooms: pixels stay square, with no shimmer at fractional zoom.
- The canvas renders at device resolution (CSS size × DPR, with Phaser's scale zoom at 1/DPR), so
  the art stays crisp on the laptop's scaled display.
- There are two cameras: a fixed one for the starfield, and the world camera that pans and zooms.
  Void tiles and window glass are transparent, so the stars show through.
- The React panels are a DOM overlay. They read the same world model as the scene and refresh
  four times a second.
- All art, the pixel font and the icons are drawn in code (§5, D-002). There are no third-party
  art or font files.

## D-014: The station map is a JSON tile grid in packages/shared (2026-11-04)

`packages/shared/src/station/station.map.json` holds a character grid (void, wall, window, floor,
corridor, door) plus lists of rooms, furniture, anchors and floor labels.

- Anchors are the spots where crew stand to do things (work, deliver, review, rest, patrol), each
  with a facing.
- The JSON is the source of truth and is edited by hand. Biome formats it.
- zod validates the schema on load. `layoutProblems()` catches what a hand edit can break:
  furniture on walls, overlapping furniture, anchors off the floor or out of reach, and blocked
  doorways. A test keeps the list empty.
- Furniture blocks the tiles it stands on, so pathfinding walks around it.
- Room themes are ids in the map. The client owns the colours.

## D-015: Shared deterministic A* (2026-11-04)

`findPath` in packages/shared is a 4-connected A*.

- Each step costs 1, and each turn costs 0.2 more. Among the shortest routes, it picks the one
  with the fewest turns, so walks look deliberate.
- Ties are broken by a fixed rule, so every machine gets the same path.
- Walking speed is a shared constant (3.2 tiles per sim second). With that, `agent.moved {from,
  to, t0}` is enough for any client to animate the walk the server meant (§8).
- Crew may pass through each other while walking. The director never parks two on one tile.

## D-016: Station events and the client world model (2026-11-04)

The event types are zod schemas in `packages/shared/src/station/events.ts`: `snapshot`,
`agent.spawned`, `agent.moved`, `agent.activity`, `agent.say`, `task.updated` and
`provider.status`.

- Every event has a sequence number and a time in sim milliseconds. The other §8 messages join the
  union in the stages that produce them.
- The client's `World` is built only from events: a snapshot, then increments. It drops stale and
  duplicate sequence numbers. The Phaser scene and the React panels only read it.
- Events reach the world through a `StationLink`: `MockLink` today, a WebSocket link in Stage 3.
- An activity says what an agent is doing. Walking comes from `agent.moved`. A facing sent after a
  walk ends is the direction the agent stands in.

## D-017: The Stage 2 mock director (2026-11-04)

`apps/client/src/mock/director.ts` plays the server's part. It is deterministic for a seed, does
not depend on frame rate, uses no browser APIs and calls no models. Stage 3 can run it on the
server as the first sim engine.

- A task takes two or three work sessions, sometimes at different stations.
- Factory crew then carry a crate to the QA Bay. Scout takes reports to the Bridge, and so does
  Ledger now and then.
- Lens reviews what arrives. When there is a backlog, Lens does quick checks at the intake table.
  About 28% of first attempts go back for rework, with at most two reworks (§6).
- Mock rate limits, mostly on NVIDIA, send one or two working crew to the café for the back-off.
  Lens is never sent, so deliverables don't pile up; a test caps the backlog.
- Mock outages turn a Server Room rack row red, with sparks.
- WARDEN plans at the holo-table, patrols the rooms, and nudges anyone idle for 6 seconds.
- The tunables live in `DEFAULT_TIMING`.

## D-018: Code-drawn crew sprites (2026-11-04)

The 16×16 crew sprites are layers of run-length rows of palette keys: a head per hair style, an
accessory, a body pose, legs and a carried item. They are composed frame by frame.

- Each crew member's look (skin, hair, suit, accent, accessory) swaps the palette.
- Right-facing frames mirror the left-facing ones.
- The animations are an idle with a breath and a blink, a 4-direction walk with a one-pixel bob,
  typing, and carrying a crate, a datapad or a cup.
- Eyes are a white glint over a dark pupil, so they read on every skin tone.
- `?view=sprites` shows every frame enlarged, for checking the art.

## D-019: The sim engine is shared, and the runtime drives it by command (2026-11-05)

The Stage 2 mock director became `StationSim` in `packages/shared/src/sim`. The server runs it,
and the client runs the same code offline (`?mock=1`).

- Behaviour follows each crew member's `role` (overseer, researcher, operator, thumbnailer,
  forger, reviewer or bookkeeper), so new hires behave like their role.
- `save()` and `StationSim.restore()` round-trip everything except the plans in flight, which
  hold closures. A restored station keeps every position, activity, task and timer, and each
  crew member starts a fresh plan from where they stand.
- `control(id)` and `command(id, ...)` let the Stage 4 runtime take a crew member off
  autopilot. Commands cover: working at a station; delivering to the QA Bay, the Bridge or the
  Owner's Desk; taking a café break; idling; and going to a room.
- `upsertTask` and `setProviderStatus` publish the runtime's tasks and real provider status.
- With `mockProviders: false`, the engine stops inventing rate limits and outages.

## D-020: Station server persistence and protocol (2026-11-05)

- **Storage:** SQLite migration 2 adds `agents` (the roster), `tasks`, `events` (the
  append-only log) and `kv` (the engine save). Events and the save are written in one
  transaction every 2 seconds, and straight after a hire or reassign. A restored engine never
  reuses a logged sequence number.
- **Clock:** sim time advances at real time × speed while the server runs. A stall of more than
  a second (the laptop asleep) does not fast-forward the station.
- **WebSocket `/ws`:** sends a snapshot on connect, then one JSON array of events per tick. A
  client that reconnects simply gets a fresh snapshot.
- **REST:** zod validates every request, and a bad one gets a 400 with a readable message.
  - `POST /api/sim`: pause, or set the speed.
  - `POST /api/agents`: hire.
  - `PATCH /api/agents/:id`: reassign to another room.
  - `GET /api/state`, `/api/health`, `/api/roles`.
- **Binding:** the server listens on 127.0.0.1:8787. Remote access, with authentication, is a
  Stage 11 decision.
- **Role templates** (title, room, tiers, whether the role can be hired) live in
  `packages/shared/src/station/roles.ts`. Stage 4 adds prompts and tools on the server side.

## D-021: The agent runtime and its tools (2026-11-05)

- **Roles are data.** `config/roles/<role>.yaml` holds the title, tier, step cap, tools, KPIs,
  schedule and system prompt (`{name}` and `{business}` are filled in). The prompt is not code.
- **The work loop** (`apps/server/src/work/runtime.ts`) calls the role's tier with the role's tools
  until the agent calls `submit_for_review` or `escalate`, or the step cap runs out.
  - Tool arguments are validated with zod, and numbers sent as strings are coerced.
  - A repeated identical tool call is not run again; the agent is told to move on.
  - The last step offers only `submit_for_review` and `escalate`, so a run ends with a
    deliverable or a reason. Every role always has both.
  - A long plain-text reply (no tool call) after the first step counts as the deliverable.
  - Router errors back off once (the avatar goes to the café), then the run fails.
- **Tool metadata** (`defineTool`): `sideEffect` (none, internal, external), `lane` (any, sandbox,
  live) and `approval` (never, policy, always). The runtime never runs an external tool: it files
  an Owner's Desk request. After approval the director runs it once, keyed by the approval id.
- **Untrusted text** (web pages, later customer briefs) comes back wrapped in an `<untrusted>` block
  with a warning. Web research only reaches hosts in `config/web.yaml` (Wikipedia for now).
- **Memory** is per agent and per scope, with embeddings from the embed tier when available and a
  keyword fallback.

## D-022: WARDEN's loop (2026-11-05)

`WorkDirector` (`apps/server/src/work/director.ts`) ticks every second.

- **Plan:** the reasoning tier turns an objective into 1 to 4 tasks (zod schema). Each task goes to
  the least-loaded crew member with the role.
- **Order:** tasks of one objective run in plan order, and each sees the earlier deliverables.
  Reworks and owner revisions are never held back.
- **Concurrency:** at most two agent runs at once (free tiers are scarce), plus one review.
- **Review:** Lens reviews factory work and WARDEN reviews the rest. A rework carries the feedback;
  after two reworks the task passes with a note, so nothing loops forever.
- **Finish:** when every task is done or failed, WARDEN writes the final deliverable and sends it to
  the Owner's Desk. Accepting it closes the objective and saves a station memory. Sending it back
  with a note starts a revision.
- **Escalation:** a task that fails twice, or whose agent calls `escalate`, goes to the Owner's
  Desk, and the crew member's avatar shows the red alert. Retry puts it back in the queue with
  your note; Cancel fails it.
- **Stuck runs:** after 8 minutes WARDEN walks over and asks for a status (once per run).
- **Standup:** once a day after `standupHour` (18:00 in `overseer.yaml`), if there is real work, and
  on demand from the Work panel.
- **Restarts:** nothing is running after a restart, so in-progress tasks go back to the queue.

## D-023: The Owner's Desk (2026-11-05)

One inbox (`approvals` table) for everything that waits for you: final results (`deliverable`),
actions that would leave the station (`action`), and stuck crew (`escalation`). The Desk button
shows a badge, and WARDEN's avatar waits at the Owner's Desk with a ❗ while anything is pending.
Decisions carry an optional note for the crew. Nothing is published, sent or bought without a
click here (rule 3 in CLAUDE.md).

## D-024: Deterministic end-to-end tests with a fixture transport (2026-11-05)

`FixtureTransport` (`apps/server/src/llm/fixtures.ts`) answers chat requests from a list of
fixtures matched on the system prompt, the user text, the latest tool result, or the tools on
offer. A fixture can be used once. `RecordingTransport` wraps a real transport to capture new
fixtures. The work tests run the whole loop (plan, work, review, rework, synthesis, Desk,
escalation, café back-off, restart recovery) without a network.

## D-025: The creative toolchain runs in-process on @napi-rs/canvas (2026-11-05)

Every image operation (decode, resample, keying, cutouts, quantization, sprite sheets, text
layout, PNG and JPEG encoding) runs on `@napi-rs/canvas` (Skia, prebuilt for Windows). It needs no
Python, no GPU and no system libraries, so the station works the same on the laptop and on a small
VM (Stage 11).

- **Images are artifacts** with an `I-` id, a PNG under `data/artifacts/images`, a `parentId` (the
  image it was made from), a `room` (its gallery), a `review` (pending, approved, rejected) and
  `info` (prompt, style, seed, endpoint, size, method, QA score, IP verdict). Every edit makes a new
  artifact, so the files never change and can be cached forever.
- **Styles are data** (`config/prompts.yaml`): prefix, suffix, words to avoid, the default aspect
  and the cutout method. FLUX schnell has no negative prompt, so "avoid" is folded into the text.
- **Aspect ratios:** Cloudflare's FLUX endpoint only makes 1024×1024 and takes no seed, so the
  result is centre-cropped and resampled to the aspect's size; the seed is recorded when the
  endpoint accepts one.
- **Pipeline order:** cut out at the generated size, then upscale with the alpha channel. The key
  is cleaner at the original size and the flood fill touches 16× fewer pixels.
- **Agent tools:** generate_image, upscale_image, remove_background, chroma_key, compose_image,
  pixelate_image, make_spritesheet, vision_qa, ip_screen. All internal; nothing leaves the station.

## D-026: Real-ESRGAN and rembg are optional and off until the owner OKs the downloads (2026-11-05)

Both need downloads (the Real-ESRGAN release binary and models, and rembg's U2-Net model through
uv), which the plan reserves for the owner. The runners are built (`creative/external.ts`) and
switched on by setting `upscale.realesrgan` or `background.rembg` in `config/creative.yaml`.

- Until then, upscales use a high-quality 2×-step resampler (good for flat vector art, softer than
  Real-ESRGAN on photos), and cutouts use the edge flood fill (plain backgrounds; keeps enclosed
  areas of the same colour) or the chroma key (flat key colours such as magenta and green).
- If a configured runner fails, the studio falls back to the built-in method and records why.

## D-027: Fonts are system fonts for now (2026-11-05)

`compose` picks the first installed family from lists in `config/creative.yaml` (display: Impact,
Arial Black; body: Segoe UI, Arial). Bundled open-license fonts (for example from Google Fonts,
OFL) would make output identical on any machine and remove licence doubt for sold products; they
need a download, so they are a follow-up for the owner.

## D-028: QA and the IP screen are conservative (2026-11-05)

- **vision_qa** sends a downscaled JPEG (transparent areas flattened to grey) to the vision tier with
  a rubric: defects, garbled text, AI artifacts, legibility, fit for purpose. A score of 7 or more
  with no garbled text passes. The reply is parsed with zod (no router `schema`, so vision models
  without a JSON census pass still work). Deterministic checks always run: blank images, coverage,
  and opaque border pixels on cutouts. Without a vision model nothing passes.
- **ip_screen**: a blocklist hit (whole words, case-insensitive) blocks; then the fast tier (or
  the vision tier with an image) rates the risk. High blocks, medium goes to review, and without a
  model the verdict is at best "review". generate_image refuses prompts that hit the blocklist.

## D-029: Factory pipelines are code, not agent loops (2026-11-05)

Factory 1's listing pipeline (`apps/server/src/pod/factory.ts`) is a fixed sequence of steps with
one structured model call per creative step (concept, prompts, copy, with a repair round for
copy that breaks Etsy's rules) and the Stage 5 tools for the rest.

- **Why:** a listing then costs a predictable number of free-tier calls (about 15 chat calls and
  4 to 6 images), it cannot loop, and every step can be tested with fixtures. The agent runtime
  (D-021) stays for open-ended objectives.
- **On screen:** the crew still do the work visibly: Scout at the research desk, the store's
  operator in Factory 1, Lens at the QA Bay. The factory never takes over a crew member the agent
  runtime is using.
- **Tasks** carry `pipeline: "pod"` (ids `P-…`). The runtime ignores them; the factory owns them.
  After a restart, interrupted listings are marked failed (a new one can be started).
- **Failures** go to the Owner's Desk once per store per day; Retry starts a fresh listing.
- **Real finished tasks** keep their own history in the engine (1,000) separate from ambient
  tasks (300), and owner decisions find their store from the package or the requester, so neither
  depends on a task still being in memory.

## D-030: Listing rules, pricing and honest packages (2026-11-05)

- **Copy:** titles in Title Case, at most 140 characters (the prompt asks for a readable name of
  50 to 110); exactly 13 tags of at most 20 characters, normalized and deduplicated. A tag that
  is too long loses words from the front ("minimal winter wall art" → "winter wall art"), and
  missing tags come from the store's seed tags. No brand, character or celebrity names.
- **Description:** the copy, the product facts, then the disclosures from `marketplaces.yaml`: AI
  assistance ("reviewed by a person before listing", which the Owner's Desk makes true), the
  production partner, and a note that mockups show the actual design.
- **Price:** the lowest price ending in the store's cents (.95 or .99) that leaves the target
  margin after product cost, shipping (listings ship free) and Etsy's fees (listing $0.20, 6.5%
  transaction, 3% + $0.25 processing; re-check in Stage 7), and is at least the store's minimum.
- **Print files:** cutout, trim to the subject, upscale only as far as needed, then fit the print
  area exactly ("contain" on transparent for mugs, totes, shirts and labels; "cover" for posters).
- **Mockups** are drawn in code (frame, mug, candle, tote, t-shirt) with the real print file where
  it prints, plus a detail view with the print area. No photo templates, so nothing implies a
  product or setting we don't sell.
- **Defaults:** print areas and costs in `products.yaml` are starting values, flagged as a warning
  in every compliance report until Printify's catalog replaces them (Stage 7).
- **Personalization** (names printed per order) waits for per-order print files in Stage 7, so no
  store offers it yet.
- **Sandbox:** packages are for review. Accepting one never publishes it; images made in the
  sandbox lane are re-made with production-licensed providers before anything is sold (D-001).

## D-031: The daily autopilot (2026-11-05)

Each store makes `listingsPerDay` listings a day (default 1), started by the factory in working
hours (9:00 to 21:00 local), one listing at a time across all stores, with a 30-minute back-off
after a failure. Settings (per-day count, pause) are saved per store and changed in the Stores
panel. `ORBITAL_AUTOPILOT=0` turns the autopilot off.

## D-032: Providers record their terms; the live lane needs "allowed" (2026-11-05)

`providers.yaml` gives each provider `production: allowed | forbidden | unverified` and the date its
terms were checked. Config validation refuses a provider in the live lane unless it is "allowed".

- NVIDIA: forbidden (trial terms: no production use, outputs may not be sold), checked 2026-11-04.
- Cloudflare Workers AI: allowed, checked 2026-11-04 (the free allocation is not a trial; model
  licences apply, FLUX.1-schnell is Apache-2.0). A re-check on 2026-11-05 did not find the Workers
  AI section quickly, so the earlier check stands: **re-verify before the first real sale**.
- Groq, OpenRouter, Gemini, Cerebras: unverified, sandbox only.

## D-033: Publishing through Printify: dry run first, two approvals, once only (2026-11-05)

- **Two approvals.** Accepting a package says the listing is good. A second Owner's Desk item,
  "Publish", says it may leave the station. The publish item states the mode, the price and the
  store's count against its daily cap.
- **Dry run by default.** `PRINTIFY_MODE=live` is needed to send writes; without a token every
  write (upload, create product, publish) is recorded and answered with a stable fake id, and the
  Etsy listing fee goes into the ledger as a simulated entry.
- **Once only.** Each external step is keyed by the approval id in an `outbox` table and returns
  the stored result when repeated. A package is marked published and cannot be published again.
- **Guards** (checked before every publish): kill switch off; store not paused; under the daily
  cap (`ORBITAL_PUBLISH_CAP`, default 3); package accepted; in live mode, a token, a shop id, the
  live lane, the product mapped to a blueprint, provider and variants, and a design generated in
  the live lane (sandbox images are never sold, D-001).
- **The API shapes** follow Printify's public docs (v1: `/shops.json`, `/catalog/...`,
  `/uploads/images.json`, `/shops/{id}/products.json`, `.../publish.json`, `/shops/{id}/orders.json`,
  Bearer token and a User-Agent). They are tested against a fake server only; check them with the
  real token (`npm run printify -- shops`) before the first live product.
- **Prices** go to Printify in cents, from the package's price.

## D-034: Etsy fields for AI-assisted print-on-demand (2026-11-05)

Etsy's Creativity Standards (https://www.etsy.com/legal/creativity/) put seller-prompted AI designs
printed by a partner in **"Designed by a seller"**; Printify's help centre says to choose that
option and set **Printify as the production partner** (otherwise the listing defaults to "Made by
seller"). The package's `listing.json` carries `creativity: designed_by_seller`, `whoMade: i_did`,
`whenMade: made_to_order` and the production partner, and the description keeps the AI and
production-partner disclosures (D-030).

## D-035: The Vault ledger (2026-11-05)

A `ledger` table holds signed amounts per business: sales positive; costs, fees and refunds
negative. `(source, ref, kind)` is unique, so syncing an order twice records it once. Entries from
dry runs and simulations are flagged `simulated` and never mixed into real totals. Printify order
lines become a sale (our listing price × quantity), a cost (Printify production and shipping) and
an estimated Etsy fee. Stage 10 builds the Vault's reports on it.

## D-036: Tuning from the real runs: models that think, rate limits, dead endpoints (2026-11-05)

Real listing runs showed where the free tiers hurt, and each fix is data or a small rule:

- **Reasoning models** (Mistral Large 4 and the Nemotron VL model on NVIDIA) write a long hidden
  `<think>` block before answering. A tight `maxTokens` cut them off mid-thought and forced a
  retry with a bigger budget. Structured factory calls now ask for up to 4,000 tokens (vision QA
  2,000, the IP screen 1,500); models that don't think stop early anyway.
- **A truncated reply that already holds valid JSON is accepted** instead of being retried.
- **The creative tier** puts Groq's qwen3.8-27b first in the sandbox: structured calls took 0.4 to
  1 s there against 60 to 150 s on Mistral Large, with good copy. Mistral stays as the fallback.
- **Provider output caps** (`limits.maxTokens`, Groq 1,500): Groq's free tier counts the
  requested `max_tokens` against its tokens-per-minute limit and answered a burst with 429s.
- **The server's request timeout** is 3 minutes for background work (was 2).
- **A dead image endpoint** (NVIDIA's FLUX function failing with "nvcf-status: errored") is benched
  for an hour after one failure, instead of costing 32 seconds on every image.
- **Redaction** now also hides `org_…` organization ids (Groq puts them in 429 messages), D-008.

## D-037: The Thumbnail Studio (2026-11-05)

- **Pipeline as code** (like D-029): one structured model call for three concepts, then image
  tools. Each concept has an angle (curiosity, emotion, contrast), a hook of at most five words, a
  scene (background only, no text or people), a subject, the text side and two colours.
- **Layout:** the scene fills 1280×720; a translucent band sits behind the hook on its side; the
  subject (the client's cut-out photo, or one generated subject shared by all three) fills the
  other side; the hook is upper-case display type, auto-fitted to three lines, with a black stroke
  and drop shadow, plus an accent bar.
- **Readability** is measured, not guessed: the WCAG contrast ratio between the hook colour and the
  average of the scene behind it (at least 3:1), the hook's height at phone size (at least 6 px at
  168×94), five words at most, and vision QA reading the hook. Failing checks are reported per
  thumbnail; they do not block the delivery (the owner decides).
- **Revisions** reuse each background unless the note mentions the scene or background, so a text
  or colour fix costs one model call and no image calls.
- **Client photos** are cut out once and reused; the brief keeps only a flag that a photo exists.
- **Jobs** are saved in the store and survive restarts; an interrupted job is marked failed.
- **Gig kit:** honest copy (AI-assisted, designer-finished, no promised views or click-through)
  and up to six portfolio thumbnails chosen by QA.

## D-038: The Asset Forge makes packs from sprite sheets (2026-11-05)

- **Sheets, not single icons.** One image call asks for about 12 items on a flat magenta
  background with the pack's locked style prompt and a fixed seed per sheet. Items from the same
  sheet share a style, and a 32-icon pack costs about 3 or 4 images instead of 32 or more (the
  free Cloudflare allocation is about 170 images a day).
- **Cutting items out:** chroma key on magenta, then 8-connected components; boxes closer than
  about 1% of the sheet are merged (sparkles stay with their item); specks, slivers and anything
  spanning most of the sheet are dropped. Items come back in reading order.
- **Consistency by construction:** each item is area-averaged down to the pack size (minus the
  outline), snapped to one palette built by median cut over every item, centred, and given a
  1-pixel outline (dark, or the palette's darkest colour).
- **Review:** the vision model sees a numbered contact sheet, scores consistency, lists outliers
  (style breaks, fragments, duplicates) and names every icon; outliers are replaced from the spares
  (each pack makes about 12% extra). Without the review model the pack still ships, with score 0.
- **Licence** (a default for the owner to adjust): use in commercial and non-commercial projects,
  modify, no attribution needed; no reselling or redistributing the assets themselves, no AI
  training; AI generation disclosed.
- **itch.io:** the page copy marks AI-generated graphics (itch.io asks asset pages to disclose it).
  Uploading is `butler push <zip> <user>/<game>:<channel>` behind its own approval; without
  `BUTLER_PATH` and `ITCH_TARGET` it is a dry run that records the command. The kill switch
  blocks uploads too.

## D-039: The Vault and the learning loop (2026-11-05)

- **Real and simulated money never mix.** Every ledger entry is flagged; the Vault shows real
  money by default and the simulated week only on request, labelled as not real. The monthly goal
  and the $1T meter use real net profit only.
- **KPIs** come from what the station already records: the tasks table (real work only), the
  Owner's Desk decisions, image QA results and the `llm_calls` log. Shadow cost multiplies tokens
  and images by assumed paid prices per tier in `config/vault.yaml` (assumptions, not quotes).
- **The simulator** gives each listing a fixed appeal and each store a base demand from a seeded
  generator, so a week is repeatable and stores really differ; conversion falls with price and
  rises with the design's QA score. Fiverr gigs and itch.io packs get a few orders too.
- **The retro proposes; the owner disposes.** WARDEN's plan is clamped (0 to 5 listings a day,
  price multipliers 0.8 to 1.2, at most four experiments, at most two crew moves, never the
  Overseer or the reviewer) and applied only when the owner accepts it at the Desk. Lessons go to
  the strategy memory, marked when they come from simulated sales.
- **Experiments** last seven days. Price experiments multiply Factory 1's computed price before
  the cents ending; title and niche experiments add one instruction to the copy and Scout prompts.

## D-040: Always-on without installing a service (2026-11-05)

`scripts/supervise.mjs` keeps the server alive: restart with exponential back-off (2 s to 60 s,
reset after 10 minutes up), a health check every minute (three failures restart it), and daily log
files kept for 14 days. A plain script keeps the machine untouched; the owner chooses Task
Scheduler or pm2 to start it at log-on. Backups use SQLite's online backup API (consistent while
the station writes) and mirror the immutable artifact files incrementally; 7 database copies are
kept, at 03:00 by default, in `ORBITAL_BACKUP_DIR` when set.

## D-041: Phone approvals through Telegram (2026-11-05)

A Telegram bot was chosen over a Discord webhook because webhooks cannot carry buttons back to the
station. The bot long-polls `getUpdates` (no inbound port or public webhook), sends each new
pending Desk item with two inline buttons whose data is just `approve:<id>` or `reject:<id>`, and
decides only presses from the configured chat id and, when set, the allowed user ids. Messages are
held during quiet hours and summarized afterwards. The token lives in `.env` and is scrubbed from
any logged error.

## D-042: An access token before any remote access (2026-11-05)

With `ORBITAL_TOKEN` set, every `/api` and `/ws` request needs `Authorization: Bearer <token>` or
`?token=` (WebSocket, images and downloads can't send headers); the comparison is constant-time;
`/api/health` stays open so the supervisor can check it. The client takes the token from the
address once, keeps it in local storage and removes it from the address bar. The server still
binds to 127.0.0.1; reaching it from elsewhere goes through Tailscale or Cloudflare Tunnel with
Access in front (docs/OPERATIONS.md).

## D-043: Polish that costs nothing (2026-11-05)

- **Day and night:** a multiply-blended tint over the map by local time (blue at night, warm at
  dawn and dusk), under the panels.
- **Sounds** are synthesized with Web Audio (no assets): a two-tone ping for a new Desk item, a
  soft chime for finished real work, a low buzz when a crew member is stuck. Muted in quiet hours
  and by a toolbar toggle remembered per browser.
- **Banter:** an engine option (on for the server and the offline client, off for seeded tests)
  that now and then has two crew members in the café or on the Bridge swap a scripted exchange,
  drawn from its own random stream so the rest of the simulation is unchanged.
- **Achievements** are checked every minute from what the station records (first package, first
  publish, first thumbnails, first pack, first weekly plan, first real sale, 100 real tasks) and
  announced by WARDEN once.

## D-044: The FreeLLMAPI pool serves the sandbox lane (2026-11-05)

The owner asked to run the agents on a pool of free API keys (FreeLLMAPI,
https://github.com/tashfeenahmed/freellmapi, MIT): a self-hosted Docker router that puts up to 34
providers' free tiers behind one OpenAI-compatible endpoint and one key, with per-key rate
tracking and failover.

- **Sandbox only, enforced.** Its README says "for personal experimentation and learning, not
  production", and it chooses the upstream per request, so no single provider's terms can be
  checked for a given answer. `providers.yaml` gives it `lanes: [sandbox]` and
  `production: forbidden`; config validation refuses it in the live lane (D-032).
- **First choice in the sandbox:** `freellm:auto:smart` for reasoning, `freellm:auto` for
  creative, `freellm:auto:fast` for fast, and `freellm:auto` as the second vision choice (it routes
  image requests to vision models). Our own providers stay behind it as fallbacks, and the router
  skips it while `FREELLM_API_KEY` is unset.
- **Not for embeddings:** the pool's embedding families have different dimensions from ours, and
  vectors from different families must never share a memory store.
- **Auditable:** the transport keeps the gateway's `X-Routed-Via` header and `llm_calls` stores it
  (`routed_via`), so every answer can be traced to the upstream that produced it.
- **Install:** `infra/freellmapi/docker-compose.yml` pins the image to a release, publishes on
  127.0.0.1 only, builds nothing locally and leaves out the Watchtower sidecar (it needs the Docker
  socket). The encryption key is generated into a git-ignored `.env` beside it. Signing up for
  provider keys, pasting them into the pool's dashboard and copying the unified key into `.env`
  are the owner's steps.

## D-045: Groq joins the live lane; Cloudflare re-checked before the first sale (2026-11-05)

The owner asked to go to production. The live lane had only Cloudflare's free 10,000 neurons a day,
so the terms of the providers we already use were checked again.

- **Groq: allowed.** The Groq Services Agreement (updated 2026-06-22) covers fee-free use, leaves
  all rights in inputs and outputs with the customer, bars Groq from training on them, and applies
  each hosted model's own terms. Groq's model list marks some models "preview", for evaluation
  only, so only its production models serve the live lane: `openai/gpt-oss-120b` (reasoning,
  creative) and `openai/gpt-oss-20b` (fast), both Apache-2.0. `qwen/qwen3.8-27b` is a preview
  model and stays in the sandbox. Groq also lists `llama-3.3-70b-versatile` and
  `llama-3.1-8b-instant` as production models, but both answer 404 for this account (census,
  2026-11-05).
- **Free plan limits** (checked 2026-11-05): per model, 30 requests a minute, 1,000 a day, 8,000
  tokens a minute and 200,000 a day. Our gate: 25 a minute and 2,500 a day across models, with
  1,500 output tokens a call.
- **Cloudflare: still allowed.** Its Developer Platform terms (updated 2026-09-28) put no limit on
  commercial or production use; the customer is responsible for outputs and follows each model's
  licence and acceptable use policy; Cloudflare doesn't train on customer content. This was the
  owner's "re-verify before the first sale" item (D-032).
- **Licences of the live models:** gpt-oss, Mistral Small 3.1 and FLUX.1-schnell are Apache-2.0.
  The Llama 3.x and 4 models on Cloudflare carry Meta's community licences, which allow commercial
  use below 700 million monthly users. Llama 3.2 Vision still waits for the owner (D-012).

## D-046: Production mode (2026-11-05)

`ORBITAL_MODE=production` in `.env` runs the station for real; anything else is development.

- **Every model call uses the live lane:** WARDEN, the crew, the three factories, QA, the IP screen,
  memory and the weekly retro. NVIDIA's trial terms forbid production use of the service itself,
  not just selling its output, and the FreeLLMAPI pool says it is not for production, so neither
  takes part. Text runs on Groq first with Cloudflare behind it; images, vision and embeddings run
  on Cloudflare.
- **No invented work.** Crew on autopilot no longer make up ambient tasks. Without real work they
  stand easy in their rooms, and WARDEN doesn't nudge them. Invented tasks from earlier runs are
  left out when the station restores (they stay in the database).
- **No simulated sales.** The simulator and retros on simulated sales are refused (HTTP 409), and
  the Vault hides them. Experiments now record whether they came from simulated sales, and
  production follows only those that didn't; older experiments carry no mark, so production
  ignores them too. Lessons tagged "simulated" are left out of memory searches in the live lane.
- **Memory across lanes.** The two lanes embed with different models, so vectors of a different
  length are never compared; those memories fall back to keyword search.
- **Approvals are unchanged.** Every external action still waits for the owner (D-002, D-033).
  `PRINTIFY_MODE=live` sends real writes once `PRINTIFY_API_TOKEN` and `PRINTIFY_SHOP_ID` are set;
  until then the publish guard says what is missing.
- **Capacity.** Images are the bottleneck: Cloudflare's 10,000 neurons a day (about 170 images) are
  shared by the three factories. Text has Groq's per-model daily budgets with Cloudflare behind
  them. Development keeps the large free sandbox (the pool, NVIDIA), and its output never mixes
  with production's. On 2026-11-05 the allocation ran out after 36 images, well short of the
  estimate, so expect a few listings a day rather than dozens.
- **A spent image budget waits.** While the lane's image endpoints are benched for the day, the
  Etsy autopilot doesn't start listings (each needs images) instead of failing one every 30
  minutes. A restart reads the usage log, so an allocation already spent today stays benched until
  00:00 UTC.

## D-047: No multimodal Llama models in the live lane (2026-11-05)

Meta's licences for its multimodal models (Llama 3.2 Vision, the Llama 4 family) grant no rights
to individuals or companies based in the European Union. The station's machine runs on Western
European time, so the owner may well be in the EU: `llama-4-scout` and `llama-3.2-11b-vision` leave
the live vision list (this also settles D-012 for the live lane). Live vision runs on Mistral Small
3.1 (Apache-2.0) alone. Gemma 3 (commercial use allowed) would be the backup, but this Cloudflare
account gets 403 for it. The text-only Llama 3.x models carry no such restriction and stay. If the
owner is not in the EU, the two models can come back after a note here.
