# Running Orbital Foundry always-on

How to keep the station running on its own, back it up, get approvals on your phone, and reach it
from elsewhere. Stage 11 of [the roadmap](ROADMAP.md); decisions D-040 to D-043.

## Keep it running

```bash
npm run station
```

The supervisor (`scripts/supervise.mjs`) starts the station server and:

- restarts it when it exits, waiting 2 s, 4 s, 8 s… up to 60 s after crashes in a row;
- checks `http://127.0.0.1:8787/api/health` every minute and restarts it after three failures;
- writes everything to `data/logs/station-YYYY-MM-DD.log` and deletes logs older than 14 days
  (`ORBITAL_LOG_DAYS`).

It is a plain Node script, so nothing is installed as a Windows service. To start it when you log
in, create a Task Scheduler task yourself: *Create Task → Triggers: At log on → Actions: Start a
program*, program `cmd.exe`, arguments `/c cd /d "C:\Users\adnan\dev\New folder" && npm run station`.
If you prefer pm2: `npm i -g pm2`, then `pm2 start scripts/supervise.mjs --name orbital` (pm2's own
restart is then redundant but harmless).

Open the station with `npm run client` (http://localhost:5173), or `npm run dev` to run both.

## Production mode

`.env` has `ORBITAL_MODE=production`, which the station reads when it starts (D-046):

- every model call uses the live lane (Groq first, then Cloudflare), so whatever the crew make may
  be sold;
- the crew don't invent tasks, and the Vault has no simulated sales;
- `PRINTIFY_MODE=live` sends real writes to Printify once `PRINTIFY_API_TOKEN` and
  `PRINTIFY_SHOP_ID` are set, and only after your two approvals per product (D-033).

The station log's first line says which mode it is in. Cloudflare's free 10,000 neurons a day (about
170 images) are shared by the three factories; when they run out, image work waits for the 00:00 UTC
reset. Workers AI's paid plan lifts that cap (your call).

To go back to the sandbox for development, set `ORBITAL_MODE=development` (or remove the line) and
restart. Both modes share `data/orbital.db`, so don't run them at the same time.

## Quiet hours

`config/ops.yaml`, `quietHours: [23, 7]`. No phone messages or sounds in that window; waiting
items arrive as one summary when it ends. Factory 1's autopilot only starts listings between
09:00 and 21:00 anyway.

## Backups

- **Nightly** at 03:00 (`backups.hour`), keeping the last 7 database copies (`backups.keep`).
- **Now:** `npm run backup`, or *Vault → Back up now*.
- **What:** a consistent copy of `data/orbital.db` (SQLite's online backup, safe while running) and
  any new files under `data/artifacts` (they never change once written, so only new ones copy).
- **Where:** `data/backups`, or `ORBITAL_BACKUP_DIR` in `.env`. Point it at another disk or a synced
  folder (OneDrive, Dropbox): a backup on the same disk doesn't survive that disk.
- **Restore:** stop the station, copy the chosen `orbital-YYYY-MM-DD-HHMM.db` over
  `data/orbital.db` (delete `orbital.db-wal` and `orbital.db-shm` if present), copy
  `backups/artifacts` back to `data/artifacts`, start the station.

## Approvals on your phone (Telegram)

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the token it gives you.
2. Send any message to your new bot.
3. In your browser, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and find
   `"chat":{"id": …}` (your chat id) and `"from":{"id": …}` (your user id).
4. In `.env`: `TELEGRAM_BOT_TOKEN=…`, `TELEGRAM_CHAT_ID=…`, `TELEGRAM_ALLOWED_USERS=<your user id>`.
5. Restart the station. Every new Owner's Desk item arrives with two buttons (Accept or Send back,
   Approve or Reject, Retry or Cancel). `/status` lists what is waiting.

Only presses from that chat and those user ids count. The bot polls Telegram (no open port, no
webhook). The token stays in `.env` and is never logged.

## Reaching it from elsewhere

The station listens on 127.0.0.1 only. Before exposing it in any way:

1. Set `ORBITAL_TOKEN` in `.env` to a long random string. The API and the live feed then require
   it (`/api/health` stays open for the supervisor). Open the client once with
   `?token=<your token>`; the browser remembers it.
2. Prefer **Tailscale**: install it on the station machine and your phone, then
   `tailscale serve --bg 5173` keeps the client private to your own devices, with no public port.
3. Or **Cloudflare Tunnel** with **Cloudflare Access** (email one-time codes) in front, so nobody
   reaches the station without logging in first, plus the token behind it.

The client is served by Vite (`npm run client`); serving the built client from the station server
is a follow-up.

## Where to host it

| Option | Good | Watch out |
|---|---|---|
| This laptop | Free, already set up, GPU for Real-ESRGAN | Sleep and reboots stop the station; set the power plan to never sleep on AC |
| A small always-on mini PC | Low power, always on | No GPU: upscales use the built-in resampler (already the default) |
| A cheap cloud VM | Always on, reachable | Costs money; the free model tiers may treat datacenter IPs differently; never expose it without the token and Access |

Everything except Real-ESRGAN runs on the CPU (`@napi-rs/canvas`), so the station moves to a machine
without a GPU unchanged.

## The 72-hour check

The roadmap's bar for Stage 11 is three days unattended without a crash, and one approval from your
phone. To run it: start `npm run station`, leave it, then check `data/logs` for restarts,
*Vault → Operations* for the last backup, and approve one Desk item from Telegram.
