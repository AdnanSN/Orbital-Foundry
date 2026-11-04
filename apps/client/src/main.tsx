import { getStationMap, STARTING_CREW } from "@orbital/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createGame } from "./game/createGame";
import { MockDirector } from "./mock/director";
import { SimClock } from "./sim/clock";
import { MockLink } from "./sim/link";
import { World } from "./sim/world";
import { App } from "./ui/App";
import { SpriteSheet } from "./ui/SpriteSheet";
import { UiStore } from "./ui/store";
import "./styles.css";

/**
 * Stage 2 boot: a mock director stands in for the server and feeds station events into the
 * world model, which the Phaser scene and the React panels both read.
 *
 * URL options: ?seed=N (mock run), ?speed=1|2|4, ?warp=SECONDS (start that far in),
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
  const seed = Number(params.get("seed") ?? Math.floor(Math.random() * 1_000_000));
  const clock = new SimClock(0);
  const speed = Number(params.get("speed") ?? 1);
  if ([1, 2, 4].includes(speed)) clock.setSpeed(speed);
  const world = new World(map);
  const director = new MockDirector(map, STARTING_CREW, { seed, start: clock.now() });
  const link = new MockLink(director, world);
  link.start();
  const warp = Number(params.get("warp") ?? 0);
  if (warp > 0) {
    clock.advance(warp * 1000);
    link.update(clock.now());
  }
  const ui = new UiStore();
  const zoom = Number(params.get("zoom") ?? 0);
  const initial = {
    ...(params.get("focus") ? { focus: params.get("focus") as string } : {}),
    ...(params.get("select") ? { select: params.get("select") as string } : {}),
    ...(zoom > 0 ? { zoom } : {}),
    follow: params.get("follow") === "1",
  };
  const game = createGame(gameRoot, { map, crew: STARTING_CREW, world, link, clock, ui, initial });
  createRoot(uiRoot).render(
    <StrictMode>
      <App world={world} clock={clock} ui={ui} seed={seed} />
    </StrictMode>,
  );
  if (import.meta.env.DEV) {
    // Handy for poking at the mock station from the browser console.
    Object.assign(window, { orbital: { world, clock, director, ui, game } });
  }
  if (import.meta.hot) import.meta.hot.dispose(() => game.destroy(true));
}
