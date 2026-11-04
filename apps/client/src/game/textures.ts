import type { CrewMember, StationMap } from "@orbital/shared";
import type Phaser from "phaser";
import { withAlpha } from "../art/color";
import {
  composeFrame,
  crewPalette,
  FRAME_COUNT,
  frameName,
  frameSpecs,
  paintFrame,
  SPRITE_SIZE,
} from "../art/crew";
import { LINE_HEIGHT, measureText, normalizeText, wrapText } from "../art/font";
import {
  AGENT_SHADOW,
  DATABANK,
  doorPanels,
  FAN,
  FORGE_GLOW,
  type FxStrip,
  holoBridge,
  holoGlobe,
  INTAKE_CRATE,
  paintStrip,
  type RackState,
  rackLights,
  SELECT_RING,
  STEAM,
  scanBeam,
  screenOff,
  screenOn,
  stripSize,
  wallScreen,
} from "../art/fx";
import { ICON_NAMES, ICON_SIZE, paintIcon } from "../art/icons";
import { Pen } from "../art/pen";
import { paintStars } from "../art/stars";
import { paintStation } from "../art/stationArt";
import { themeFor } from "../art/themes";

/** Everything drawn in code, turned into Phaser textures and animations at boot. */

export const STATION_TEXTURE = "station";
export const STAR_TEXTURES = ["stars-far", "stars-near"] as const;
export const ICONS_TEXTURE = "icons";

export function crewTexture(id: string): string {
  return `crew-${id}`;
}

export function crewAnim(id: string, anim: string, facing: string): string {
  return `${id}:${anim}:${facing}`;
}

function canvasTexture(scene: Phaser.Scene, key: string, width: number, height: number) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, width, height);
  if (!tex) throw new Error(`Could not create texture ${key}`);
  tex.context.imageSmoothingEnabled = false;
  return tex;
}

/** Registers a horizontal frame strip as a texture with frames "0".."n-1" plus a looping anim. */
export function addStrip(scene: Phaser.Scene, key: string, fx: FxStrip, frameRate: number): void {
  if (scene.textures.exists(key)) return;
  const { width, height } = stripSize(fx);
  const tex = canvasTexture(scene, key, width, height);
  paintStrip(tex.context, fx);
  for (let f = 0; f < fx.frames; f++) tex.add(String(f), 0, f * fx.frameW, 0, fx.frameW, fx.frameH);
  tex.refresh();
  if (fx.frames > 1 && !scene.anims.exists(key)) {
    scene.anims.create({
      key,
      frames: Array.from({ length: fx.frames }, (_, f) => ({ key, frame: String(f) })),
      frameRate,
      repeat: -1,
    });
  }
}

export function buildTextures(
  scene: Phaser.Scene,
  map: StationMap,
  crew: readonly CrewMember[],
): void {
  const station = canvasTexture(
    scene,
    STATION_TEXTURE,
    map.width * map.tileSize,
    map.height * map.tileSize,
  );
  paintStation(station.context, map);
  station.refresh();

  STAR_TEXTURES.forEach((key, layer) => {
    const tex = canvasTexture(scene, key, 256, 256);
    paintStars(tex.context, 256, layer as 0 | 1);
    tex.refresh();
  });

  for (const c of crew) buildCrew(scene, c);
  buildIcons(scene);
  buildFx(scene, map);
}

function buildCrew(scene: Phaser.Scene, c: CrewMember): void {
  const specs = frameSpecs();
  const key = crewTexture(c.id);
  const tex = canvasTexture(scene, key, specs.length * SPRITE_SIZE, SPRITE_SIZE);
  const palette = crewPalette(c.look);
  specs.forEach((spec, i) => {
    paintFrame(tex.context, composeFrame(c.look, spec), palette, i * SPRITE_SIZE, 0);
    tex.add(frameName(spec), 0, i * SPRITE_SIZE, 0, SPRITE_SIZE, SPRITE_SIZE);
  });
  tex.refresh();

  const frames = (facing: string, anim: string, item?: string, order?: number[]) => {
    const count = FRAME_COUNT[anim as keyof typeof FRAME_COUNT];
    const indices = order ?? Array.from({ length: count }, (_, i) => i);
    return indices.map((index) => ({
      key,
      frame: frameName({
        facing: facing as never,
        anim: anim as never,
        index,
        ...(item ? { item: item as never } : {}),
      }),
    }));
  };
  for (const facing of ["down", "up", "left", "right"]) {
    // Idle: mostly still, a slow breath, and an occasional blink (10 fps, repeated frames).
    const idleOrder = [0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 3];
    scene.anims.create({
      key: crewAnim(c.id, "idle", facing),
      frames: frames(facing, "idle", undefined, idleOrder),
      frameRate: 10,
      repeat: -1,
    });
    scene.anims.create({
      key: crewAnim(c.id, "walk", facing),
      frames: frames(facing, "walk"),
      frameRate: 9,
      repeat: -1,
    });
    scene.anims.create({
      key: crewAnim(c.id, "type", facing),
      frames: frames(facing, "type"),
      frameRate: 7,
      repeat: -1,
    });
    for (const item of ["crate", "datapad", "cup"]) {
      scene.anims.create({
        key: crewAnim(c.id, `carry-${item}`, facing),
        frames: frames(facing, "carry", item),
        frameRate: 9,
        repeat: -1,
      });
      scene.anims.create({
        key: crewAnim(c.id, `hold-${item}`, facing),
        frames: frames(facing, "hold", item),
        frameRate: 1,
        repeat: -1,
      });
    }
  }

  // Name tag: the name on a dark plate.
  const name = normalizeText(c.name);
  const w = measureText(name) + 6;
  const tag = canvasTexture(scene, `tag-${c.id}`, w, 9);
  const pen = new Pen(tag.context);
  pen.pill(0, 0, w, 9, "rgba(14, 12, 28, 0.82)", "rgba(14, 12, 28, 0.82)");
  pen.hline(2, 8, w - 4, withAlpha(c.look.accent, 0.9));
  pen.text(3, 2, name, c.id === "warden" ? "#ffe066" : "#f4f1ff");
  tag.refresh();
}

function buildIcons(scene: Phaser.Scene): void {
  const tex = canvasTexture(scene, ICONS_TEXTURE, ICON_NAMES.length * ICON_SIZE, ICON_SIZE);
  const pen = new Pen(tex.context);
  ICON_NAMES.forEach((name, i) => {
    paintIcon(pen.at(i * ICON_SIZE, 0), name);
    tex.add(name, 0, i * ICON_SIZE, 0, ICON_SIZE, ICON_SIZE);
  });
  tex.refresh();
  scene.anims.create({
    key: "icon:dots",
    frames: ["dots0", "dots1", "dots2"].map((frame) => ({ key: ICONS_TEXTURE, frame })),
    frameRate: 4,
    repeat: -1,
  });
}

function buildFx(scene: Phaser.Scene, map: StationMap): void {
  const accents = new Set(map.rooms.map((r) => themeFor(r.theme).accent));
  for (const accent of accents) {
    addStrip(scene, `screen-on-${accent}`, screenOn(accent), 6);
    addStrip(scene, `screen-off-${accent}`, screenOff(accent), 1.2);
    addStrip(scene, `holo-globe-${accent}`, holoGlobe(accent), 6);
    addStrip(scene, `holo-bridge-${accent}`, holoBridge(accent), 5);
    addStrip(scene, `scan-${accent}`, scanBeam(accent), 10);
  }
  for (const state of ["ok", "limited", "down"] as RackState[]) {
    addStrip(
      scene,
      `rack-${state}`,
      rackLights(state),
      state === "limited" ? 2 : state === "down" ? 10 : 5,
    );
  }
  addStrip(scene, "databank", DATABANK, 4);
  addStrip(scene, "steam", STEAM, 6);
  addStrip(scene, "forge-glow", FORGE_GLOW, 8);
  addStrip(scene, "fan", FAN, 12);
  addStrip(scene, "intake-crate", INTAKE_CRATE, 1);
  addStrip(scene, "agent-shadow", AGENT_SHADOW, 1);
  addStrip(scene, "select-ring", SELECT_RING, 6);
  for (const o of map.objects) {
    if (o.kind === "wallscreen") {
      const accent = themeFor(map.room(o.room).theme).accent;
      addStrip(scene, `wall-${o.id}`, wallScreen(o.w * map.tileSize - 4, o.variant, accent), 1);
    }
  }
  for (const d of map.doorways()) {
    const len = d.orientation === "horizontal" ? d.w : d.h;
    addStrip(scene, `door-${d.orientation}-${len}`, doorPanels(d.orientation, len), 1);
  }
}

/** A speech bubble texture for one line of dialogue; returns its key and size. */
export function makeBubble(
  scene: Phaser.Scene,
  key: string,
  text: string,
): { width: number; height: number } {
  const lines = wrapText(text, 92);
  const textW = Math.max(...lines.map(measureText), 8);
  const w = textW + 8;
  const h = lines.length * LINE_HEIGHT + 5 + 4;
  const tex = canvasTexture(scene, key, w, h);
  const pen = new Pen(tex.context);
  const bodyH = h - 4;
  pen.pill(0, 0, w, bodyH, "#f6f3ff", "#191427");
  pen.rect(1, bodyH - 3, w - 2, 1, "#dcd6f0");
  // The tail points down to the speaker.
  const tx = Math.floor(w / 2) - 2;
  pen
    .rect(tx, bodyH - 1, 5, 1, "#f6f3ff")
    .rect(tx + 1, bodyH, 3, 1, "#f6f3ff")
    .rect(tx + 2, bodyH + 1, 1, 1, "#f6f3ff");
  pen.px(tx - 1, bodyH - 1, "#191427").px(tx + 5, bodyH - 1, "#191427");
  pen.px(tx, bodyH, "#191427").px(tx + 4, bodyH, "#191427");
  pen.px(tx + 1, bodyH + 1, "#191427").px(tx + 3, bodyH + 1, "#191427");
  pen.px(tx + 2, bodyH + 2, "#191427");
  lines.forEach((line, i) => {
    const lw = measureText(line);
    pen.text(Math.floor((w - lw) / 2), 3 + i * LINE_HEIGHT, line, "#231a3a");
  });
  tex.refresh();
  return { width: w, height: h };
}
