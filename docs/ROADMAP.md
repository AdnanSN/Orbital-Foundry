# Orbital Foundry: Master Plan & Roadmap

> **Working title.** An always-on pixel-art space station where AI agents run a **faceless video
> studio**. They find ideas, research and write scripts, voice them, make the visuals, edit, and post
> long-form videos and shorts to YouTube, TikTok and Instagram, and they answer to an Overseer. You
> watch and steer it from your browser.
>
> Written 2026-11-04 for online shops; re-planned 2026-11-05 for the studio (DECISIONS D-049). Facts
> about providers, platforms and licences were checked on those dates (sources in §13 and
> `docs/STUDIO-RESEARCH.md`). Re-check anything more than a few months old before relying on it.

**To resume in any session, say:** "Read `docs/ROADMAP.md` and start Stage N."
At the end of each stage: tick its boxes, add a line to the Session Log (§14), and commit.

## Status

| # | Stage | Size | Status |
|---|---|---|---|
| 0 | Prep: keys, folder, decisions | you, ~30 min | ✅ done (NVIDIA, Cloudflare and Groq keys set) |
| 1 | Foundation & model router | 1 session | ✅ done, except NVIDIA image generation (down on NVIDIA's side) |
| 2 | The station: visuals with a mock crew | 1 session | ✅ done (`npm run client`) |
| 3 | Sim engine, persistence, realtime link | 1 session | ✅ done (`npm run dev`) |
| 4 | Agent brains: runtime, Overseer, task board | 1–2 sessions | ✅ done (Work and Desk panels) |
| 5 | Creative toolchain (images, upscale, QA) | 1 session | ✅ done; Real-ESRGAN and rembg wait for your OK |
| 6 | Factory 1: Etsy POD studio (sandbox) | 1 session | ✅ done; ⏸ parked for the studio (D-049) |
| 7 | Go live: Printify → Etsy | 1 session | 🟡 built, dry run; ⏸ parked (D-049) |
| 8 | Factory 2: Thumbnail studio | 1 session | ✅ done; it will make the channel's own thumbnails (Stage 16) |
| 9 | Factory 3: Asset forge | 1 session | 🟡 built and tested; ⏸ parked (D-049) |
| 10 | Economy, KPIs, learning loop | 1 session | ✅ done; its retro loop moves to platform stats (Stage 19) |
| 11 | Always-on ops & polish | 1 session | 🟡 built; the 72-hour run and a phone approval need you |
| **12** | **Studio prep: accounts and keys** | you, ~1–2 hours | ⬜ **next**, alongside Stage 13 |
| 13 | Studio core: media router, voice-over, captions, render | 1 session | ⬜ |
| 14 | Visual sources: stock library, camera moves, music | 1 session | ⬜ |
| 15 | Writers' Room: channel bible, ideas, research, scripts | 1 session | ⬜ |
| 16 | Edit Bay: script to finished video, screening, preview approval | 1–2 sessions | ⬜ |
| 17 | Uplink: posting to YouTube, TikTok and Instagram | 1 session | ⬜ |
| 18 | GPU lane: AI video clips, local and on free cloud credits | 1 session | ⬜ |
| 19 | Analytics and the learning loop | 1 session | ⬜ |
| 20 | Studio makeover and a 7-day unattended run | 1 session | ⬜ |

Stages 0 to 11 built the station, the router, the crew and the ops, and the studio reuses all of it.
The studio stages run in the order 13 → 14 → 16 → 19 → 20. Stage 12 is yours, alongside 13.
Stage 15 (scripts) needs only the existing router, so it can run in parallel with 13 or 14. Stages 17
(posting) and 18 (GPU lane) need only Stage 13 and can be parallel sessions; 17 goes live with
Stage 16's first videos.

---

## 1. What we're building

A faceless channel studio inside the station: one channel identity, posted on three platforms.

| Room (after Stage 20) | What happens there |
|---|---|
| **Trend Lab** | Scout finds ideas in real signals (YouTube's charts and competitors' uploads, Google Trends, Wikipedia page views) and scores them for demand, competition, an original angle and fit. |
| **Writers' Room** | Research with sources, an outline, the script, hook and title options, and a shot list. |
| **Edit Bay** | Voice-over, visuals from five kinds of source, captions, music and sound effects, rendered to MP4: 16:9 long-form and 9:16 shorts. |
| **Thumbnail Studio** | Stage 8's studio, now making the channel's own thumbnails. |
| **Screening Room** | QA of sound and picture, the fact-check, copyright and policy screens, and the AI-disclosure decision. |
| **Uplink** | Posting through the platforms' official APIs, after your approval. |
| **Vault** | Views, watch time, subscribers, revenue and costs, feeding the weekly retro. |

The first plan (an Etsy print-on-demand studio, a Fiverr thumbnail gig, game-asset packs) is parked.
Its code and tests stay, no autopilot starts it, and it can come back later, for example as channel
merch through Printify once there is an audience (D-049).

What makes it more than a dashboard is still that every animation is driven by a real event:

- an agent typing at a terminal is a real LLM call;
- the frame on its holo-screen is the real render;
- a walk to the café is a real rate-limit back-off.

## 2. Reality check & ground rules

- **Volume is not the goal.** AI-made faceless channels can be monetized, but YouTube's "inauthentic
  content" policy (renamed from "repetitious content" on 2025-07-15) removes mass-produced and
  repetitive channels from the Partner Program, and the first channel-level enforcement wave came in
  January 2026. YouTube now splits it into generic or repetitive content, unsatisfying or off-putting
  content, and AI personas on sensitive topics. So the studio optimizes watch time and viewer
  satisfaction, not output: original research and a point of view in every script, varied structure
  and visuals, daily caps, and no reused content (no compilations of other people's clips, no Reddit
  posts read aloud, no film recaps) (D-053).
- **Disclosure is automatic.** Realistic synthetic scenes set YouTube's altered-or-synthetic flag
  (`containsSyntheticMedia`) and TikTok's AI-generated label (`is_aigc`), and every description says
  the narration is an AI voice.
- **You stay in the loop.** Nothing is published, scheduled, replied to or paid for without your
  approval at the Owner's Desk or on your phone. Once you trust an action type you can relax it.
- **Official APIs only.** No browser bots on YouTube Studio, TikTok or Instagram: they break the
  platforms' terms and get accounts banned. Where an API is gated (TikTok's Direct Post before its
  audit), the studio sends the video to your TikTok inbox and you tap Post (D-051).
- **Every asset carries its licence.** Stock clips, music, fonts and model outputs are recorded with
  their source and licence, credits go in the description where a licence asks for them, and nothing
  from the sandbox lane is ever published.
- **Sandbox first.** Every pipeline is built and tested in Sandbox Mode before anything reaches a
  platform.

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

### 3.1 Media lanes (the studio)

Voice, footage, music and video models follow the same rule (D-050). They are providers in
`config/media.yaml`, each with lanes, a licence note and budgets, behind the same gates, circuit
breakers and usage log as the model router. Every capability has a free first choice, at least one
free fallback, and a paid upgrade that becomes a config change once there is revenue:

| Capability | Live lane, in order | Never live | Paid later |
|---|---|---|---|
| Voice-over | ElevenLabs (your Creator plan) → Kokoro-82M on this laptop → Cloudflare's speech models | Edge TTS | ElevenLabs Pro |
| Word timings | ElevenLabs alignment → whisper.cpp on this laptop → Cloudflare Whisper | — | — |
| Motion graphics, render | HyperFrames on this laptop → plain FFmpeg assembly | — | Cloud rendering |
| Stock | our own clip library → Pixabay → NASA, Wikimedia, Openverse (licence per item) | — | Storyblocks, Artgrid |
| AI stills | Cloudflare FLUX.1-schnell → local FLUX.1-schnell overnight | NVIDIA FLUX | Nano Banana, Ideogram |
| Camera moves on stills | depth parallax (Depth Anything V2 Small) → Ken Burns | — | Higgsfield's API |
| AI video clips | LTX-2 or Wan 2.2 on this laptop overnight → Modal's free credits → Kaggle | Hunyuan-based models, shared Hugging Face Spaces | Kling, Seedance, Veo through Muapi, fal or Higgsfield |
| Music, sound effects | our own library (YouTube Audio Library, CC0) → ACE-Step 1.5 on this laptop | — | ElevenLabs Music |
| Posting | YouTube Data API, Instagram API, TikTok upload to inbox | browser automation | TikTok Direct Post after its audit |

Pexels' licence would allow all of this, but it has paused new API keys, so it joins only if you
already have one. The full matrix, with free allowances, licences and sources, is in
`docs/STUDIO-RESEARCH.md` §3.

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
│   Studio ······· ideas · scripts · voice · render · uplink             │
│   Approval gate  every external side effect → Owner's Desk             │
│   Model router · lanes, tiers, rate limits, fallbacks, usage log       │
│   Event bus ···· append-only event log → WebSocket broadcast           │
│  SQLite (Drizzle) + data/artifacts/ (images, renders, video packages)  │
└───────┬────────────────────────┬────────────────────────────┬──────────┘
        │ OpenAI-compatible HTTP │ local binaries             │ platform APIs
        ▼                        ▼                            ▼
  NVIDIA · Cloudflare ·    FFmpeg · HyperFrames ·       YouTube Data API ·
  Groq · Gemini ·          Kokoro · whisper.cpp ·       TikTok · Instagram ·
  OpenRouter · ElevenLabs  Wan2GP · Real-ESRGAN · rembg (Printify: parked)
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
| Video render (studio) | HyperFrames (Apache-2.0) + FFmpeg, NVENC encoding | HTML scenes that agents write well; deterministic MP4s (D-052) |
| Voice-over (studio) | ElevenLabs API; Kokoro-82M through `kokoro-js` | Your paid plan first, an unlimited local voice behind it |
| Caption timing (studio) | ElevenLabs alignment; whisper.cpp | Captions that land on each word, without another paid service |
| AI video (studio) | A Wan2GP worker (Python via uv) on the RTX 3050; Modal | Free clips overnight; free cloud credits for bursts |
| Posting (studio) | YouTube Data API, Instagram API, TikTok Content Posting API | Official APIs only (D-051) |
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

**The crew in the studio.** The same nine agents change jobs as the studio stages land, so their
history carries over. Stage 20 renames the rooms in the map data; you can hire more any time.

| Agent | Room today → studio room | Job | Tiers |
|---|---|---|---|
| WARDEN (Overseer) | Command Bridge | Showrunner: the week's slate, assignments, reviews, nudges, escalations | reasoning |
| Scout | Research Lab → Trend Lab | Ideas from real signals, the niche study, research briefs with sources | reasoning |
| Wick, Gift | Factory 1 → Writers' Room | Outlines, scripts, hooks, titles and shot lists (Wick long-form, Gift shorts) | creative |
| Frame | Factory 3 → Edit Bay | Voice-over, visuals, captions, music, the render | creative, vision |
| Forge | Server Room → Render Farm | The GPU queue, the clip library and the music library | fast |
| Flash | Factory 2 → Thumbnail Studio | Thumbnails and channel art | creative, image, vision |
| Lens | QA Bay → Screening Room | QA, fact-check, copyright, policy, AI disclosure | vision, reasoning |
| Ledger | Vault | Platform stats, budgets, revenue, the weekly numbers | fast |

Posting has no agent of its own: the Uplink runs only what you approve at the Owner's Desk.

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
| A frame of the video on an Edit Bay screen | A real render in progress, with its progress bar |
| The Render Farm racks glowing at night | The GPU making AI clips in quiet hours |
| The Uplink antenna lighting up | A video you approved is being posted |
| Confetti in the Vault | A subscriber or view milestone from the platforms' stats |

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

## 7. The studio pipeline

### 7.1 One video, end to end

1. **Idea.** Scout keeps a scored backlog from real signals: YouTube's most-popular charts and the
   recent uploads of channels in the niche (cheap API reads), Google Trends' public "trending now"
   feed, Wikipedia page views, and your own ideas. Each idea is scored for demand, competition, an
   original angle, fit with what we can produce for free, and policy risk. WARDEN picks the week's
   slate; you can veto or add.
2. **Research.** A brief with sources from allowlisted sites (Wikipedia, NASA and others per
   channel): the facts, the numbers, and where each one came from.
3. **Script.** An outline (hook, beats, pattern breaks, payoff), then the script for the format, two
   or three hooks and titles, and a shot list that names a visual source for each beat. Lens checks
   every claim against the brief and cuts what has no source. A style check removes stock AI phrases
   and anything too close to our earlier scripts.
4. **Voice.** Made only after the script passes review: ElevenLabs with the channel's voice, which
   returns word timings. Kokoro voices the drafts, and takes over if the month's credits run low.
   Loudness is normalized for each platform.
5. **Visuals.** Each shot comes from the cheapest source that fits it, with a fallback when a source
   is busy or out of budget:
   - motion graphics written as HTML scenes (titles, lists, charts, maps, quotes, captions);
   - stock and public-domain footage, reused from our own library first;
   - AI stills with a camera move (push-in, dolly, orbit, crane) made from a depth map;
   - AI video clips from the GPU queue, for hooks and key moments;
   - frames and diagrams drawn in code.
6. **Edit.** Scene lengths come from the voice timings. HyperFrames assembles the visuals, word-by-word
   captions (burned in for shorts), lower thirds, music ducked under the voice, and sound effects,
   then renders 1920×1080 long-form and 1080×1920 shorts.
7. **Thumbnail.** Stage 8's studio makes three options from the title and the video's best frames,
   and Lens picks by phone-size readability.
8. **Screening.** FFmpeg's black, freeze and silence detectors, loudness, caption sync, vision QA on
   sampled frames at phone size, the IP and policy screens, and the AI-disclosure decision.
9. **Package.** Title, description (sources, credits, the AI-narration note, chapters for long-form),
   tags, and captions and hashtags for each platform.
10. **Approval.** The Owner's Desk plays the video. Approve it per platform, or send it back with a
    note for a re-edit. Telegram brings the same buttons to your phone.
11. **Posting.** The Uplink posts what you approved, once each, at the scheduled time: YouTube
    (scheduled publishing, thumbnail, captions file), Instagram Reels, and TikTok as a draft in your
    inbox until the audit allows Direct Post.
12. **Learning.** Stats come back after an hour, a day and a week, and the Vault and the weekly retro
    turn them into the next slate.

### 7.2 Formats and cadence

- **Long-form:** 8 to 12 minutes, 16:9, on YouTube, with chapters.
- **Shorts:** 30 to 60 seconds, 9:16, on YouTube Shorts, TikTok and Instagram Reels. Some get a 61 to
  90 second TikTok cut, because TikTok's Creator Rewards pay only for videos over a minute.
- **The waterfall:** every long-form yields three to five shorts with their own hooks.
- **Starting cadence:** one long-form a week and one short a day. WARDEN raises it only while
  retention and satisfaction hold (D-053).

### 7.3 The channel bible

`config/channels/<id>.yaml` (Stage 15) holds what makes the channel recognizable: the niche and
audience, the narrator's persona, the ElevenLabs voice and the Kokoro fallback voice, a style guide
and banned phrases, palette, fonts and motion templates, the thumbnail style, formats and cadence,
topics to avoid, and disclosure defaults.

### 7.4 The parked businesses

Etsy POD (Stages 6 and 7), the Fiverr thumbnail gig kit (Stage 8) and the Asset Forge (Stage 9) are
built and tested. Their autopilots go off in Stage 13 and their rooms change jobs (D-049). They are
described in their stage sections below and in the git history before 2026-11-05.

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

**Planned for the studio** (Stages 13 to 19): the tables `channels`, `ideas`, `videos` (one per
project, with its state), `shots`, `assets` (source, licence, credit, reuse count), `renders`,
`publications` (one per platform, idempotent) and `platform_stats`, plus `media_calls`, which logs
voice, footage, GPU and render usage beside `llm_calls`. New events: `video.updated`,
`render.progress` and `publish.updated`.

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

- [x] A Fastify server with WebSocket, plus the SQLite schema and migrations from §8 (`agents`,
      `tasks`, `events` and `kv`; the other §8 tables arrive with the stages that use them).
- [x] Server-owned world state (rooms, agents, activities, clock). Clients animate from
      `agent.moved {from, to, t0}`. The sim engine moved to `packages/shared/src/sim` (D-019).
- [x] A snapshot when a client connects, then incremental events, with auto-reconnect and resync.
      Every reconnect gets a fresh snapshot (D-020).
- [x] REST commands: hire an agent, reassign a room, pause or resume, and set the speed.
- [x] **Recruitment Bay**, the reel's "place an agent" mechanic: pick a role template, name the agent,
      and drag it onto a room. It walks in through the airlock.
- [x] An event feed panel (the station log), and an inspector that shows live data and can move a
      crew member to another room.

**Done when:**

- [x] restarting the server resumes the exact station. This is tested, and was checked by hand:
      the crew, positions, tasks and clock all survive.
- [x] two browser tabs stay in sync (tested with two WebSocket clients);
- [x] hiring works end to end (tested over REST and WebSocket, and through the Recruitment Bay).

### Stage 4: Agent brains (1–2 sessions)

**Goal:** agents do real work through the free models, and the Overseer runs the crew.

- [x] Role templates in `config/roles/*.yaml`: system prompt, tools, tier, KPIs and schedule.
- [x] Agent runtime:
  - the work loop from §6, with a step cap;
  - zod-validated outputs, retries and escalation;
  - status lines shown as speech bubbles.
- [x] Tool framework with side-effect, lane and approval metadata. First tools:
  - notes, memory search and save;
  - create a subtask, ask the Overseer;
  - web research (allowlisted sites only);
  - submit for review.
- [x] Overseer loop:
  - objectives → tasks → assignment;
  - idle and stuck detection, with nudges;
  - a review gate and a daily standup;
  - escalations to you.
- [x] UI: a task board (kanban), the **Owner's Desk** approval inbox, and an objective input box.
- [x] The game mappings from §5: café on rate limits, alert lights, ❗ at the desk.
- [x] A mock LLM provider with recorded fixtures, for deterministic end-to-end tests.

**Done when:** you type an objective (for example "Find 10 winter candle niches and rank them") and
watch it get split up, worked on, reviewed and delivered. Rate limits are handled visibly, and the
tests pass.

### Stage 5: Creative toolchain (1 session)

**Goal:** the shared tools every factory needs.

- [x] `generate_image`: picks a provider by lane; supports aspect ratios, seeds and a prompt library.
- [~] `upscale`: Real-ESRGAN-ncnn-vulkan on your RTX 3050, 4× up to print resolution. *Needs your OK to
      download the official release binary.* The runner is built and off; until then a high-quality
      resampler does the 4× (D-026).
- [~] `remove_background` with rembg (via uv), plus a fast `chroma_key` path. Chroma key and an
      edge flood fill work now; rembg is wired but off until you OK its model download (D-026).
- [x] `compose`: text and layout with @napi-rs/canvas. Fonts: installed system fonts for now;
      bundled open-license fonts need a download (D-027).
- [x] `pixelate` (nearest-neighbor downscale + palette quantization) and a `spritesheet` packer.
- [x] `vision_qa`: a rubric score for defects, garbled text, artifacts and legibility.
- [x] `ip_screen`: blocklist + LLM + safety model.
- [x] An artifact store, with a gallery per room where you can compare, approve or reject.

**Done when:** prompt → image → 4× upscale → cutout → QA score runs in one click and shows up in the
gallery, and every tool has unit tests.

### Stage 6: Factory 1, Etsy POD studio in sandbox (1 session)

**Goal:** complete, publish-ready listing packages, without touching Etsy yet.

- [x] Three store "brands" in `config/businesses/` (for example candles, personalized gifts and wall
      art). Each has a niche, voice, product list and price rules.
- [x] The full §7.1 pipeline as an Overseer objective template: "N new listings per store per day".
- [x] Product print-area specs: defaults to start with, replaced by Printify's catalog once you have a
      token.
- [x] Store dashboards in Factory 1.

**Done when:** there are 5 listing packages you'd genuinely publish (print file, mockups, copy and a
compliance report), and every step can be traced in the event log.

### Stage 7: Go live, Printify → Etsy (1 session)

**Goal:** the first real product reaches your Etsy shop, through your approval click.

- [x] Live-lane enforcement: tasks marked live can only use providers tagged `production: allowed`.
      Re-verify each provider's terms and record them in `providers.yaml`. (Recorded per provider;
      Cloudflare's 2026-11-04 check stands, re-verify before the first sale.)
- [x] Printify client (dry run tested; live calls need your token):
  - shops, blueprints, print providers and variants;
  - image upload, product creation and publish;
  - a dry-run mode and idempotency keys.
- [x] The approval → publish flow, with a daily listing cap per shop and a kill switch per business.
- [~] Order and revenue sync into the Vault ledger: Printify orders, plus Etsy receipts if your Etsy app
      is approved. (Printify orders: built and tested against a fake API. Etsy receipts: not built,
      they need an approved Etsy app.)
- [x] Re-check Etsy's current AI and POD policy, and map its required fields (AI disclosure, production
      partner).

**Done when:**

- one real listing went live through an approval click;
- the sync job records orders;
- the kill switch has been tested.

**You provide:** an Etsy shop, a Printify account linked to it, and a Printify API token.

### Stage 8: Factory 2, Thumbnail studio (1 session)

**Goal:** a brief turns into three polished thumbnails in minutes.

- [x] The §7.2 pipeline: intake form, 3 variants, revision loop and ZIP delivery.
- [x] The gig kit: title, description, FAQ, pricing tiers and a portfolio set.

**Done when:** a brief becomes 3 thumbnails in about 3 minutes or less, and a revision note produces a
corrected version.

**You provide (optional):** a Fiverr seller account and gig. You post and deliver by hand.

### Stage 9: Factory 3, Asset forge (1 session)

**Goal:** themed, consistent, sellable 2D asset packs.

- [x] The §7.3 pipeline:
  - style lock and consistency QA;
  - a ZIP with license, README and previews.
- [x] itch.io page copy with the AI disclosure, and a `butler` upload behind approval (dry run
      until you OK installing butler).

**Done when:** one 32-icon pack (PNGs, sprite sheet, previews and license) is ready. Optionally, it's
pushed to itch.io.

**You provide (optional):** an itch.io account, and your OK to install `butler`.

### Stage 10: Economy, KPIs, learning loop (1 session)

**Goal:** the station learns what makes money.

- [x] Vault:
  - revenue sources: Printify/Etsy, itch.io, and Fiverr entered by hand;
  - fees and profit per business;
  - a realistic monthly goal beside the joke $1T meter (log scale).
- [x] KPIs per room and per agent:
  - throughput, approval rate, QA pass rate;
  - calls used and shadow cost (what those calls would cost on paid APIs);
  - revenue attribution.
- [x] Overseer:
  - a daily standup and a weekly retro that feed the strategy memory;
  - reallocating crew between rooms;
  - proposing experiments on titles, prices and niches.

**Done when:** the dashboard shows real per-business numbers, and a week of simulated sales data
visibly changes the Overseer's plan.

### Stage 11: Always-on ops & polish (1 session)

**Goal:** the station "lives forever" and can reach you on your phone.

- [x] Run as a service (pm2 or a Windows service): `npm run station`, a supervisor script (no
      service installed; Task Scheduler or pm2 steps in docs/OPERATIONS.md):
  - auto-restart and health checks;
  - quiet hours;
  - nightly backups of the database and artifacts;
  - log rotation.
- [x] Phone notifications with approve and reject buttons, via a Telegram bot or a Discord webhook.
      (Telegram, built and tested; on once you add a bot token.)
- [~] Safe remote access through Cloudflare Tunnel or Tailscale, always behind authentication.
      (The access token is built; choosing and setting up the tunnel is yours, steps in
      docs/OPERATIONS.md.)
- [~] Hosting decision: the laptop, or a small always-on machine or VM (with no GPU there, the tools
      fall back to CPU). (Your call; the options are in docs/OPERATIONS.md.)
- [x] Polish: sound effects, day/night lighting, crew banter, achievements.

**Done when:** it runs unattended for 72 hours without a crash, and you've approved something from
your phone.

### Stage 12: Studio prep (you, ~1–2 hours, alongside Stage 13)

The accounts and keys the studio needs. Start the slow ones first: the platform app reviews take
days. Keys go in `.env`; Stage 13 adds their names to `.env.example`.

- [ ] **ElevenLabs:** create an API key and put it in `ELEVENLABS_API_KEY`. If your account settings
      let you, give the key a credit limit and turn off usage-based billing, so the Creator plan never
      charges past its 121,000 monthly credits. (The station also stops itself before that, D-050.)
- [ ] **The channel's voice:** pick one ElevenLabs voice: a premade voice, or one you make with Voice
      Design. Avoid community library voices, which their owners can withdraw.
- [ ] **Pixabay:** a free account and its API key (`PIXABAY_API_KEY`). If you already have a Pexels
      key, add it too; Pexels has paused new keys.
- [ ] **YouTube:** a channel for the brand, and a Google Cloud project with the YouTube Data API v3,
      the YouTube Analytics API and an OAuth client of type "Desktop app". Set the OAuth consent
      screen to **In production**. It stays unverified, which is fine for your own channel; in
      "Testing", Google's refresh tokens expire after 7 days.
- [ ] **Instagram:** switch the account to a professional (Creator) account, and create a Meta
      developer app with the Instagram API (Instagram Login). In development mode it can post to
      accounts that have a role in the app, which covers yours.
- [ ] **TikTok:** a TikTok for Developers app with Login Kit and the Content Posting API. It asks for a
      website, a privacy policy and terms: those pages (plus a data-deletion page, which Meta also
      asks for) are in `site/`, published free by GitHub Pages through
      `.github/workflows/pages.yml` once the branch is on `main`.
- [ ] **Optional:** a Modal account ($30 of free compute a month) for Stage 18, and a Freesound API
      key for sound effects.
- [ ] **Your call:** a niche you already like, or let Scout propose three in Stage 15 (§11).

### Stage 13: Studio core (1 session)

**Goal:** a script becomes a voiced, captioned, rendered short on this laptop.

- [ ] Park the old businesses: the Etsy autopilot off by config, the open shop objectives from the
      first production run closed, the Stores, Thumbs and Forge panels kept but marked parked, and
      their tests still running.
- [ ] `config/media.yaml` and a media router: providers with lanes, licence notes and budgets per day
      and per month, in each provider's own unit (characters, credits, requests, GPU seconds), behind
      the existing `ProviderGate` and circuit breakers, with a `media_calls` usage log.
- [ ] Voice: an ElevenLabs client (speech with timestamps; the subscription's remaining credits read
      before each job; a hard stop before the monthly quota) and Kokoro-82M through `kokoro-js` as the
      local voice. Pronunciation fixes per channel.
- [ ] Word timings from ElevenLabs' alignment, or from whisper.cpp for local voices. Caption chunking
      for shorts (two to four words, highlighted as they're spoken) and SRT files for long-form.
- [ ] Render: a timeline schema (scenes, voice, captions, music) compiled to a HyperFrames
      composition and rendered with FFmpeg, on NVENC when the GPU is free. First scene templates:
      title card, kinetic captions, list item, quote, still with Ken Burns, lower third.
- [ ] `npm run studio:smoke`: a 20-second vertical test short from a fixed script, saved to
      `data/artifacts/studio/smoke/`.
- [ ] Tests for the timeline schema, caption chunking, budgets and media lanes, with fake voice and
      render runners.

**Done when:** the smoke short plays with a clear voice and captions that land on each word, in both
a Kokoro and an ElevenLabs version, and renders in a few minutes on this laptop.

**You provide:** `ELEVENLABS_API_KEY`, and your OK to download FFmpeg, a headless Chrome for
HyperFrames, Kokoro's model (about 330 MB) and whisper.cpp's base.en model (about 150 MB).

### Stage 14: Visual sources (1 session)

**Goal:** every shot in a shot list can be filled for free, with a fallback.

- [ ] A clip library (SQLite plus `data/library/`): source, licence, credit, tags, length, resolution
      and reuse count. Reuse comes first, and a size cap cleans up the least recently used clips.
- [ ] Stock: Pixabay (a 24-hour cache, downloads, its request limits), NASA's Image and Video Library,
      Wikimedia Commons and Openverse with licence filters and credits, and Pexels if a key exists.
- [ ] AI stills from the image service at 16:9 and 9:16 (Cloudflare's FLUX is square, so they are
      cropped or extended), sharing the daily image budget with the Thumbnail Studio.
- [ ] Camera moves on stills: Depth Anything V2 Small (Apache-2.0, ONNX on the CPU) makes a depth map,
      and a parallax shader in HyperFrames turns it into push-in, dolly, orbit and crane moves.
- [ ] Music and sound: a library you can fill from YouTube's Audio Library, beds made locally with
      ACE-Step 1.5 (MIT, under 4 GB of VRAM), Freesound CC0 effects, ducking under the voice, and
      loudness to each platform's target.
- [ ] A credits file for each video that lists every asset with its licence.

**Done when:** a 60-second short that uses every kind of source renders, with a correct credits file.

### Stage 15: Writers' Room (1 session)

**Goal:** approved scripts you'd want to watch, for a niche you chose.

- [ ] The channel bible (`config/channels/<id>.yaml`, §7.3), and studio playbooks for scripting,
      screening and analysis.
- [ ] The niche study: Scout scores candidate niches for demand, competition, likely ad rates, policy
      risk and fit with the free stack, and proposes three at the Owner's Desk. You pick one.
- [ ] Idea sources: YouTube Data API reads (charts and competitors' uploads; search is capped at 100
      calls a day), Google Trends' trending feed, Wikipedia page views and your own ideas, in a scored
      backlog on the Work panel.
- [ ] Research briefs with sources; outlines and scripts for long-form and shorts; hook and title
      options; shot lists; and Lens's fact-check, style check and sameness check against our own
      earlier scripts.

**Done when:** one long-form script and two shorts scripts, each with sources, a shot list, titles and
thumbnail ideas, are approved at the Owner's Desk.

### Stage 16: Edit Bay (1–2 sessions)

**Goal:** an approved script becomes finished videos with one click.

- [ ] The §7.1 pipeline as code, as the factories were (D-029): voice, timings, shots, assets,
      timeline, renders, captions, chapters, thumbnails and the package, with every step in the
      event log.
- [ ] The waterfall: three to five shorts cut from each long-form, with new hooks.
- [ ] Screening: FFmpeg's black, freeze and silence detectors, loudness, caption sync, vision QA on
      sampled frames at phone size, the IP and policy screens, and the AI-disclosure decision.
- [ ] The Owner's Desk plays the video, and a send-back note starts a re-edit.

**Done when:** one 8 to 10 minute long-form and three shorts you'd genuinely publish were made end to
end, in the live lane only.

### Stage 17: Uplink (1 session)

**Goal:** an approved video reaches all three platforms through their official APIs.

- [ ] Publishers behind the approval and outbox pattern (D-033): a dry run unless `PUBLISH_MODE=live`,
      once per approval, the kill switch, and daily caps per platform.
- [ ] YouTube: `npm run auth:youtube` (OAuth for a desktop app), resumable upload, scheduled
      publishing, thumbnail, captions file, playlists, `containsSyntheticMedia`, and quota tracking
      (100 uploads and 10,000 units a day).
- [ ] Instagram: Reels through the Instagram API (a resumable upload of the local file), the caption,
      the 100-posts-a-day cap and token refresh.
- [ ] TikTok: upload to your inbox as a draft, with a phone notice to post it. Direct Post with
      `is_aigc` switches on by config once the audit passes.
- [ ] An upload kit (file, caption, hashtags, thumbnail) for any platform that isn't connected yet.

**Done when:** a long-form and a short are scheduled on YouTube, the short is on Instagram and in your
TikTok inbox, all through approval clicks, and the kill switch has been tested.

**You provide:** the Stage 12 accounts, and the first sign-in to each platform in your browser.

### Stage 18: GPU lane (1 session)

**Goal:** AI video clips without paying, where the shot list asks for them.

- [ ] A benchmark on the RTX 3050 (6 GB): Wan2GP with LTX-2 distilled and Wan 2.2 (TI2V-5B and 1.3B),
      against ComfyUI's API. The faster one becomes a worker with a job queue.
- [ ] The queue runs in quiet hours (23:00 to 07:00) and whenever the GPU is idle. Shots that aren't
      done by their deadline fall back to stock or a camera move.
- [ ] Modal as the burst lane (LTX-2 or Wan 2.2 on a cloud GPU), hard-capped below the $30 of free
      credit a month, and Kaggle's free GPU hours as an optional batch lane.
- [ ] Paid providers wired but off (Muapi, fal, kie.ai and the Higgsfield API, for Kling, Seedance and
      Veo), so turning one on later is a config change.
- [ ] Licences: LTX-2 is free for commercial use under $10M a year in revenue; Wan 2.2 is Apache-2.0;
      Hunyuan-based models stay out of the live lane, because their licence excludes the EU, the UK and
      South Korea.

**Done when:** an overnight run fills a long-form's AI shots, and a video still finishes on time when
the queue falls behind.

**You provide:** your OK for the model downloads (about 15 to 25 GB; disk is the limit, §10) and,
optionally, a Modal account.

### Stage 19: Analytics and the learning loop (1 session)

**Goal:** the studio learns what its audience watches.

- [ ] Stats: YouTube Analytics (views, watch time, average view duration and percentage, subscribers,
      traffic sources), Instagram Insights, and TikTok's video stats.
- [ ] The Vault per video and per format: costs (ElevenLabs credits, GPU time, Modal) and shadow cost,
      and progress toward the Partner Program and TikTok's Creator Rewards thresholds.
- [ ] WARDEN's standup and weekly retro on real numbers (Stage 10's loop): idea-score weights, lessons
      on hooks, titles and thumbnails, and changes to formats and cadence, clamped and approved by you.

**Done when:** a week of real stats visibly changes the next week's slate.

### Stage 20: Studio makeover and a 7-day run (1 session)

**Goal:** the station runs the channel, and you only approve.

- [ ] The rooms renamed in the map data (§5), a small Uplink room by the Owner's Desk, and studio
      screens that show real frames and render progress.
- [ ] A Studio panel: each video's board (idea → script → voice → visuals → render → screening →
      approval → posted), a preview player, the budgets left (credits, images, GPU queue, Modal) and
      platform status.
- [ ] Always-on: the weekly production schedule, overnight GPU work, disk clean-up after posting, and
      backups that include the finished videos.

**Done when:** for 7 days, ideas become posted videos while you only approve, from your phone.

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
| YouTube's inauthentic-content policy | A demonetized channel | Quality caps and originality rules (D-053), varied formats, your approval on every video |
| A platform strike or ban | A lost channel | Official APIs only, disclosures, licence records, no reused content |
| TikTok's audit takes a long time | Posting stays a tap on your phone | Inbox drafts until then; Direct Post is a config switch |
| Stock dries up (Pexels paused new keys) | Weaker visuals | Pixabay, public-domain archives, our own library, AI stills with camera moves |
| ElevenLabs credits run out | No premium voice that month | A hard monthly cap; Kokoro voices the drafts and the overflow |
| The 6 GB GPU is too slow for AI video | Few AI clips | AI clips only for hooks and key moments, an overnight queue, Modal's credits; motion graphics and footage carry the rest |
| Disk space (59 GB free) | Failed renders | Clean-up after posting, a library size cap, models or archives on an external drive |
| Music Content ID claims | Lost revenue on a video | Licensed library music, ACE-Step originals, YouTube's Audio Library |
| Factual mistakes | Lost trust; strikes on sensitive topics | Sources in every brief, Lens's fact-check, sensitive topics avoided |

## 11. Decisions (defaults in bold)

**Before Stage 1 (2026-11-04); you kept every default (D-002):**

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

**For the studio (2026-11-05):**

9. **Niche:** **Scout proposes three in Stage 15 and you pick.** My suggestion is space and science
   explainers: NASA's public-domain archive solves footage, motion graphics suit explainers, the topics
   are evergreen and policy-safe, and it fits a space station. Avoid at the start: finance, health and
   news (sensitive topics), kids' content (made-for-kids limits), and Reddit stories or recaps
   (reused content).
10. **One brand on all three platforms:** **yes**, with one name and handle.
11. **Cadence:** **one long-form a week and one short a day** to start (§7.2).
12. **Voice:** **one ElevenLabs voice for the channel**, with Kokoro for drafts and overflow.
13. **Renderer:** **HyperFrames**, with plain FFmpeg as the fallback (D-052).
14. **Autonomy:** **you approve every post**, relaxed later per platform.
15. **Language:** **English first**; dubbing is a backlog experiment.
16. **The old businesses:** **parked, not deleted** (D-049).

## 12. Backlog (after Stage 20)

- Dubbing into other languages (ElevenLabs Dubbing, Kokoro's other voices): more channels from the
  same scripts.
- A second channel in another niche, from the same pipeline.
- Channel merch through the parked Printify pipeline, once there is an audience.
- Comment replies drafted by the crew, posted only after your approval.
- Facebook Reels, Threads, X and Pinterest through their APIs.
- A bigger GPU, owned or rented, for LTX-2.5 with sound; Hildegard becomes an option at 12 GB or more.
- **"TV mode"**: a cinematic camera that tours the station, as content in itself (the reel's idea).
- Nous Research's **Hermes Agent** (MIT, accepts custom OpenAI-compatible endpoints) as an alternative
  Overseer brain, through a bridge.
- A voice for the Overseer and daily spoken briefings (free now, with Kokoro).
- Save slots and multiple stations.

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

**The studio (checked 2026-11-05):** platforms, tools, licences and free allowances, with every
source, are in `docs/STUDIO-RESEARCH.md` §9.

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
- **2026-11-05:** Stage 3 built: the station runs on the server and survives restarts.
  - The sim engine (`StationSim`, the former mock director) lives in
    `packages/shared/src/sim`. It can save and restore, hire, reassign, and take commands from
    Stage 4's agent runtime.
  - `npm run dev` starts the station server (Fastify, WebSocket, SQLite) and the client.
  - The client follows the server's clock and reconnects on its own. It still runs offline with
    `?mock=1`.
  - New in the client: the Recruitment Bay, the station log, and room reassignment in the
    inspector.
  - 123 tests (15 new). **Next:** Stage 4 (agent brains).
- **2026-11-05:** Stage 4 built: the crew do real work through the free models.
  - Seven role templates in `config/roles/`. The agent runtime runs a tool loop with a step cap,
    validated tool arguments, repeat-call guards and a forced final step. Avatars type during calls,
    walk to the café while a provider makes them wait, and say each step's status line.
  - Tools: notes, memory search and save (embeddings), web research (Wikipedia only, untrusted
    text flagged), ask the Overseer, create a subtask, submit for review, escalate. External tools
    become Owner's Desk requests and run once, only after approval.
  - WARDEN plans objectives into tasks, assigns by role and load, runs tasks in order with the
    earlier deliverables as context, reviews (Lens for factory work), allows two reworks, writes
    the final deliverable, nudges stuck runs, posts a daily standup, and escalates to you.
  - The client gains the Work panel (objective box and task board), the Owner's Desk inbox and a
    deliverable viewer. A fixture LLM transport makes the end-to-end tests deterministic.
  - Real run on NVIDIA's sandbox models: "Find 10 winter candle niches for our Etsy candle store
    and rank them" became two tasks. Scout's ranked table passed review after two reworks and
    reached the Owner's Desk; Gift's task hit its step cap, escalated, and was retried from the
    Desk. That loop led to the repeat-call guard and the forced final step.
  - Restarts put in-progress work back in the queue, and retrying a task reopens its objective.
    132 tests (9 new).
  - **Next:** Stage 5 (creative toolchain).
- **2026-11-05:** Stage 5 built: the creative toolchain and the gallery.
  - `apps/server/src/creative/`: generate (lane-aware, styles from `config/prompts.yaml`, aspect
    ratios, seeds), upscale, cutout (edge flood fill, chroma key, rembg when allowed), compose
    (layers and auto-fit text), pixelate (area average and median-cut palette), sprite sheets
    with an atlas, vision QA (rubric scored by the vision tier, plus deterministic checks) and the
    IP screen (blocklist in `config/ip-blocklist.yaml` plus a model check).
  - Images are artifacts: PNGs under `data/artifacts/images`, with the source image, the room and
    the tool details recorded. Agents chain the tools by image id.
  - The Gallery (toolbar button): per-room grid, details and lineage, side-by-side comparison,
    approve or reject, and the one-click pipeline (prompt → image → cutout → 4× upscale → QA).
  - 151 tests (19 new).
  - Real run from the Gallery: a pine candle design on Cloudflare FLUX → edge cutout → 4× to 4096×4096 → vision QA 8/10 (pass; it flagged faint white halos on the pine needles), in about a minute.
  - Waiting for your OK: downloading Real-ESRGAN-ncnn-vulkan and rembg's model. Until then the
    built-in resampler and cutouts are used.
  - **Next:** Stage 6 (Etsy POD studio in the sandbox).
- **2026-11-05:** Stage 6 built: Factory 1 makes complete listing packages in the sandbox.
  - Three stores in `config/businesses/` (candles and mugs, gifts, wall art; placeholder names),
    six products with default print areas and costs in `config/products.yaml`, and Etsy's rules
    and fees in `config/marketplaces.yaml`.
  - `apps/server/src/pod/`: the §7.1 pipeline as code. Scout picks a concept; the store's
    operator writes prompts and generates four candidates; Lens picks the best by vision QA (one
    more round if none pass); production cuts out, trims, upscales and fits the print area; the
    operator writes the copy (fixed to Etsy's limits) and prices it from cost, Etsy fees and the
    store's margin; Lens runs compliance (IP screen, disclosures, QA, print file); the package
    (print file, two honest code-drawn mockups, listing.json, compliance.md, ZIP) goes to the
    Owner's Desk. Every step is a speech bubble, a task update or an artifact, and the package
    carries a trace.
  - Owner decisions: Accept marks a package ready for Stage 7; Send back starts a new listing
    with your note. A daily autopilot makes each store's listings in working hours (9:00 to
    21:00), one at a time; the Stores panel sets the number per day and has a pause switch.
  - Fixed on the way: the engine used to drop real finished tasks once 300 ambient tasks had
    finished after them; real work now has its own, larger history.
  - Real runs on the sandbox models: the first three packages (F-0007 to F-0009) showed tiny designs on wide print areas, lowercase keyword titles and clumsy tags, which led to the trim step, Title Case and front-trimmed tags. Five packages from the fixed pipeline (F-0010 to F-0014: a fireplace candle, a puppy-ornament mug made from the owner's revision note, two posters and a hot-chocolate mug), QA 9 to 10, IP clear. Three are ready as they are; F-0011's title ends in a model-written ellipsis (now stripped automatically) and F-0014 kept a white block from its cutout, which led to the new print-file QA in compliance. The publish dry run on F-0011 recorded its three Printify calls and a simulated listing fee.
  - **Next:** Stage 7 (Printify and Etsy, dry-run until you add a token and a shop).
- **2026-11-05:** Stage 7 built as far as it can go without your accounts: everything runs as a
  dry run.
  - `apps/server/src/printify/`: a Printify API client (shops, catalog, image upload, product
    creation, publishing, orders) whose writes are recorded instead of sent in dry-run mode, and
    the publisher.
  - Accepting a listing package at the Owner's Desk now files a second item, "Publish": nothing
    leaves the station until you approve that too. Each step runs once per approval (an outbox),
    so a retry never creates a second product.
  - Guards: the station kill switch (Stores panel; it also stops new listings), a paused store, a
    daily publish cap per store, and in live mode a token, a shop id, the live lane, a product
    mapped to a Printify blueprint, and a design made by a production-licensed (live-lane)
    provider. Sandbox images are never sold.
  - The Vault ledger (SQLite): sales, costs and fees per business, deduplicated; Printify order
    sync every 30 minutes in live mode. Dry-run entries are flagged as simulated.
  - Providers record what their terms say (`production: allowed | forbidden | unverified`) and
    config validation refuses the live lane without "allowed".
  - Etsy's Creativity Standards checked (2026-11-05): AI-assisted POD designs are "Designed by a
    seller" with Printify as the production partner; listing.json carries that mapping.
  - `npm run printify -- shops | blueprints | providers | variants` maps products to the catalog.
  - **Not done (needs you):** a Printify account linked to your Etsy shop, a token and shop id
    in `.env`, product mappings, the live lane (live-lane images), and one real listing through
    an approval click. Etsy receipt sync needs an approved Etsy app.
  - **Next:** Stage 8 (Thumbnail studio).
- **2026-11-05:** Stage 8 built: Factory 2 turns a brief into three thumbnails.
  - `apps/server/src/thumbs/studio.ts`: the brief (title, topic, channel style, brand colours,
    optional client photo, references) becomes three concepts (curiosity, emotion, contrast) with
    hooks of five words or fewer; each gets a generated 16:9 scene, the client's photo cut out (or
    one generated subject), and the hook composed with stroke and shadow at 1280×720.
  - Readability at phone size (168×94): WCAG contrast behind the hook and its height on a phone,
    plus vision QA with the hook as the expected text. A 2× phone preview is saved for each.
  - Delivery: a ZIP with the three PNGs, phone previews and layered sources (background, cut-out
    subject, layout JSON), and an Owner's Desk item. Sending it back with a note makes version 2:
    new hooks, colours or layout, keeping the backgrounds unless the note asks for a new scene.
  - The gig kit: Fiverr gig copy (title, description, FAQ, three pricing tiers) and a portfolio of
    the best thumbnails. Fiverr stays manual: no seller API, and bots break its terms.
  - Real run: "I Built a Tiny Cabin in 30 Days With No Experience" became three thumbnails in 63 seconds (QA 9, 8 and 9; contrast 4.2 to 5.5:1); the note "make the hook on #2 shorter, in white" produced version 2 in 28 seconds, reusing the backgrounds. Cloudflare's free daily image allocation was used up by then, so the scenes were drawn in code (the new fallback); real scenes come back at 00:00 UTC.
  - Stages 6 to 8 together: 188 tests (37 new).
  - **Next:** Stage 9 (Asset forge).
- **2026-11-05:** Stage 9 built: Factory 3 makes consistent pixel-art icon packs.
  - `apps/server/src/forge/forge.ts`: a pack plan (title, items, palette, outline, light, a locked
    style prompt, itch.io tags); a few multi-item sprite sheets on flat magenta instead of one image
    per icon (same style, a fraction of the image budget); chroma key and connected components to
    cut out each item wherever the model drew it; one shared pack palette and a uniform outline;
    Lens rates a numbered contact sheet for consistency, names every icon and flags outliers, which
    are swapped for spares.
  - The package: icons named by Lens, an 8-column sprite sheet with a JSON atlas, a preview,
    LICENSE.txt (use in games; no reselling the assets or training AI on them) and a README; the
    delivery carries itch.io page copy with the AI-generation disclosure. Accepting files an upload
    item: `butler push` as a dry run until butler is installed and configured.
  - Forge panel: theme, size (16/32/64) and icon count; packs with previews and ZIPs.
  - 194 tests (6 new).
  - **Not done yet:** the first real 32-icon pack. Cloudflare's free daily image allocation was
    used up by the Stage 6 and 8 runs (NVIDIA's image endpoint is down), so it waits for the
    00:00 UTC reset: open Forge and press "Forge a pack".
  - **Next:** Stage 10 (economy, KPIs, learning loop).
- **2026-11-05:** Stage 10 built: the Vault and the weekly learning loop.
  - `apps/server/src/vault/`: KPIs (money per business from the ledger, real and simulated kept
    apart; tasks done, rework, QA pass and approval rates per room and crew member; model calls
    and their shadow cost from `config/vault.yaml`), a repeatable week-of-sales simulator (flagged
    as simulated), and WARDEN's weekly retro.
  - The retro proposes listings per day per store, up to four experiments (price multipliers from
    0.8 to 1.2, title and niche instructions) and up to two crew moves, clamped to safe bounds. It
    goes to the Owner's Desk; accepting applies it (settings, experiments for 7 days, crew
    reassigned) and saves the lessons to the strategy memory, which WARDEN's planning reads.
    Experiments feed Factory 1's prices and prompts. The retro runs by itself on Sunday evenings
    once there are real sales.
  - Vault panel: the monthly goal beside the joke $1T meter (log scale), money per business (or
    the simulated week), room and crew KPIs, model calls with shadow cost, experiments, the
    simulate and retro buttons, and income entered by hand (Fiverr, itch.io).
  - Fixed on the way: 122 early ambient tasks (from before the mock flag) were counted as real
    work; a migration marks them.
  - Real run: a simulated week (Store C 20 orders and $315 net, Store B 2 orders) went to WARDEN's retro on the reasoning model, which proposed 3 store changes, 4 experiments and 2 crew moves; the clamp dropped a contradictory second price test and a personalization niche the stores can't deliver. Accepting it at the Desk applied listings of 2, 0 and 3 a day, a ×1.1 price test on Store C, a title test on Store A and two crew moves. Because it came from simulated sales, the store settings and crew were put back afterwards (the two experiments expire in 7 days).
  - 202 tests (8 new).
  - **Next:** Stage 11 (always-on ops and polish).
- **2026-11-05:** Stage 11 built: the station can run on its own.
  - `npm run station`: a supervisor that restarts the server after crashes (with back-off) and
    after three failed health checks, with daily log files kept for 14 days. No service is
    installed; docs/OPERATIONS.md has the Task Scheduler and pm2 steps.
  - Nightly backups at 03:00 (SQLite online backup plus new artifact files, 7 kept),
    `npm run backup`, and *Vault → Back up now*; `ORBITAL_BACKUP_DIR` moves them off the disk.
  - Quiet hours (23:00 to 07:00): no phone messages or sounds; a morning summary instead.
  - Telegram approvals: each new Owner's Desk item arrives with two buttons; only the configured
    chat and users count; `/status` lists what waits. Off until you add a bot token.
  - `ORBITAL_TOKEN`: when set, the API and the live feed need it (the client takes `?token=`
    once). Required before any remote access.
  - Polish: day and night lighting over the station by local time, synthesized sounds (a new Desk
    item, finished work, a stuck crew member) with a mute toggle, crew banter in the café and on
    the Bridge, and achievements (WARDEN announces them; the Vault lists them).
  - 211 tests (9 new).
  - **Not done (needs you):** the 72-hour unattended run, an approval from your phone (a
    Telegram bot token), the remote-access choice, and the hosting choice.
- **2026-11-05:** The free model pool. FreeLLMAPI (34 providers' free tiers behind one key) is set
  up in `infra/freellmapi` and wired in as the first sandbox choice for reasoning, creative and
  fast, sandbox-only by config, with the answering upstream logged per call. Starting the
  container and adding provider keys are yours: infra/freellmapi/README.md.
- **2026-11-05:** Production. `ORBITAL_MODE=production` (D-046): every model call runs in the live
  lane, the crew invent no tasks, and simulated sales are off. Groq's production models joined the
  live lane after a terms check, and Cloudflare's terms were re-checked before the first sale
  (D-045). Stages 2 to 11 merged into `main` and pushed to GitHub. The station runs under the
  supervisor (`npm run station`).
  - **First production run:** WARDEN got three real projects (an Etsy holiday plan, the Fiverr
    thumbnail gig, three itch.io icon packs). Live traffic showed Groq's 8K tokens-a-minute cap
    and its strict tool-schema check; both are fixed (D-048). Meta's multimodal Llama models left
    the live lane because their licences exclude the EU (D-047). Cloudflare's free image allocation
    was already spent today (36 images), so the Etsy autopilot waits for the 00:00 UTC reset.
  - **Still needs you:** a Printify token and shop id (with Etsy connected in Printify) to publish,
    a Telegram bot for phone approvals, and butler plus an itch.io page for the Forge's packs.
- **2026-11-05:** New direction: the station becomes a faceless channel studio (D-049 to D-053).
  - Researched the free stack: faceless-video repos (MoneyPrinterTurbo, short-video-maker,
    claude-faceless-shorts-creator, OpenShorts and others), the "free Higgsfield" repos
    (Open-Higgsfield-AI, Open-Generative-AI, Hildegard), Claude Motion and HyperFrames, YouTube's,
    TikTok's and Instagram's posting rules, ElevenLabs' Creator plan, free voice, music and video
    models, free GPU credits, and this laptop. The results are in `docs/STUDIO-RESEARCH.md`.
  - Key findings: YouTube lifted the private-only lock on uploads from unverified API projects
    (October 2026) and meters uploads at 100 a day; TikTok posts publicly from its API only after an
    audit, so drafts go to your inbox until then; Pexels has paused new API keys; the "free
    Higgsfield" repos are free interfaces to a paid API; Claude Motion has no API, so HyperFrames
    renders the same kind of code-built animation here.
  - The plan: Stages 12 to 20 (§9). The Etsy, gig and asset businesses are parked, not deleted.
  - **Next:** Stage 12 (your accounts and keys) alongside Stage 13 (studio core).
