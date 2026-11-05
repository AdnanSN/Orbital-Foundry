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
