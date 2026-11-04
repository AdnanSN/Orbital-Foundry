# Orbital Foundry: Master Plan & Roadmap

> **Working title.** An always-on pixel-art space station where AI agents live, run small online
> businesses, and answer to an Overseer. You watch and steer it from your browser.
>
> Written 2026-11-04. Facts about providers and marketplaces were checked that day (sources in §13).
> Re-check anything more than a few months old before relying on it.

**To resume in any session, say:** "Read `docs/ROADMAP.md` and start Stage N."
At the end of each stage: tick its boxes, add a line to the Session Log (§14), and commit.

## Status

| # | Stage | Size | Status |
|---|---|---|---|
| 0 | Prep: keys, folder, decisions | you, ~30 min | ✅ done (NVIDIA, Cloudflare and Groq keys set) |
| 1 | Foundation & model router | 1 session | ✅ done, except NVIDIA image generation (down on NVIDIA's side) |
| 2 | The station: visuals with a mock crew | 1 session | ✅ done (`npm run client`) |
| 3 | Sim engine, persistence, realtime link | 1 session | ☐ |
| 4 | Agent brains: runtime, Overseer, task board | 1–2 sessions | ☐ |
| 5 | Creative toolchain (images, upscale, QA) | 1 session | ☐ |
| 6 | Factory 1: Etsy POD studio (sandbox) | 1 session | ☐ |
| 7 | Go live: Printify → Etsy | 1 session | ☐ |
| 8 | Factory 2: Thumbnail studio | 1 session | ☐ |
| 9 | Factory 3: Asset forge | 1 session | ☐ |
| 10 | Economy, KPIs, learning loop | 1 session | ☐ |
| 11 | Always-on ops & polish | 1 session | ☐ |

Dependencies run in order through Stage 7. Stages 8 and 9 depend only on Stage 5 (and 4), not on
each other, so they can run as parallel sessions. Stage 11 can start any time after Stage 4.

---

## 1. What we're building

| In the reel | Our version |
|---|---|
| AI agents "placed" into a space-station game | An original 2D pixel-art station in the browser. You hire agents from role templates and drag them into rooms. |
| "Ultron", a Hermes agent on GPT-5.5, keeps everyone working | **The Overseer** (default name WARDEN) runs on the strongest free reasoning model. It plans, assigns, reviews, nudges idle agents and escalates to you. |
| Factory room 1: three Etsy print-on-demand stores | **Etsy POD Studio**: niche research → designs → print-ready files → listings → Printify → Etsy |
| Factory room 2: a Fiverr YouTube-thumbnail service | **Thumbnail Studio**: a brief becomes 3 thumbnail variants in minutes; you handle Fiverr itself |
| Selling 2D game assets on marketplaces | **Asset Forge**: themed sprite and icon packs for itch.io and others |
| A money counter toward $1T | **The Vault**: a real ledger plus a (very) long-term goal meter |

What makes it more than a dashboard is that every animation is driven by a real event:

- an agent typing at a terminal is a real LLM call;
- the image on its holo-screen is the real output;
- a walk to the café is a real rate-limit back-off.

## 2. Reality check & ground rules

- **The reel's numbers are self-reported.** Etsy POD is crowded, and Etsy tightened its AI and POD
  rules in 2026: AI disclosure, "Designed by" labelling, and disclosure of the production partner.
  Shops mostly get suspended for IP/trademark hits and spammy volume. So the Overseer optimizes for
  quality and niche fit, caps listings per day, and screens every design for IP.
- **You stay in the loop.** Anything that publishes, messages a customer or spends money goes through
  your approval inbox, the **Owner's Desk**. Once you trust an action type you can relax this for it.
- **No ToS-breaking automation.** Fiverr has no seller API and bans bots, so Fiverr stays manual: the
  studio does the work and you deliver it. Marketplace AI-disclosure rules are applied automatically.
- **Sandbox first.** Every pipeline is built and tested in Sandbox Mode before any real listing goes live.

## 3. Free-model strategy: two lanes (important)

**The key finding, from the primary source.** NVIDIA's free API on build.nvidia.com is a *trial*. Its
terms allow use only *"without use of the API Service or Generated Content in production"*. §4.2 also
forbids selling or distributing Generated Content, and NVIDIA may use your prompts and outputs to improve
its models.

So NVIDIA is ideal for building, testing and running the simulation in **Sandbox Mode**. Anything we
**sell or deliver** has to come from providers whose terms allow production use.

The model router enforces this with **lanes**:

- **Sandbox lane:** development, tests, model and prompt evaluation, demo runs. Outputs are never sold.
  Any provider is allowed, and NVIDIA is the main one.
- **Live lane:** anything that reaches real customers or marketplaces. Only providers tagged
  `production: allowed` in `config/providers.yaml` can be used. The code refuses anything else.

| Provider | Free allowance (as reported, Nov 2026) | Lane | Notes |
|---|---|---|---|
| NVIDIA NIM (build.nvidia.com) | ~40 req/min (reports say 30–40) | Sandbox only | 85 models listed, but only 7 chat models answered for this account on 2026-11-04 (D-007); its FLUX endpoint is failing on NVIDIA's side; OpenAI-compatible API |
| Cloudflare Workers AI | 10,000 neurons/day, reset at 00:00 UTC | Live ✅ | FLUX.1-schnell (Apache-2.0) ≈ 58 neurons per 1024² image at 4 steps, so **~170 free images/day**. Small vision models are cheap; the big LLMs need a paid plan. |
| Groq | ~30 req/min, ~1K req/day per model (varies) | Live (verify terms in Stage 7) | Very fast. Terms reportedly prohibit consumer use and rule out training on your data. |
| Google Gemini API (free quota) | Small (cut in Dec 2025); image models now paid-only | Live, with caveats | Free-tier content is used to improve Google products. Apps serving the EEA, UK or Switzerland must be on paid. |
| OpenRouter `:free` models | ~20 req/min; the daily cap rises after a one-time $10 credit purchase | Case by case | The upstream provider's terms apply, and some free endpoints log prompts |
| Local (your RTX 3050, 6 GB) | Unlimited | Live ✅ (subject to model license) | Certain: 4× upscaling and background removal. Fallbacks: a small local LLM (7–8B) and slow local image generation. |

**Default model tiers.** The catalog changes fast, so the router doesn't hardcode models. It reads a config
generated by the Stage 1 *model census*, which tests each candidate for chat, JSON output, tool calling,
vision and latency. Starting candidates:

| Tier | Used for | Sandbox candidates (NVIDIA live catalog, 2026-11-04) | Live candidates |
|---|---|---|---|
| `reasoning` | Overseer planning, reviews, research synthesis | `moonshotai/kimi-k2.6`, `nvidia/nemotron-3-super-120b-a12b`, `deepseek-ai/deepseek-v4.1-flash`, `mistralai/mistral-large-4-1t-a52b` | Groq's strongest model; local fallback |
| `creative` | Listing copy, design concepts, image prompts | `writer/palmyra-creative-122b`, `z-ai/glm-5.3-flash`, `google/gemma-4-31b-it` | Groq; Gemini free |
| `fast` | Classification, tagging, status lines | `nvidia/nemotron-3.5-lightning-30b-a3b`, `openai/gpt-oss-20b`, `nvidia/nemotron-3.5-bolt-e4b` | Groq small models; local 7–8B |
| `vision` | Image QA, readability checks | `nvidia/nemotron-3.5-super-vl-120b-a12b`, `meta/llama-3.2-90b-vision-instruct` | Cloudflare `llama-3.2-11b-vision`; local VLM |
| `image` | Designs, scenes, assets | `black-forest-labs/flux.1-schnell` (NVIDIA genai endpoint) | Cloudflare `@cf/black-forest-labs/flux-1-schnell` |
| `embed` | Memory search | `nvidia/nemotron-3.5-embed-1b` | Cloudflare bge; local |
| `safety` | Content and policy screening | `nvidia/nemotron-3.5-content-safety`, `meta/llama-guard-4-12b` | Cloudflare or local guard model |

These were the starting candidates. Since the first real runs, the working lists live in
`config/tiers.yaml` (DECISIONS D-007), and `npm run census` keeps them honest.

**Budget math.** While busy, a station of about 9 agents makes roughly 10–30 LLM calls a minute. The router
queues calls per provider (on screen, agents wait in line at the terminal), so the free limits are
workable. If the live text lane turns out too thin, the fallback is a few dollars a month on a cheap
paid API once revenue exists. With the router, that is a config change.

## 4. Architecture

```
┌──────────────────────────── Browser (Vite) ────────────────────────────┐
│  Phaser: station map · crew sprites · pathfinding · bubbles · effects  │
│  React overlay: inspector · task board · Owner's Desk · Vault · logs   │
└───────────────▲───────────────────────────────────────┬────────────────┘
                │ WebSocket: snapshot + events          │ REST: commands
┌───────────────┴───────────────────────────────────────▼────────────────┐
│  Node 22 server (TypeScript, Fastify)                                  │
│   Sim engine ··· world state, clock, logical positions, activities     │
│   Orchestrator · Overseer loop, objectives → tasks, scheduler          │
│   Agent runtime  role templates, tool loop, memory, retries            │
│   Tool belt ···· image gen · upscale · cutout · compose · QA · research│
│   Businesses ··· Etsy POD · Thumbnail Studio · Asset Forge             │
│   Approval gate  every external side effect → Owner's Desk             │
│   Model router · lanes, tiers, rate limits, fallbacks, usage log       │
│   Event bus ···· append-only event log → WebSocket broadcast           │
│  SQLite (Drizzle) + data/artifacts/ (images, packs, listing packages)  │
└───────┬────────────────────────┬────────────────────────────┬──────────┘
        │ OpenAI-compatible HTTP │ local binaries             │ marketplace APIs
        ▼                        ▼                            ▼
  NVIDIA · Cloudflare ·    Real-ESRGAN (GPU) ·          Printify → Etsy ·
  Groq · Gemini ·          rembg · Ollama (optional)    Etsy API (read) ·
  OpenRouter                                            itch.io butler
```

**Tech stack** (defaults; §11 lists what you can change):

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language and shared types between client and server |
| Server | Node 22 + Fastify + ws | Already installed; mature on Windows |
| LLM layer | `openai` SDK as a generic OpenAI-compatible client (DECISIONS D-003) | Every provider we use speaks this API; our router owns lanes, limits and fallbacks |
| Database | SQLite via better-sqlite3 with plain SQL migrations (Drizzle decided in Stage 3) | Zero-ops, a single file, easy backups |
| Game | Phaser (latest stable at scaffold time) | Tilemaps, animation, cameras, input |
| UI overlay | React + Tailwind | Panels, forms, kanban |
| Image processing | @napi-rs/canvas, sharp, image-q | Text compositing, resizing, palette quantization |
| Local GPU tools | Real-ESRGAN-ncnn-vulkan, rembg (via uv) | Free 4× upscaling and background removal |
| Tests | Vitest + a mock LLM provider | Deterministic simulation tests |
| Lint/format | Biome | One fast tool |

**Repo layout:**

```
orbital-foundry/
├─ apps/
│  ├─ server/        sim, orchestrator, agents, tools, router, API
│  └─ client/        Phaser station + React overlay
├─ packages/shared/  zod schemas, event types, map + role definitions
├─ config/           providers.yaml, roles/*.yaml, businesses/*.yaml, models.census.json
├─ data/             SQLite DB + artifacts (git-ignored)
├─ docs/             ROADMAP.md, DECISIONS.md, screenshots
├─ CLAUDE.md         how to run + conventions (for future sessions)
└─ .env              API keys (git-ignored; .env.example is committed)
```

**Why build instead of reuse?** Existing pixel-office visualizers (Pixel Agents, Clawffice, PixelFloor)
show *coding* agents at desks. None of them runs businesses, lanes or approvals. We build our own station
with original art and borrow only ideas, such as character state machines and grid pathfinding.

## 5. The station

```
 ┌────────────┐  ┌──────────────┐  ┌────────────┐
 │ RESEARCH   │  │ OWNER'S DESK │  │ SERVER     │
 │ LAB        │  │ (approvals)  │  │ ROOM       │
 └─────┬──────┘  └──────┬───────┘  └─────┬──────┘
 ┌─────┴──────┐  ┌──────┴───────┐  ┌─────┴──────┐
 │ FACTORY 1  │══│   COMMAND    │══│ FACTORY 2  │
 │ Etsy POD   │  │   BRIDGE     │  │ Thumbnail  │
 │ (3 stores) │  │  (Overseer)  │  │ Studio     │
 └─────┬──────┘  └──────┬───────┘  └─────┬──────┘
 ┌─────┴──────┐  ┌──────┴───────┐  ┌─────┴──────┐
 │ QA BAY     │  │ VAULT        │  │ FACTORY 3  │
 │            │  │ (ledger)     │  │ Asset Forge│
 └────────────┘  └──────┬───────┘  └────────────┘
         ┌──────────────┴────┐  ┌───────────┐
         │ CREW CAFÉ         │  │ AIRLOCK   │
         │ (breaks, limits)  │  │ (hiring)  │
         └───────────────────┘  └───────────┘
```

**Starting crew** (about 9 agents; hire more any time):

| Agent | Room | Job | Tiers |
|---|---|---|---|
| WARDEN (Overseer) | Command Bridge | Sets daily objectives, assigns, reviews, nudges, escalates | reasoning |
| Scout | Research Lab | Niches, keywords, seasonality, competition | reasoning |
| Wick, Gift, Frame | Factory 1 | One operator per Etsy store: design + list | creative, image |
| Flash | Factory 2 | Thumbnail concepts and compositing | creative, image, vision |
| Forge | Factory 3 | Game-asset packs | creative, image |
| Lens | QA Bay | Vision QA, IP screening, policy checks | vision, reasoning |
| Ledger | Vault | Revenue sync, fees, KPIs, reports | fast |

**What you see, and what's really happening:**

| On screen | Real event |
|---|---|
| Typing at a terminal, with a speech bubble | An LLM or tool call is running; the bubble is its status line |
| An image on a holo-screen | A real generated image |
| A walk to the café with a coffee | Provider rate limit or back-off |
| Sparks on a Server Room rack | A provider is down, or its circuit breaker is open |
| A red alert light over an agent | A task failed or needs help |
| Waiting at the Owner's Desk with ❗ | An approval is waiting for you |
| A coin burst and a cha-ching in the Vault | A real sale was recorded |
| The Overseer walks over: "Back to work." | An idle or stuck agent was detected and reassigned |
| A new crew member enters through the airlock | You hired an agent |

**Art direction.** Original pixel art made in code: 16×16 crew sprites defined as pixel matrices with
palette swaps, plus procedural floors, walls, consoles and starfield windows. No third-party art is
needed. Later we can swap in a CC0 tileset or let the Asset Forge generate the station's decor.

## 6. Agent system

**Task lifecycle:**

```
objective → tasks (Overseer) → assigned → in_progress → review (Lens/Overseer)
          → rework ↺ (max 2) → awaiting_approval (only if external) → done
          → failed → escalated to you
```

**The agent work loop:**

1. Pick the highest-priority task for its role, or ask the Overseer for one.
2. Walk to a workstation (visual only) while loading context: the task, memories, and its role playbook.
3. Run the tool loop (AI SDK, about 8 steps maximum, outputs validated with zod).
4. Save artifacts, submit for review, and walk to the QA Bay or the Bridge.
5. If rejected, read the feedback and retry. After repeated failures, escalate.

**The Overseer loop** runs every ~10 minutes, and also on events:

- **Morning:** read KPIs and yesterday's results, then set today's objectives for each business.
- **Continuously:**
  - assign tasks by role and load;
  - catch idle or stuck agents and nudge or reassign them;
  - review deliverables, or delegate the review to Lens;
  - escalate blockers to you.
- **Evening:** post a standup summary to the event log. A weekly retro updates the strategy memory.

**Tools carry metadata that the runtime enforces:**

```ts
defineTool({
  name: "printify_publish",
  sideEffect: "external",   // none | internal | external
  lane: "live",             // which lane may run it
  approval: "always",       // always | policy | never
  input: z.object({ productId: z.string() }),
  run: async (input, ctx) => { /* ... */ },
});
```

- `external` tools never run directly. Calling one creates an approval request with a preview. The tool
  runs only after you approve it, and with an idempotency key.
- Untrusted text, such as customer briefs and fetched web pages, is wrapped and flagged. An agent cannot
  trigger an external action from it without your approval.

**Memory:**

- **Short-term:** a rolling task context plus recent events.
- **Long-term:** per-agent and per-business notes stored with embeddings in SQLite, for example "dark
  academia candles: 3 sales in week 1" or "neon text fails QA at small sizes".
- **Playbooks:** a markdown procedure per role (for example `etsy-listing.md`). The Overseer can
  propose edits, and you approve them.

**Reliability:**

- retries with backoff;
- provider fallback chains and circuit breakers;
- JSON repair for malformed output;
- per-agent daily call budgets;
- kill switches per business and for the whole station.

## 7. Business pipelines

### 7.1 Factory 1: Etsy POD Studio

1. **Scout** proposes niches and keywords from a seasonal calendar, LLM research and, optionally,
   competition counts from the Etsy API.
2. **Operator** turns a concept into 4–8 image prompts and generates them. Lens picks the best one by
   vision QA, and weak ones are reworked.
3. **Production:**
   - upscale 4× with Real-ESRGAN;
   - remove the background, or keep a full-bleed design;
   - fit to the blueprint's print area, using sizes from Printify's catalog.
4. **Listing:**
   - title of at most 140 characters;
   - 13 tags of at most 20 characters each;
   - description and attributes;
   - price from cost plus a target margin.
5. **Compliance:**
   - IP/trademark screen: blocklist + LLM + safety model;
   - AI disclosure ("Designed by" + the AI flag);
   - production-partner disclosure;
   - honest mockups.
6. **Owner approval.** In Sandbox Mode this exports a listing package. In Live Mode it creates the
   product in Printify and publishes it to Etsy.
7. **Sync.** Orders and revenue flow to the Vault, and listing stats go into Scout's memory.

### 7.2 Factory 2: Thumbnail Studio

1. **Intake form:** video title or topic, channel style, optional face photo, references.
2. **Flash** writes 3 concepts (curiosity, emotion, contrast), each with a hook of 5 words or fewer.
3. A 16:9 scene or background is generated, and the subject is cut out of the client's photo.
4. Text is composited with stroke and shadow, using bundled open-license fonts and the brand colors.
5. **Lens** checks readability at mobile size (~168×94), plus contrast and clutter.
6. **Delivery:** three 1280×720 images and layered sources in a ZIP, with a revision loop driven by
   your feedback.
7. **Gig kit:**
   - gig title, description, FAQ and pricing tiers;
   - a portfolio set.

   Fiverr itself stays manual: there's no seller API, bots break its ToS, and Fiverr removes AI work that
   infringes IP.

### 7.3 Factory 3: Asset Forge

1. **Pack plan:**
   - theme and item list;
   - size (16, 32 or 64 px);
   - style guide (palette, outline, light direction).
2. Batch generation on a flat chroma background, with a locked style prompt and fixed seeds.
3. Chroma key → nearest-neighbor downscale → palette quantization → outline cleanup.
4. **Lens** checks style consistency across the pack, and outliers are regenerated.
5. **Package:** a ZIP with:
   - individual PNGs and a sprite sheet;
   - a preview PNG/GIF;
   - LICENSE.txt and a README.
6. Store copy with the mandatory AI-generated tag (itch.io requires disclosure for assets), then
   approval, then `butler push`.

## 8. Data model & protocol (summary)

**Tables:**

- `agents`, `rooms`, `businesses`, `objectives`, `tasks`
- `events` (append-only), `artifacts`, `approvals`, `ledger`
- `llm_calls`, `memories`, `kv`

**WebSocket messages (server → client):**

- `snapshot`
- `agent.spawned`, `agent.moved {from, to, t0}`, `agent.activity`, `agent.say`
- `task.updated`, `artifact.created`, `approval.requested`, `ledger.entry`
- `provider.status`, `alert`

Stage 2 defines the first seven as zod schemas in `packages/shared/src/station/events.ts`, each
with a sequence number and a sim time. The client's mock director emits them today. The other
four join the union in the stages that produce them (DECISIONS D-016).

**REST commands (client → server):**

- `POST /agents` hires an agent; `PATCH /agents/:id` reassigns its room.
- `POST /objectives` adds an objective.
- `POST /approvals/:id/decide` approves or rejects.
- `POST /sim/pause` and `POST /sim/resume`.
- `POST /businesses/:id/kill-switch`.

**Positions.** The server owns the logical state: room, station and activity. Clients run the same
deterministic pathfinding and animate locally. That keeps bandwidth low and every open tab in sync.

---

## 9. Stages

Every stage ends with green tests, a demo you can see, updated docs and a git commit.

### Stage 0: Prep (you, ~30 min, no code)

- [x] Pick the project folder: `C:\Users\adnan\dev\New folder`.
- [x] Get an NVIDIA API key: build.nvidia.com → sign in → API Keys → Generate (`nvapi-…`).
- [x] Set up Cloudflare (free): note your Account ID, then create an API token with Workers AI permission.
- [x] Optional fallbacks: Groq is set. OpenRouter, Gemini and Cerebras are not needed yet.
- [ ] If you plan to go live on Etsy: apply for an Etsy developer app now, since review can take a while.
- [x] Confirm or change the decisions in §11. All defaults were kept (DECISIONS D-002).

Keys go in `.env`. I'll create `.env.example` in Stage 1, so there's no need to paste keys in chat.

### Stage 1: Foundation & model router (1 session)

**Goal:** a clean monorepo, and one call that reaches any free model in the right lane.

- [x] `git init`, with npm workspaces for `packages/shared` and `apps/server`. `apps/client` arrives
      in Stage 2.
- [x] Tooling: TypeScript 7 (strict), Biome 2 and Vitest 5.
- [x] Project files: `.env.example`, `CLAUDE.md`, `README.md` and `docs/DECISIONS.md`.
- [x] `config/providers.yaml` (lanes, budgets, terms notes) and `config/tiers.yaml` (candidates).
- [x] Router: `router.generate({ tier, lane, system?, prompt?, messages?, schema?, tools? })` and
      `router.embed()`.
  - Skips models that the census marked as failing a needed capability.
  - Per-provider `ProviderGate`: sliding-window requests per minute, a daily budget, a concurrency
    cap, and a cooldown after 429.
  - Falls back down the chain, prefers a less busy provider, and opens a circuit breaker after
    repeated failures.
  - Repairs invalid JSON once, and retries without a system message for models that reject one.
  - Logs every call (tokens, latency, outcome) to SQLite.
- [x] `ImageService`: NVIDIA FLUX.1-schnell (sandbox only) and Cloudflare FLUX.1-schnell (sandbox and
      live).
- [x] `npm run census`: probes chat, JSON, tools, vision and embeddings; writes
      `config/models.census.json`; prints a scorecard and each tier's first choice.
- [x] `npm run smoke`: one call per tier, plus JSON, tools, vision and embeddings checks, and one image
      per endpoint saved to `data/artifacts/smoke/`.
- [x] `npm run models -- <provider> [filter]`.

**Done when:**

- [x] the census shows at least one working model per tier on NVIDIA: Nemotron-3 Ultra (reasoning),
      Mistral Large 4 (creative), Nemotron-3.5 Lightning (fast), Nemotron-3.5 Super VL (vision) and
      Nemotron-3.5 Embed (embed).
- [ ] the smoke test saves FLUX images from both NVIDIA and Cloudflare. **Cloudflare works** (about
      3 s per image). NVIDIA's FLUX function fails on NVIDIA's side (HTTP 504, `nvcf-status:
      errored`), so sandbox images use Cloudflare until it recovers (DECISIONS D-011).
- [x] unit tests for the limiter, fallback and lane enforcement pass (59 tests).
- [x] the first commit is made (`5ea5d6c`).

**You provide:** the NVIDIA key and the Cloudflare token and Account ID, in `.env`.

### Stage 2: The station, with a mock crew (1 session)

**Goal:** the "wow" moment: a living station on screen before any AI is wired in.

- [x] `apps/client`: Vite 8 + Phaser 4.2 + a React 19 overlay with Tailwind 4. `npm run client`
      starts it (DECISIONS D-013).
- [x] The station map from §5 as a JSON tile grid (`packages/shared/src/station/station.map.json`,
      58×55 tiles, 11 rooms; D-014):
  - walls, doors, corridors and consoles;
  - workstation anchor points and room labels;
  - starfield windows and blinking server racks.
- [x] Original 16×16 crew sprites drawn in code with palette swaps (D-018):
  - idle, 4-direction walk, typing and carrying animations;
  - name tags, speech bubbles and status icons.
- [x] Movement and camera:
  - A* grid pathfinding with smooth movement and furniture collision (shared with the future
    server, D-015);
  - camera pan and zoom (drag or WASD, wheel, Fit, follow a crew member).
- [x] Clicking an agent opens an inspector, and clicking a room opens a room panel (both with mock data).
- [x] A mock "director" script that generates fake events: work, deliver to QA, coffee break, Overseer
      patrol (D-016, D-017).

**Done when:** about 9 crew members animate believably at a smooth frame rate on your laptop, and a
screenshot is saved in `docs/`.

- [x] All 9 crew work, deliver, take café breaks for mock rate limits, and get nudged by WARDEN.
- [x] Frame rate: a real-time run in headless Edge on this laptop's Intel UHD GPU ran at 113–120 fps
      (the headless cap), with about 1 ms of work per frame and 95% of frames 9 ms apart or less.
- [x] Screenshots: `docs/stage-2-station.png` (the whole station) and `docs/stage-2-inspector.png`.
- [x] `npm run check` covers the client (lint, typecheck) and adds tests for the map layout,
      pathfinding, the director, the world model, the sprites and the font.

### Stage 3: Sim engine, persistence, realtime (1 session)

**Goal:** the station becomes real state on the server and survives restarts.

- [ ] A Fastify server with WebSocket, plus the SQLite schema and migrations from §8.
- [ ] Server-owned world state (rooms, agents, activities, clock). Clients animate from
      `agent.moved {from, to, t0}`.
- [ ] A snapshot when a client connects, then incremental events, with auto-reconnect and resync.
- [ ] REST commands: hire an agent, reassign a room, pause or resume.
- [ ] **Recruitment Bay**, the reel's "place an agent" mechanic: pick a role template, name the agent,
      and drag it onto a room. It walks in through the airlock.
- [ ] An event feed panel, and an inspector that shows live data.

**Done when:**

- restarting the server resumes the exact station;
- two browser tabs stay in sync;
- hiring works end to end.

### Stage 4: Agent brains (1–2 sessions)

**Goal:** agents do real work through the free models, and the Overseer runs the crew.

- [ ] Role templates in `config/roles/*.yaml`: system prompt, tools, tier, KPIs and schedule.
- [ ] Agent runtime:
  - the work loop from §6, with a step cap;
  - zod-validated outputs, retries and escalation;
  - status lines shown as speech bubbles.
- [ ] Tool framework with side-effect, lane and approval metadata. First tools:
  - notes, memory search and save;
  - create a subtask, ask the Overseer;
  - web research (allowlisted sites only);
  - submit for review.
- [ ] Overseer loop:
  - objectives → tasks → assignment;
  - idle and stuck detection, with nudges;
  - a review gate and a daily standup;
  - escalations to you.
- [ ] UI: a task board (kanban), the **Owner's Desk** approval inbox, and an objective input box.
- [ ] The game mappings from §5: café on rate limits, alert lights, ❗ at the desk.
- [ ] A mock LLM provider with recorded fixtures, for deterministic end-to-end tests.

**Done when:** you type an objective (for example "Find 10 winter candle niches and rank them") and
watch it get split up, worked on, reviewed and delivered. Rate limits are handled visibly, and the
tests pass.

### Stage 5: Creative toolchain (1 session)

**Goal:** the shared tools every factory needs.

- [ ] `generate_image`: picks a provider by lane; supports aspect ratios, seeds and a prompt library.
- [ ] `upscale`: Real-ESRGAN-ncnn-vulkan on your RTX 3050, 4× up to print resolution. *Needs your OK to
      download the official release binary.*
- [ ] `remove_background` with rembg (via uv), plus a fast `chroma_key` path.
- [ ] `compose`: text and layout with @napi-rs/canvas and bundled open-license fonts.
- [ ] `pixelate` (nearest-neighbor downscale + palette quantization) and a `spritesheet` packer.
- [ ] `vision_qa`: a rubric score for defects, garbled text, artifacts and legibility.
- [ ] `ip_screen`: blocklist + LLM + safety model.
- [ ] An artifact store, with a gallery per room where you can compare, approve or reject.

**Done when:** prompt → image → 4× upscale → cutout → QA score runs in one click and shows up in the
gallery, and every tool has unit tests.

### Stage 6: Factory 1, Etsy POD studio in sandbox (1 session)

**Goal:** complete, publish-ready listing packages, without touching Etsy yet.

- [ ] Three store "brands" in `config/businesses/` (for example candles, personalized gifts and wall
      art). Each has a niche, voice, product list and price rules.
- [ ] The full §7.1 pipeline as an Overseer objective template: "N new listings per store per day".
- [ ] Product print-area specs: defaults to start with, replaced by Printify's catalog once you have a
      token.
- [ ] Store dashboards in Factory 1.

**Done when:** there are 5 listing packages you'd genuinely publish (print file, mockups, copy and a
compliance report), and every step can be traced in the event log.

### Stage 7: Go live, Printify → Etsy (1 session)

**Goal:** the first real product reaches your Etsy shop, through your approval click.

- [ ] Live-lane enforcement: tasks marked live can only use providers tagged `production: allowed`.
      Re-verify each provider's terms and record them in `providers.yaml`.
- [ ] Printify client:
  - shops, blueprints, print providers and variants;
  - image upload, product creation and publish;
  - a dry-run mode and idempotency keys.
- [ ] The approval → publish flow, with a daily listing cap per shop and a kill switch per business.
- [ ] Order and revenue sync into the Vault ledger: Printify orders, plus Etsy receipts if your Etsy app
      is approved.
- [ ] Re-check Etsy's current AI and POD policy, and map its required fields (AI disclosure, production
      partner).

**Done when:**

- one real listing went live through an approval click;
- the sync job records orders;
- the kill switch has been tested.

**You provide:** an Etsy shop, a Printify account linked to it, and a Printify API token.

### Stage 8: Factory 2, Thumbnail studio (1 session)

**Goal:** a brief turns into three polished thumbnails in minutes.

- [ ] The §7.2 pipeline: intake form, 3 variants, revision loop and ZIP delivery.
- [ ] The gig kit: title, description, FAQ, pricing tiers and a portfolio set.

**Done when:** a brief becomes 3 thumbnails in about 3 minutes or less, and a revision note produces a
corrected version.

**You provide (optional):** a Fiverr seller account and gig. You post and deliver by hand.

### Stage 9: Factory 3, Asset forge (1 session)

**Goal:** themed, consistent, sellable 2D asset packs.

- [ ] The §7.3 pipeline:
  - style lock and consistency QA;
  - a ZIP with license, README and previews.
- [ ] itch.io page copy with the AI disclosure, and a `butler` upload behind approval.

**Done when:** one 32-icon pack (PNGs, sprite sheet, previews and license) is ready. Optionally, it's
pushed to itch.io.

**You provide (optional):** an itch.io account, and your OK to install `butler`.

### Stage 10: Economy, KPIs, learning loop (1 session)

**Goal:** the station learns what makes money.

- [ ] Vault:
  - revenue sources: Printify/Etsy, itch.io, and Fiverr entered by hand;
  - fees and profit per business;
  - a realistic monthly goal beside the joke $1T meter (log scale).
- [ ] KPIs per room and per agent:
  - throughput, approval rate, QA pass rate;
  - calls used and shadow cost (what those calls would cost on paid APIs);
  - revenue attribution.
- [ ] Overseer:
  - a daily standup and a weekly retro that feed the strategy memory;
  - reallocating crew between rooms;
  - proposing experiments on titles, prices and niches.

**Done when:** the dashboard shows real per-business numbers, and a week of simulated sales data
visibly changes the Overseer's plan.

### Stage 11: Always-on ops & polish (1 session)

**Goal:** the station "lives forever" and can reach you on your phone.

- [ ] Run as a service (pm2 or a Windows service):
  - auto-restart and health checks;
  - quiet hours;
  - nightly backups of the database and artifacts;
  - log rotation.
- [ ] Phone notifications with approve and reject buttons, via a Telegram bot or a Discord webhook.
- [ ] Safe remote access through Cloudflare Tunnel or Tailscale, always behind authentication.
- [ ] Hosting decision: the laptop, or a small always-on machine or VM (with no GPU there, the tools
      fall back to CPU).
- [ ] Polish: sound effects, day/night lighting, crew banter, achievements.

**Done when:** it runs unattended for 72 hours without a crash, and you've approved something from
your phone.

---

## 10. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Free tiers change or shrink | Agents stall | Multi-provider router, re-runnable census, provider swaps by config only, local fallback |
| NVIDIA trial terms (no production use) | Account termination, legal exposure | Lanes enforced in code. Live Mode never routes to NVIDIA unless you buy a subscription. |
| Marketplace suspension (IP, spam, misleading listings) | Losing the shop | IP screen, disclosures, daily caps, approval gate, quality threshold |
| Mediocre AI output | No sales | Best-of-N generation + vision QA + your taste at approval; playbooks improve from sales data |
| Prompt injection via customer briefs or web pages | Rogue actions | Untrusted content is tagged, tools get least privilege, and every side effect needs approval |
| Laptop sleeps or goes offline | The station stops | Stage 11: run as a service with resume-safe tasks; optional always-on host |
| Scope creep | Never finishing | Each stage has a "done when"; extras go to the backlog |
| Surprise costs | Money | No paid APIs by default, spend caps, shadow-cost tracking |

## 11. Decisions to confirm before Stage 1 (defaults in bold)

1. **Name and folder:** **`orbital-foundry`**, in a folder you pick.
2. **Stack:** **TypeScript end to end.** Alternative: a Python backend with a TypeScript client.
3. **Business order:** **Etsy POD → Thumbnails → Game assets.**
4. **Autonomy:** **you approve every external action**, relaxed later per action type.
5. **Live text lane:** **Groq free tier + local fallback, revisited in Stage 7.** Alternative: budget
   ~$5–10/month for a paid API once revenue exists.
6. **Art:** **original pixel art drawn in code.** Alternative: a CC0 tileset.
7. **Overseer name:** **WARDEN**, renameable any time. "Ultron" is a Marvel character: fine privately,
   but use an original name if you'll post videos of it.
8. **Where it runs 24/7:** **your laptop for now**, with hosting decided in Stage 11.

## 12. Backlog (after Stage 11)

- Nous Research's **Hermes Agent** (MIT, accepts custom OpenAI-compatible endpoints) as an alternative
  Overseer brain, through a bridge.
- More rooms:
  - a sticker shop;
  - a stock-asset studio;
  - low-content books;
  - digital packs on Gumroad.
- A plugin SDK, so a new business room is a drop-in config plus tools.
- **"TV mode"**: a cinematic camera that tours the station for screen recording (social content, like
  the reel itself).
- A voice for the Overseer (TTS) and daily spoken briefings.
- Save slots and multiple stations.
- A local Ollama lane for unlimited cosmetic crew banter.

## 13. Sources (checked 2026-11-04)

**Model providers:**

- NVIDIA API Trial Terms of Service (primary PDF):
  https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf
- NVIDIA live model list (queried directly; 85 chat models): https://integrate.api.nvidia.com/v1/models
- NVIDIA FLUX.1-schnell: https://build.nvidia.com/black-forest-labs/flux_1-schnell
- NVIDIA free-tier rate limits (community reports, not official):
  https://forums.developer.nvidia.com/t/is-nim-free/369368
- Cloudflare Workers AI pricing (official, updated 2026-10-20):
  https://developers.cloudflare.com/workers-ai/platform/pricing/
- OpenRouter limits (official): https://openrouter.ai/docs/api-reference/limits
- Gemini API terms (official): https://ai.google.dev/terms
- Groq free tier (third-party summary; verify on console.groq.com): https://eesel.ai/blog/groq-pricing

**Marketplaces:**

- Etsy's 2026 AI disclosure rules (seller guides; verify against Etsy's own policy pages in Stage 7):
  - https://nightjar.so/help-desk/do-i-need-to-disclose-that-my-product-images-are-ai-generated-on-etsy-or-shopify
  - https://www.valueaddedresource.net/etsy-bans-ai-patterns/
- Printify API flow (third-party connector guide; verify at developers.printify.com):
  https://anythingmcp.com/es/marketplace/printify
- Fiverr AI guidelines: https://help.fiverr.com/hc/nl/articles/37333301560593
- itch.io AI disclosure for assets:
  https://www.gamingonlinux.com/2024/11/itchio-store-now-requires-ai-generated-content-disclosures-for-assets

**Agents and visualizers:**

- Hermes Agent overview: https://toolradar.com/blog/what-is-hermes-agent
- Visualizers used for ideas only:
  - https://github.com/fumeilab/pixelfloor
  - https://github.com/neomatrix25/pixel-office-openclaw

## 14. Session log

- **2026-11-04:** Plan written; checked the local toolchain (Node 22, npm 10, Bun, Python 3.12, uv,
  Docker, Git; RTX 3050 6 GB, 16 GB RAM). **Next:** Stage 0 (you), then Stage 1.
- **2026-11-04:** Stage 1 built in `C:\Users\adnan\dev\New folder`. Done: the monorepo, the lane-aware
  router, rate gates, circuit breaker, JSON repair, image clients, and the census, smoke and models
  scripts; 46 tests; lint and typecheck clean. All 15 NVIDIA candidates are confirmed in the live
  catalog. **Next:** you add keys to `.env`; then `npm run census` and `npm run smoke` close out
  Stage 1, and Stage 2 (station visuals) starts.
- **2026-11-04:** Keys added (NVIDIA, Cloudflare, Groq) and Stage 1 closed out with real calls.
  - Discovery found that only 7 of NVIDIA's 61 catalog chat models answer for this account, so
    the tiers were rebuilt around them, with Groq and Cloudflare as fallbacks.
  - The census passes every tier in both lanes, and NVIDIA alone covers all five sandbox tiers.
  - Sandbox smoke passed 8 of 9 checks (NVIDIA's FLUX endpoint is down on NVIDIA's side); live
    smoke passed 8 of 8, and the first station image was generated.
  - The router now retries a truncated reply with a bigger token budget and treats empty replies
    as failures. The image service polls NVIDIA's async requests and has a circuit breaker.
    Provider errors no longer contain account IDs. 59 tests.
  - **Next:** Stage 2 (station visuals). Open owner decision: whether to accept Meta's Llama 3.2
    license on Cloudflare (D-012). It isn't needed today.
- **2026-11-04:** Stage 2 built: the station on screen with a mock crew.
  - `apps/client` (Vite 8, Phaser 4.2, React 19, Tailwind 4) joins the workspaces, and
    `npm run client` starts it.
  - The map, crew, station events and A* pathfinding live in `packages/shared`. The map is a
    JSON tile grid with 11 rooms, checked by layout tests.
  - Everything is drawn in code: 16×16 crew sprites with palette swaps, a pixel font, tiles,
    furniture, and animated screens, racks, doors and holograms.
  - A seeded mock director drives the nine crew: work sessions, QA deliveries and reviews, café
    breaks for mock rate limits, Server Room outages, and WARDEN's patrols and nudges.
  - 108 tests (49 new). The station was checked in the built-in browser pane. The saved
    screenshots and the frame-rate run used headless Edge: pane screenshots can't be saved to
    disk, and a hidden pane runs no frames.
  - **Next:** Stage 3 (sim engine, persistence, realtime link). The mock director can become the
    server's first sim engine, and the client swaps `MockLink` for a WebSocket link.
