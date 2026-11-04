import Phaser from "phaser";
import { type SceneDeps, StationScene } from "./StationScene";

/**
 * Boots Phaser into `parent`. The canvas renders at device resolution (CSS size × DPR) so the
 * pixel art stays crisp on high-DPI screens; `smoothPixelArt` keeps pixels square at any zoom.
 */
export function createGame(parent: HTMLElement, deps: Omit<SceneDeps, "dpr">): Phaser.Game {
  const dpr = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const size = () => ({
    width: Math.max(320, Math.floor(parent.clientWidth * dpr())),
    height: Math.max(240, Math.floor(parent.clientHeight * dpr())),
  });
  const initial = size();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: "#05060f",
    banner: false,
    audio: { noAudio: true },
    disableContextMenu: true,
    render: { smoothPixelArt: true, antialias: true },
    scale: {
      mode: Phaser.Scale.NONE,
      width: initial.width,
      height: initial.height,
      zoom: 1 / dpr(),
    },
    input: { mouse: { preventDefaultWheel: true } },
    scene: new StationScene({ ...deps, dpr }),
  });

  let lastDpr = dpr();
  const onResize = () => {
    const s = size();
    if (dpr() !== lastDpr) {
      lastDpr = dpr();
      game.scale.setZoom(1 / lastDpr);
    }
    game.scale.resize(s.width, s.height);
  };
  window.addEventListener("resize", onResize);
  game.events.once(Phaser.Core.Events.DESTROY, () =>
    window.removeEventListener("resize", onResize),
  );
  return game;
}
