import { getStationMap, STARTING_CREW, StationSim } from "@orbital/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createGame } from "./game/createGame";
import { SimClock } from "./sim/clock";
import { MockLink, SocketLink, type StationLink } from "./sim/link";
import { World } from "./sim/world";
import { App } from "./ui/App";
import { SpriteSheet } from "./ui/SpriteSheet";
import { UiStore } from "./ui/store";
import "./styles.css";

/**
 * Boot: the station server feeds station events over WebSocket into the world model, which the
 * Phaser scene and the React panels both read. With ?mock=1 a local sim engine stands in for the
 * server (no server needed).
 *
 * URL options: ?mock=1, ?seed=N and ?warp=SECONDS (mock runs), ?speed=1|2|4,
 * ?focus=ID and ?select=ID (a crew or room id), ?zoom=N, ?follow=1, ?view=sprites (sprite sheet).
 */
const params = new URLSearchParams(window.location.search);
const uiRoot = document.getElementById("ui");
const gameRoot = document.getElementById("game");
if (!uiRoot || !gameRoot) throw new Error("index.html is missing #ui or #game");

if (params.get("view") === "sprites") {
  gameRoot.remove();
  createRoot(uiRoot).render(
    <StrictMode>
      <SpriteSheet />
    </StrictMode>,
  );
} else {
  const map = getStationMap();
  const mock = params.get("mock") === "1";
  const seed = Number(params.get("seed") ?? Math.floor(Math.random() * 1_000_000));
  const clock = new SimClock(0);
  const world = new World(map);
  let link: StationLink;
  let sim: StationSim | null = null;
  if (mock) {
    sim = new StationSim(map, STARTING_CREW, { seed, start: clock.now(), banter: true });
    link = new MockLink(sim, world, clock);
    link.start();
    const speed = Number(params.get("speed") ?? 1);
    if ([1, 2, 4].includes(speed)) void link.commands.setSim({ speed });
    const warp = Number(params.get("warp") ?? 0);
    if (warp > 0) {
      clock.advance(warp * 1000);
      link.update(clock.now());
    }
  } else {
    link = new SocketLink(world, clock);
    link.start();
  }
  const ui = new UiStore();
  const zoom = Number(params.get("zoom") ?? 0);
  const initial = {
    ...(params.get("focus") ? { focus: params.get("focus") as string } : {}),
    ...(params.get("select") ? { select: params.get("select") as string } : {}),
    ...(zoom > 0 ? { zoom } : {}),
    follow: params.get("follow") === "1",
  };
  const game = createGame(gameRoot, { map, world, link, clock, ui, initial });
  createRoot(uiRoot).render(
    <StrictMode>
      <App world={world} clock={clock} ui={ui} link={link} seed={mock ? seed : null} />
    </StrictMode>,
  );
  if (import.meta.env.DEV) {
    // Handy for poking at the station from the browser console.
    Object.assign(window, { orbital: { world, clock, sim, link, ui, game } });
  }
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      link.stop();
      game.destroy(true);
    });
  }
}
