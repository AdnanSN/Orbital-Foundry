# Orbital Foundry

An always-on pixel-art space station where AI agents run small online businesses: Etsy
print-on-demand, a thumbnail studio and a game-asset forge. The agents answer to an Overseer, and
you approve anything that leaves the station.

**Status:** Stages 1 to 10 are built. The crew make images (generate, cut out, upscale, compose,
pixelate, QA) and complete Etsy listing packages for your review. Publishing through Printify
runs as a dry run until you add a Printify token and shop (see `.env.example`). The station runs on a server that saves it, and the crew do
real work through free models: give WARDEN an objective and watch it get planned, worked,
reviewed and delivered to your Owner's Desk. The full plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

![The station with its mock crew](docs/stage-2-station.png)

## Quick start

1. Install Node 22 or newer, then run `npm install`.
2. Run `npm run dev` and open http://localhost:5173 to watch the station. Without keys the crew
   keep busy with ambient mock work; real objectives need the keys from step 3.
   - Click **Work** to give WARDEN an objective and follow the task board.
   - Click **Desk** for the Owner's Desk: results to accept, actions to approve, crew who are stuck.
   - Click **Thumbs** for Factory 2: a video title becomes three YouTube thumbnails; add a note
     to revise them.
   - Click **Forge** for Factory 3: a theme becomes a pixel-art icon pack with a licence and
     itch.io copy.
   - Click **Vault** for money, KPIs and model usage; simulate a week and ask WARDEN for a weekly
     plan.
   - Click **Gallery** for the studio's images: run the one-click image pipeline, compare, approve.
   - Click **Stores** for Factory 1's three Etsy stores: start a listing, set listings per day,
     pause a store, and open its listing packages (print file, mockups, copy, compliance, ZIP).
   - Click **Hire** to recruit crew. They arrive through the airlock.
   - To run everything in the browser instead, use `npm run client` and open it with `?mock=1`.
   - Drag or use WASD to pan, scroll to zoom, and press F to fit the whole station.
   - Click a crew member for the inspector, or a room for its panel.
3. For the model router, fill in `.env` (see `.env.example`).
   - At minimum, set `NVIDIA_API_KEY`.
   - For live-lane images, also set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
4. Run `npm run census` to see which free models actually work.
5. Run `npm run smoke` for one real call per tier and two test images.
6. Run `npm run check` for lint, typecheck and tests.

## Two lanes

NVIDIA's free API is a trial. It's fine for building and testing, but not for producing things we
sell. Every model call therefore names a lane:

- **sandbox:** development and tests. NVIDIA or any other provider. Outputs are never sold.
- **live:** only providers whose terms allow production use. Today that means Cloudflare Workers AI.

The router enforces this; see `docs/DECISIONS.md` (D-001).
