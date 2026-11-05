# The free model pool (FreeLLMAPI)

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT, about 48k stars) runs on your
machine in Docker and puts the free tiers of up to 34 AI providers behind one OpenAI-compatible
endpoint and one key. When one provider's free quota runs out it moves to the next. Our station
uses it as the **first choice in the sandbox lane** for the reasoning, creative and fast tiers,
and as a fallback for vision. Decision D-044 in `docs/DECISIONS.md`.

## Set it up (about 15 minutes, mostly signing up for keys)

1. **Start the pool** (Docker Desktop must be running):

   ```bash
   npm run pool:up
   ```

   This pulls `ghcr.io/tashfeenahmed/freellmapi:v0.16.19` and starts it on
   http://localhost:3001 (this machine only). Its encryption key was generated in
   `infra/freellmapi/.env`, which is git-ignored; keep that file, because it decrypts the provider
   keys stored in the pool.

2. **Open http://localhost:3001** and create the dashboard login (it stays on your machine).

3. **Add free provider keys** on the **Keys** page. Each takes a minute or two and most need no
   card. Good ones to start with:

   | Provider | Where to get a free key |
   |---|---|
   | Google (Gemini) | aistudio.google.com → Get API key |
   | Groq | console.groq.com → API Keys (you already have one in `.env`) |
   | Mistral | console.mistral.ai → choose the free Experiment plan → API Keys |
   | OpenRouter | openrouter.ai → Keys (free models: about 50 requests a day) |
   | Cerebras | cloud.cerebras.ai → API Keys |
   | Cohere | dashboard.cohere.com → API Keys (trial key) |
   | NVIDIA, Cloudflare | you already have these in `.env`; adding them to the pool too is optional |

   The Keys page lists the rest. Paste each key yourself; nobody else should handle them.

4. **Copy the unified key** from the Keys page header (it starts with `freellmapi-`) into the
   station's `.env`:

   ```
   FREELLM_API_KEY=freellmapi-…
   ```

5. **Check what works** and restart the station:

   ```bash
   npm run census -- --provider freellm
   npm run start
   ```

   The census probes `auto`, `auto:smart` and `auto:fast` for chat, JSON, tool calls and vision.
   Anything that fails is skipped automatically.

`npm run pool:logs` shows the pool's log; `npm run pool:down` stops it.

## What to know

- **Sandbox only.** FreeLLMAPI's own README says it is "for personal experimentation and learning,
  not production", and the pool decides per request which provider answers. So it serves the
  sandbox lane (planning, research, drafts, tests) and is refused for the live lane by config
  validation. Anything we sell still goes through live-lane providers (Cloudflare today).
- **You can see who answered.** Every reply names its upstream (`X-Routed-Via`), and the station
  stores it in `llm_calls.routed_via`.
- **Privacy.** Your keys stay encrypted in the container and go only to their own providers. The
  pool downloads a signed model list from freellmapi.co twice a day; per its README that server
  never sees prompts, replies or keys. Some free upstreams log prompts (several say so), so keep
  personal data out of agent work.
- **Quality varies by hour.** The best free models hit their daily limits in the evening (UTC), so
  late runs get weaker models. Our router still falls back to our own providers after the pool.
- **Not needed:** the Premium live catalog ($19/year), the desktop app, and the Watchtower
  auto-update sidecar (left out because it needs the Docker socket). To update, change the image
  tag in `docker-compose.yml` and run `npm run pool:up` again.
- **Claude Code itself** can also run on the pool (`npx freellmapi setup-claude`), but that changes
  your Claude Code settings; it is a separate choice from the station's agents.
