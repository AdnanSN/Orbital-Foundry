# Orbital Foundry: notes for Claude

An always-on pixel-art space station where AI agents run small online businesses.
**Start every session by reading `docs/ROADMAP.md`** (plan, stage status, session log) and
`docs/DECISIONS.md`. Work on the current stage only.

## Commands (run from the repo root)

| Command | What it does |
|---|---|
| `npm run check` | Biome lint, typecheck and tests. Run it before finishing any stage. |
| `npm test` | Server unit tests (Vitest). They never call real APIs. |
| `npm run census` | Probes every candidate model (chat, JSON, tools, vision, embeddings) and writes `config/models.census.json`. Flags: `--provider nvidia`, `--tier vision`, `--ref nvidia:openai/gpt-oss-20b`, `--list-only`. |
| `npm run smoke` | One real call per tier plus one image per endpoint, saved to `data/artifacts/smoke/`. Flags: `--lane live`, `--no-images`. |
| `npm run models -- nvidia [filter]` | Lists a provider's model IDs. |
| `npm run format` | Biome auto-fix and formatting. |

## Layout

- `apps/server`: Node 22 + TypeScript, run with tsx.
  - `src/llm/`: `router.ts` (lanes, tiers, fallback, JSON repair), `rateLimiter.ts`
    (`ProviderGate`), `circuitBreaker.ts`, `transport.ts` (OpenAI-compatible client), `usage.ts`
    (SQLite call log), `probes.ts`.
  - `src/images/`: lane-aware FLUX clients for NVIDIA genai and Cloudflare Workers AI.
  - `src/scripts/`: census, smoke, models.
  - `src/station.ts` wires everything together.
- `packages/shared`: zod schemas and types, shared with the future client.
- `config/`: `providers.yaml`, `tiers.yaml`, and the generated `models.census.json`.
- `data/`: SQLite database and artifacts (git-ignored).

## Rules that matter

1. **Lanes.** `sandbox` is for development and tests, and its outputs are never sold. `live` is
   anything that reaches customers or marketplaces. NVIDIA's free trial is sandbox-only because its
   terms forbid production use and distributing outputs. Never add `live` to a provider without
   checking its terms and recording that in `docs/DECISIONS.md`. Config validation and the router
   both enforce lanes; don't bypass them.
2. **Models are data.** Never hardcode model IDs in code. Add them to `config/tiers.yaml` and
   re-run the census.
3. **External side effects need the owner's approval** (from Stage 4 on): publishing, messaging
   customers, spending money.
4. **Secrets** live only in `.env`, which is git-ignored. Never print, log or commit keys.
5. **Free tiers are scarce.** Every model call goes through a `ProviderGate` and is logged to
   `llm_calls`. Tests use fakes (`apps/server/test/helpers.ts`).

## Conventions

- TypeScript strict, ESM, `import type` for type-only imports (`verbatimModuleSyntax`).
- Biome formatting: 2 spaces, double quotes, 100 columns. Line endings are LF (`.gitattributes`).
- Tests live in `apps/server/test/*.test.ts`.
- The dev machine runs Windows. Prefer npm scripts over ad-hoc shell commands.

## Finishing a stage

1. Tick its boxes in `docs/ROADMAP.md` and add a Session Log line.
2. Record new decisions in `docs/DECISIONS.md`.
3. Run `npm run check`, then commit.
