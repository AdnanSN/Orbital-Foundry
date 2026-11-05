# Orbital Foundry: notes for Claude

An always-on pixel-art space station where AI agents run a faceless video channel studio: ideas,
scripts, voice-over, video and posting to YouTube, TikTok and Instagram. (Since 2026-11-05; the
online-shop factories from Stages 6 to 9 are parked, D-049.)
**Start every session by reading `docs/ROADMAP.md`** (plan, stage status, session log) and
`docs/DECISIONS.md`. Work on the current stage only. `docs/STUDIO-RESEARCH.md` holds the studio's
tools, licences, free allowances and platform rules, with sources.

## Commands (run from the repo root)

| Command | What it does |
|---|---|
| `npm run check` | Biome lint, typecheck (all workspaces) and tests. Run it before finishing any stage. |
| `npm test` | Unit tests (Vitest) in every workspace. They never call real APIs. |
| `npm run dev` | Starts the station server and the client together; open http://localhost:5173. |
| `npm run server` | Starts the station server alone (Fastify, WebSocket, SQLite) on http://127.0.0.1:8787. It restarts on code changes; `npm start` runs it without watching. |
| `npm run client` | Starts the client alone (Vite) at http://localhost:5173. Add `?mock=1` to run it without a server. |
| `npm run client:build` | Production build of the client into `apps/client/dist/`. |
| `npm run census` | Probes every candidate model (chat, JSON, tools, vision, embeddings) and writes `config/models.census.json`. Flags: `--provider nvidia`, `--tier vision`, `--ref nvidia:openai/gpt-oss-20b`, `--list-only`. |
| `npm run smoke` | One real call per tier plus one image per endpoint, saved to `data/artifacts/smoke/`. Flags: `--lane live`, `--no-images`. |
| `npm run models -- nvidia [filter]` | Lists a provider's model IDs. |
| `npm run printify -- shops` | Browses Printify with your token (shops, blueprints, providers, variants). Read-only. |
| `npm run station` | Keeps the station server running (restarts, health checks, daily logs). See docs/OPERATIONS.md. |
| `npm run backup` | Backs up the database and new artifact files now. |
| `npm run pool:up` | Starts the FreeLLMAPI pool of free model tiers in Docker (`pool:down`, `pool:logs`). See infra/freellmapi/README.md. |
| `npm run format` | Biome auto-fix and formatting. |

## Layout

- `apps/server`: Node 22 + TypeScript, run with tsx.
  - `src/llm/`: `router.ts` (lanes, tiers, fallback, JSON repair), `rateLimiter.ts`
    (`ProviderGate`), `circuitBreaker.ts`, `transport.ts` (OpenAI-compatible client), `usage.ts`
    (SQLite call log), `probes.ts`.
  - `src/images/`: lane-aware FLUX clients for NVIDIA genai and Cloudflare Workers AI.
  - `src/scripts/`: census, smoke, models.
  - `src/station.ts` wires the model router together; `src/main.ts` boots the station server.
  - `src/sim/`: `SimServer` (clock, persistence, broadcasts) and `SimStore` (SQLite).
  - `src/http/app.ts`: REST routes and the `/ws` event stream.
  - `src/work/`: the agent runtime (`runtime.ts`), tools (`tools.ts`), WARDEN's loop
    (`director.ts`), the work store (objectives, approvals, artifacts, memory, notes) and web access.
  - `src/llm/fixtures.ts`: the fixture transport for deterministic end-to-end tests.
  - `src/creative/`: the image toolchain (`raster.ts` pixel ops, `compose.ts`, `qa.ts` vision QA
    and IP screen, `external.ts` Real-ESRGAN and rembg runners, `studio.ts`, agent `tools.ts`).
  - `src/pod/`: Factory 1, the Etsy POD pipeline (`factory.ts`), listing rules and pricing
    (`listing.ts`), code-drawn mockups (`mockups.ts`) and its config loader.
  - `src/printify/`: the Printify client (dry run or live) and the publisher (guards, outbox, order
    sync). `src/vault/`: the ledger and outbox (`ledger.ts`), KPIs and shadow cost (`kpis.ts`), the
    sales simulator and weekly retro (`economy.ts`). `src/ops/`: backups and quiet hours
    (`ops.ts`), Telegram approvals (`telegram.ts`), achievements.
  - `src/thumbs/studio.ts`: Factory 2, the Thumbnail Studio (concepts, layout, readability, ZIP
    delivery, revisions, gig kit). `src/forge/forge.ts`: Factory 3, the Asset Forge (sheets, cutting
    out items, pack palette, review, package, butler dry run).
  - `src/uplink/tiktok.ts`: the studio's TikTok connection (sign-in, token refresh, draft uploads to
    the owner's inbox); routes in `src/http/uplink.ts`. Tokens live in `data/secrets/`.
- `site/`: the studio's public website (privacy policy, terms, data deletion, TikTok's sign-in
  callback page), published to GitHub Pages from `main` by `.github/workflows/pages.yml`.
- `apps/client`: Vite + Phaser 4 + a React overlay (Tailwind).
  - `src/sim/`: the world model built from station events, the sim clock, and `StationLink`
    (the mock link now, a WebSocket link in Stage 3).
  - `src/art/`: everything drawn in code: crew sprites, the pixel font, tiles, furniture, effects.
  - `src/game/`: the Phaser scene, agent views, textures. `src/ui/`: the React panels.
  - URL options: `?seed=`, `?speed=`, `?warp=`, `?focus=`, `?select=`, `?zoom=`, and
    `?view=sprites` for the sprite sheet.
- `packages/shared`: zod schemas and types shared by the server and the client: model config
  (`llm.ts`), the station (`station/`: map JSON and loader, A* pathfinding, crew, roles, events),
  and the sim engine (`sim/`: `StationSim`, used by the server and by the client's mock mode).
- `config/`: `providers.yaml`, `tiers.yaml`, the generated `models.census.json`, role templates
  (`roles/*.yaml`), the web allowlist (`web.yaml`), the creative settings (`creative.yaml`), the
  prompt library (`prompts.yaml`), the IP blocklist (`ip-blocklist.yaml`), the stores
  (`businesses/*.yaml`), products (`products.yaml`) and marketplace rules (`marketplaces.yaml`).
- `infra/freellmapi/`: the Docker setup for the FreeLLMAPI free-tier pool (sandbox lane only, D-044).
- `data/`: SQLite database and artifacts (git-ignored).

## Rules that matter

1. **Lanes.** `sandbox` is for development and tests, and its outputs are never sold. `live` is
   anything that reaches customers or marketplaces. NVIDIA's free trial is sandbox-only because its
   terms forbid production use and distributing outputs. Never add `live` to a provider without
   checking its terms and recording that in `docs/DECISIONS.md`. Config validation and the router
   both enforce lanes; don't bypass them. `ORBITAL_MODE=production` in `.env` puts every station
   model call in the live lane, turns off invented crew work and simulated sales (D-046).
2. **Models are data.** Never hardcode model IDs in code. Add them to `config/tiers.yaml` and
   re-run the census.
3. **External side effects need the owner's approval** (from Stage 4 on): publishing, messaging
   customers, spending money. Publishing is a dry run unless `PRINTIFY_MODE=live`, and the kill
   switch (`POST /api/kill`) stops it all. Channel posts go through the platforms' official APIs
   only, never browser automation (D-051).
4. **Secrets** live only in `.env`, which is git-ignored. Never print, log or commit keys.
5. **Free tiers are scarce.** Every model call goes through a `ProviderGate` and is logged to
   `llm_calls`. Tests use fakes (`apps/server/test/helpers.ts`).
6. **The client only renders station events.** It never calls models, reads `.env` or imports
   server code. Event shapes live in `packages/shared/src/station/events.ts`.
7. **The station map is data.** Edit `packages/shared/src/station/station.map.json`; the station
   tests check the layout (reachable anchors, open doorways, furniture on floors).

## Conventions

- TypeScript strict, ESM, `import type` for type-only imports (`verbatimModuleSyntax`).
- Biome formatting: 2 spaces, double quotes, 100 columns. Line endings are LF (`.gitattributes`).
- Tests live in each workspace's `test/` folder (`*.test.ts`).
- The dev machine runs Windows. Prefer npm scripts over ad-hoc shell commands.

## Finishing a stage

1. Tick its boxes in `docs/ROADMAP.md` and add a Session Log line.
2. Record new decisions in `docs/DECISIONS.md`.
3. Run `npm run check`, then commit.
