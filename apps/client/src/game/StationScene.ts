import type { Doorway, StationMap } from "@orbital/shared";
import Phaser from "phaser";
import { hexToInt } from "../art/color";
import { SCREEN_SLOTS } from "../art/furniture";
import { themeFor } from "../art/themes";
import type { SimClock } from "../sim/clock";
import type { StationLink } from "../sim/link";
import type { World } from "../sim/world";
import type { CameraCommands, UiStore } from "../ui/store";
import { AgentView, TILE } from "./AgentView";
import { buildCrew, buildTextures, STAR_TEXTURES, STATION_TEXTURE } from "./textures";

export interface SceneDeps {
  map: StationMap;
  world: World;
  link: StationLink;
  clock: SimClock;
  ui: UiStore;
  /** Device pixel ratio the canvas renders at. */
  dpr: () => number;
  /** Optional opening view (from URL options), e.g. for screenshots. */
  initial?: InitialView;
}

export interface InitialView {
  /** A crew id or a room id to select. */
  select?: string;
  /** A crew id or a room id to frame, or "station" for the whole station. */
  focus?: string;
  /** CSS zoom to apply after framing. */
  zoom?: number;
  follow?: boolean;
}

interface Screen {
  sprite: Phaser.GameObjects.Sprite;
  anchors: string[];
  accent: string;
  on: boolean;
}

interface Door {
  d: Doorway;
  sprite: Phaser.GameObjects.Sprite;
  open: number;
}

const MIN_ZOOM = 0.6;
/** Screen space (CSS px) taken by the top bar and the crew roster. */
const UI_TOP = 64;
const UI_BOTTOM = 100;
/** Below this zoom, name tags and bubbles are too small to read, so they hide. */
const LABEL_ZOOM = 1.15;
const MAX_ZOOM = 6;
const PAN_SPEED = 600; // CSS px per second

/**
 * The station on screen. Two cameras: a fixed one for the starfield, and the world camera that
 * pans and zooms over the station. Every frame it advances the sim clock, pulls events from the
 * link into the world model, and redraws crew and fixtures from that model.
 */
export class StationScene extends Phaser.Scene implements CameraCommands {
  private starCam!: Phaser.Cameras.Scene2D.Camera;
  private cam!: Phaser.Cameras.Scene2D.Camera;
  private starLayer!: Phaser.GameObjects.Layer;
  private worldLayer!: Phaser.GameObjects.Layer;
  private overlayLayer!: Phaser.GameObjects.Layer;
  private stars: Phaser.GameObjects.TileSprite[] = [];
  private agents = new Map<string, AgentView>();
  private screens: Screen[] = [];
  private doors: Door[] = [];
  private racks: { sprite: Phaser.GameObjects.Sprite; provider: string; state: string }[] = [];
  private scanner: { sprite: Phaser.GameObjects.Sprite; anchor: string } | null = null;
  /** The Edit Bay's wall screen: a live bar for the cut in progress (Stage 20). */
  private studioScreen: {
    gfx: Phaser.GameObjects.Graphics;
    x: number;
    y: number;
    w: number;
    accent: number;
    key: string;
  } | null = null;
  private intakeCrates: Phaser.GameObjects.Image[] = [];
  private highlight!: Phaser.GameObjects.Graphics;
  private drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private fpsTimer = 0;
  private wasPaused = false;
  private initialApplied = false;
  private lastSpeed = 1;

  constructor(private readonly deps: SceneDeps) {
    super("station");
  }

  create(): void {
    const { map, ui } = this.deps;
    buildTextures(this, map);

    this.starLayer = this.add.layer();
    this.worldLayer = this.add.layer();
    this.overlayLayer = this.add.layer();

    this.starCam = this.cameras.main;
    this.starCam.setOrigin(0, 0);
    this.cam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.cam.setOrigin(0, 0);
    this.starCam.ignore([this.worldLayer, this.overlayLayer]);
    this.cam.ignore(this.starLayer);

    for (const key of STAR_TEXTURES) {
      const ts = this.add.tileSprite(0, 0, 16, 16, key).setOrigin(0, 0);
      this.starLayer.add(ts);
      this.stars.push(ts);
    }

    this.worldLayer.add(this.add.image(0, 0, STATION_TEXTURE).setOrigin(0, 0).setDepth(0));
    this.createFixtures();
    this.highlight = this.add.graphics().setDepth(5);
    this.worldLayer.add(this.highlight);

    // Crew views are created as crew appear in the world (snapshot, hires).
    this.syncViews();

    this.setupInput();
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.layout());
    this.layout();
    this.home();
    ui.camera = this;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (ui.camera === this) ui.camera = null;
    });
  }

  // -- Fixtures -----------------------------------------------------------------------------

  private createFixtures(): void {
    const { map } = this.deps;
    const anchorsByObject = new Map<string, string[]>();
    for (const a of map.anchors) {
      if (!a.object) continue;
      anchorsByObject.set(a.object, [...(anchorsByObject.get(a.object) ?? []), a.id]);
    }
    const add = <T extends Phaser.GameObjects.GameObject>(o: T) => {
      this.worldLayer.add(o);
      return o;
    };

    for (const o of map.objects) {
      const accent = themeFor(map.room(o.room).theme).accent;
      const ox = o.x * TILE;
      const oy = o.y * TILE;
      const baseDepth = 10 + (o.y + o.h) * TILE - 2;
      const slots = SCREEN_SLOTS[o.kind] ?? [];
      for (const slot of slots) {
        const sprite = add(
          this.add
            .sprite(ox + slot.x, oy + slot.y, `screen-off-${accent}`, "0")
            .setOrigin(0, 0)
            .setDepth(1),
        );
        sprite.play({ key: `screen-off-${accent}`, startFrame: Math.floor(Math.random() * 2) });
        this.screens.push({ sprite, anchors: anchorsByObject.get(o.id) ?? [], accent, on: false });
      }
      switch (o.kind) {
        case "rack": {
          const sprite = add(
            this.add
              .sprite(ox + 3, oy + 3, "rack-ok", "0")
              .setOrigin(0, 0)
              .setDepth(1),
          );
          sprite.play({ key: "rack-ok", startFrame: Math.floor(Math.random() * 4) });
          this.racks.push({ sprite, provider: o.provider ?? "spare", state: "ok" });
          break;
        }
        case "databank":
          add(
            this.add
              .sprite(ox + 4, oy + 4, "databank", "0")
              .setOrigin(0, 0)
              .setDepth(1),
          ).play("databank");
          break;
        case "holotable": {
          const big = o.w >= 4;
          const key = big ? `holo-bridge-${accent}` : `holo-globe-${accent}`;
          const frame = this.textures.getFrame(key, "0");
          const fw = frame?.width ?? 20;
          const fh = frame?.height ?? 20;
          const sprite = add(
            this.add
              .sprite(
                ox + (o.w * TILE) / 2 - fw / 2,
                oy + o.h * TILE - 12 - fh + (big ? 6 : 5),
                key,
                "0",
              )
              .setOrigin(0, 0)
              .setDepth(baseDepth)
              .setBlendMode(Phaser.BlendModes.ADD),
          );
          sprite.play(key);
          break;
        }
        case "coffee":
          add(
            this.add
              .sprite(ox + 5, oy - 8, "steam", "0")
              .setOrigin(0, 0)
              .setDepth(baseDepth),
          ).play({
            key: "steam",
            startFrame: Math.floor(Math.random() * 4),
          });
          break;
        case "forge":
          add(
            this.add
              .sprite(ox + 7, oy + 13, "forge-glow", "0")
              .setOrigin(0, 0)
              .setDepth(1),
          ).play("forge-glow");
          break;
        case "cooler":
          add(
            this.add
              .sprite(ox + 4, oy + 3, "fan", "0")
              .setOrigin(0, 0)
              .setDepth(1),
          ).play("fan");
          break;
        case "wallscreen":
          add(
            this.add
              .sprite(ox + 2, oy + 5, `wall-${o.id}`, "0")
              .setOrigin(0, 0)
              .setDepth(1),
          ).play(`wall-${o.id}`);
          if (o.variant === "studio") {
            this.studioScreen = {
              gfx: add(this.add.graphics().setDepth(2)),
              x: ox + 2,
              y: oy + 5,
              w: o.w * TILE - 4,
              accent: Phaser.Display.Color.HexStringToColor(accent).color,
              key: "",
            };
          }
          break;
        case "scanner": {
          const key = `scan-${accent}`;
          const sprite = add(
            this.add
              .sprite(ox + 5, oy + 4, key, "0")
              .setOrigin(0, 0)
              .setDepth(baseDepth),
          );
          sprite.setBlendMode(Phaser.BlendModes.ADD).setVisible(false).play(key);
          this.scanner = { sprite, anchor: anchorsByObject.get(o.id)?.[0] ?? "" };
          break;
        }
        case "intake":
          for (let i = 0; i < 3; i++) {
            this.intakeCrates.push(
              add(
                this.add
                  .image(ox + 4 + i * 14, oy - 1, "intake-crate", "0")
                  .setOrigin(0, 0)
                  .setDepth(baseDepth)
                  .setVisible(false),
              ),
            );
          }
          break;
      }
    }

    for (const d of map.doorways()) {
      const len = d.orientation === "horizontal" ? d.w : d.h;
      const sprite = add(
        this.add
          .sprite(d.x * TILE, d.y * TILE, `door-${d.orientation}-${len}`, "0")
          .setOrigin(0, 0)
          .setDepth(2),
      );
      this.doors.push({ d, sprite, open: 0 });
    }
  }

  // -- Frame loop -----------------------------------------------------------------------------

  override update(_time: number, delta: number): void {
    const { clock, link, world, ui } = this.deps;
    clock.tick(delta);
    const now = clock.now();
    link.update(now);

    if (clock.paused !== this.wasPaused) {
      this.wasPaused = clock.paused;
      if (clock.paused) this.anims.pauseAll();
      else this.anims.resumeAll();
    }
    if (clock.speed !== this.lastSpeed) {
      this.lastSpeed = clock.speed;
      this.anims.globalTimeScale = clock.speed;
    }

    this.syncViews();
    const state = ui.get();
    const selectedAgent = state.selection?.kind === "agent" ? state.selection.id : null;
    const readable = this.cssZoom >= LABEL_ZOOM;
    for (const [id, model] of world.agents) {
      const view = this.agents.get(id);
      const pose = world.pose(id, now);
      if (!view || !pose) continue;
      view.update(
        model,
        pose,
        now,
        {
          selected: id === selectedAgent,
          showNames: state.showNames && readable,
          showBubbles: readable || id === selectedAgent,
        },
        this.overlayLayer,
      );
    }

    this.separateBubbles();
    this.updateFixtures(now, delta);
    this.updateHighlight(now);
    this.updateCamera(delta);

    this.fpsTimer += delta;
    if (this.fpsTimer > 500) {
      this.fpsTimer = 0;
      ui.set({ fps: Math.round(this.game.loop.actualFps) });
    }
  }

  /** Stack speech bubbles upwards where they would overlap, nearest the camera first. */
  private separateBubbles(): void {
    type Box = { x: number; y: number; w: number; h: number };
    const entries: { view: AgentView; box: Box }[] = [];
    for (const view of this.agents.values()) {
      const box = view.bubbleBox();
      if (box) entries.push({ view, box });
    }
    entries.sort((a, b) => b.box.y + b.box.h - (a.box.y + a.box.h));
    const placed: Box[] = [];
    for (const { view, box } of entries) {
      let b = box;
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find(
          (p) => b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y,
        );
        if (!hit) break;
        b = { ...b, y: hit.y - b.h - 1 };
      }
      if (b !== box) view.setBubbleBottom(b.y + b.h);
      placed.push(b);
    }
  }

  private updateFixtures(now: number, delta: number): void {
    const { world } = this.deps;
    const busy = new Set<string>();
    for (const [id, a] of world.agents) {
      const s = a.state;
      if (!s.anchor || (s.activity !== "work" && s.activity !== "review")) continue;
      const pose = world.pose(id, now);
      if (pose && !pose.moving) busy.add(s.anchor);
    }
    for (const sc of this.screens) {
      const on = sc.anchors.some((a) => busy.has(a));
      if (on !== sc.on) {
        sc.on = on;
        const key = on ? `screen-on-${sc.accent}` : `screen-off-${sc.accent}`;
        sc.sprite.play({ key, startFrame: 0 });
      }
    }
    for (const r of this.racks) {
      const state = world.providers.get(r.provider)?.state ?? "ok";
      if (state !== r.state) {
        r.state = state;
        r.sprite.play({ key: `rack-${state}`, startFrame: Math.floor(Math.random() * 4) });
      }
    }
    if (this.scanner) this.scanner.sprite.setVisible(busy.has(this.scanner.anchor));
    const screen = this.studioScreen;
    if (screen) {
      const cut = world.studioActive();
      const key = cut ? `${cut.id}:${Math.round(cut.progress)}:${cut.status}` : "";
      if (key !== screen.key) {
        screen.key = key;
        const g = screen.gfx.clear();
        if (cut) {
          // A long-form gets a full-height bar, a short a thinner one; waiting is a dim stub.
          const h = cut.format === "long" ? 5 : 3;
          const fill =
            cut.status === "waiting"
              ? 1
              : Math.max(1, Math.round(((screen.w - 2) * cut.progress) / 100));
          g.fillStyle(0x0f2130, 1).fillRect(screen.x, screen.y, screen.w, 7);
          g.fillStyle(0x1d2b3a, 1).fillRect(screen.x + 1, screen.y + (7 - h) / 2, screen.w - 2, h);
          g.fillStyle(screen.accent, cut.status === "waiting" ? 0.5 : 1);
          g.fillRect(screen.x + 1, screen.y + (7 - h) / 2, fill, h);
        }
      }
    }
    const waiting = world.intakeCount();
    this.intakeCrates.forEach((c, i) => {
      c.setVisible(i < waiting);
    });

    // Doors slide open for anyone within a tile and a half.
    const step = (delta / 1000) * 7 * (this.deps.clock.paused ? 0 : 1);
    for (const door of this.doors) {
      const { d } = door;
      let near = false;
      for (const v of this.agents.values()) {
        const tx = v.x / TILE - 0.5;
        const ty = (v.y - 6) / TILE - 0.5;
        if (tx > d.x - 1.6 && tx < d.x + d.w + 0.6 && ty > d.y - 1.6 && ty < d.y + d.h + 0.6) {
          near = true;
          break;
        }
      }
      door.open = Phaser.Math.Clamp(door.open + (near ? step : -step), 0, 1);
      door.sprite.setFrame(String(Math.round(door.open * 4)));
    }
  }

  private updateHighlight(now: number): void {
    const { map, ui } = this.deps;
    const g = this.highlight;
    g.clear();
    const state = ui.get();
    const draw = (roomId: string, alpha: number) => {
      const r = map.room(roomId);
      const color = hexToInt(themeFor(r.theme).accent);
      g.lineStyle(1, color, alpha);
      g.strokeRect(r.x * TILE + 0.5, r.y * TILE + 0.5, r.w * TILE - 1, r.h * TILE - 1);
    };
    if (
      state.hoverRoom &&
      !(state.selection?.kind === "room" && state.selection.id === state.hoverRoom)
    ) {
      draw(state.hoverRoom, 0.35);
    }
    if (state.selection?.kind === "room")
      draw(state.selection.id, 0.65 + Math.sin(now / 300) * 0.25);
  }

  // -- Camera ---------------------------------------------------------------------------------

  private layout(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const dpr = this.deps.dpr();
    this.starCam.setSize(w, h).setZoom(dpr);
    this.cam.setSize(w, h);
    for (const ts of this.stars) ts.setSize(Math.ceil(w / dpr) + 2, Math.ceil(h / dpr) + 2);
    this.clampCamera();
  }

  /** Zoom in CSS pixels per station pixel. */
  private get cssZoom(): number {
    return this.cam.zoom / this.deps.dpr();
  }

  private setCssZoom(z: number, aboutX?: number, aboutY?: number): void {
    const cam = this.cam;
    const px = aboutX ?? cam.width / 2;
    const py = aboutY ?? cam.height / 2;
    const wx = cam.scrollX + px / cam.zoom;
    const wy = cam.scrollY + py / cam.zoom;
    const zoom = Phaser.Math.Clamp(z, MIN_ZOOM, MAX_ZOOM) * this.deps.dpr();
    cam.setZoom(zoom);
    cam.scrollX = wx - px / zoom;
    cam.scrollY = wy - py / zoom;
    this.clampCamera();
    this.deps.ui.set({ zoom: Math.round(this.cssZoom * 100) / 100 });
  }

  private centerOn(wx: number, wy: number): void {
    this.cam.scrollX = wx - this.cam.width / this.cam.zoom / 2;
    this.cam.scrollY = wy - this.cam.height / this.cam.zoom / 2;
    this.clampCamera();
  }

  /** Keep the station in view; centre it when it is smaller than the screen. */
  private clampCamera(): void {
    const { map } = this.deps;
    const cam = this.cam;
    const vw = cam.width / cam.zoom;
    const vh = cam.height / cam.zoom;
    const W = map.width * TILE;
    const H = map.height * TILE;
    const margin = 48;
    cam.scrollX =
      vw >= W + margin * 2
        ? (W - vw) / 2
        : Phaser.Math.Clamp(cam.scrollX, -margin, W + margin - vw);
    cam.scrollY =
      vh >= H + margin * 2
        ? (H - vh) / 2
        : Phaser.Math.Clamp(cam.scrollY, -margin, H + margin - vh);
  }

  private updateCamera(delta: number): void {
    const { ui } = this.deps;
    const state = ui.get();
    const k = this.keys;
    let dx = 0;
    let dy = 0;
    if (k.left?.isDown || k.a?.isDown) dx -= 1;
    if (k.right?.isDown || k.d?.isDown) dx += 1;
    if (k.up?.isDown || k.w?.isDown) dy -= 1;
    if (k.down?.isDown || k.s?.isDown) dy += 1;
    if (dx || dy) {
      const step = ((PAN_SPEED * delta) / 1000) * (this.deps.dpr() / this.cam.zoom);
      this.cam.scrollX += dx * step;
      this.cam.scrollY += dy * step;
      if (state.follow) ui.set({ follow: false });
      this.clampCamera();
    }
    if (state.follow && state.selection?.kind === "agent") {
      const v = this.agents.get(state.selection.id);
      if (v) {
        const cx = this.cam.scrollX + this.cam.width / this.cam.zoom / 2;
        const cy = this.cam.scrollY + this.cam.height / this.cam.zoom / 2;
        const t = 1 - Math.exp(-delta / 180);
        this.centerOn(cx + (v.x - cx) * t, cy + (v.y - 8 - cy) * t);
      }
    }
    // Stars drift slowly and shift a little with the camera, for depth.
    const time = this.time.now;
    this.stars.forEach((ts, i) => {
      const factor = i === 0 ? 0.04 : 0.12;
      ts.tilePositionX = this.cam.scrollX * factor + time * (i === 0 ? 0.002 : 0.005);
      ts.tilePositionY = this.cam.scrollY * factor;
    });
  }

  zoomBy(factor: number): void {
    this.setCssZoom(this.cssZoom * factor);
  }

  fit(): void {
    const { map } = this.deps;
    this.frame(0, 0, map.width * TILE, map.height * TILE, 16);
  }

  /** Zoom and centre so a world rectangle fills the space between the top bar and the roster. */
  private frame(x: number, y: number, w: number, h: number, pad: number, maxZoom = MAX_ZOOM): void {
    const dpr = this.deps.dpr();
    const vw = this.cam.width / dpr;
    const vh = Math.max(120, this.cam.height / dpr - UI_TOP - UI_BOTTOM);
    this.setCssZoom(Math.min(maxZoom, vw / (w + pad * 2), vh / (h + pad * 2)));
    // Shift the centre so the rectangle sits in the free band, not under the roster.
    const shift = (UI_BOTTOM - UI_TOP) / 2 / this.cssZoom;
    this.centerOn(x + w / 2, y + h / 2 + shift);
  }

  /** Create views for crew who appeared, drop views for crew who are gone. */
  private syncViews(): void {
    const { world } = this.deps;
    for (const [id] of world.agents) {
      if (this.agents.has(id)) continue;
      const c = world.crew.get(id);
      if (!c) continue;
      buildCrew(this, c);
      this.agents.set(
        id,
        new AgentView(this, c, this.agents.size, this.worldLayer, this.overlayLayer),
      );
    }
    for (const [id, view] of this.agents) {
      if (!world.agents.has(id)) {
        view.destroy();
        this.agents.delete(id);
      }
    }
    if (!this.initialApplied && world.crew.size > 0) {
      this.initialApplied = true;
      this.applyInitialView();
    }
  }

  private applyInitialView(): void {
    const { initial, map, ui, world } = this.deps;
    if (!initial) return;
    const isCrew = (id?: string) => !!id && world.crew.has(id);
    const isRoom = (id?: string) => !!id && map.rooms.some((r) => r.id === id);
    if (initial.focus === "station") this.fit();
    else if (isCrew(initial.focus)) this.focusAgent(initial.focus as string);
    else if (isRoom(initial.focus)) this.focusRoom(initial.focus as string);
    if (initial.zoom && initial.zoom > 0) {
      // Keep the focus target centred at the requested zoom.
      const r = isRoom(initial.focus) ? map.room(initial.focus as string) : null;
      const v = isCrew(initial.focus) ? this.agents.get(initial.focus as string) : null;
      this.setCssZoom(initial.zoom);
      const shift = (UI_BOTTOM - UI_TOP) / 2 / this.cssZoom;
      if (r) this.centerOn((r.x + r.w / 2) * TILE, (r.y + r.h / 2) * TILE + shift);
      else if (v) this.centerOn(v.x, v.y - 8 + shift);
    }
    if (isCrew(initial.select)) {
      ui.set({
        selection: { kind: "agent", id: initial.select as string },
        follow: initial.follow ?? false,
      });
    } else if (isRoom(initial.select)) {
      ui.set({ selection: { kind: "room", id: initial.select as string } });
    }
  }

  /** The opening view: the Command Bridge and its neighbours, close enough to read. */
  home(): void {
    const { map } = this.deps;
    const bridge = map.room("bridge");
    const dpr = this.deps.dpr();
    const fitZoom = Math.min(
      this.cam.width / dpr / (map.width * TILE + 32),
      (this.cam.height / dpr - UI_TOP - UI_BOTTOM) / (map.height * TILE + 32),
    );
    this.setCssZoom(Math.max(fitZoom, 1.6));
    const shift = (UI_BOTTOM - UI_TOP) / 2 / this.cssZoom;
    this.centerOn((bridge.x + bridge.w / 2) * TILE, (bridge.y + bridge.h / 2) * TILE + shift);
  }

  focusAgent(id: string): void {
    const v = this.agents.get(id);
    if (!v) return;
    if (this.cssZoom < 2.5) this.setCssZoom(2.5);
    this.centerOn(v.x, v.y - 8);
  }

  focusRoom(id: string): void {
    const r = this.deps.map.room(id);
    this.frame(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE, 24, 4);
  }

  // -- Input ----------------------------------------------------------------------------------

  private setupInput(): void {
    const kb = this.input.keyboard;
    if (kb) {
      const K = Phaser.Input.Keyboard.KeyCodes;
      this.keys = kb.addKeys(
        {
          up: K.UP,
          down: K.DOWN,
          left: K.LEFT,
          right: K.RIGHT,
          w: K.W,
          a: K.A,
          s: K.S,
          d: K.D,
        },
        false,
      ) as Record<string, Phaser.Input.Keyboard.Key>;
      kb.on("keydown-PLUS", () => this.zoomBy(1.25));
      kb.on("keydown-NUMPAD_ADD", () => this.zoomBy(1.25));
      kb.on("keydown-MINUS", () => this.zoomBy(0.8));
      kb.on("keydown-NUMPAD_SUBTRACT", () => this.zoomBy(0.8));
      kb.on("keydown-F", () => this.fit());
      kb.on("keydown-ESC", () => this.deps.ui.set({ selection: null, follow: false }));
    }

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      this.drag = { x: p.x, y: p.y, sx: this.cam.scrollX, sy: this.cam.scrollY, moved: false };
    });
    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      const { ui, map } = this.deps;
      if (this.drag && p.isDown) {
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) > 5 * this.deps.dpr()) this.drag.moved = true;
        if (this.drag.moved) {
          this.cam.scrollX = this.drag.sx - dx / this.cam.zoom;
          this.cam.scrollY = this.drag.sy - dy / this.cam.zoom;
          this.clampCamera();
          if (ui.get().follow) ui.set({ follow: false });
        }
        return;
      }
      const w = this.toWorld(p);
      const overAgent = [...this.agents.values()].some((v) => v.hit(w.x, w.y));
      this.game.canvas.style.cursor = overAgent ? "pointer" : "default";
      const room = map.roomAt(Math.floor(w.x / TILE), Math.floor(w.y / TILE));
      ui.set({ hoverRoom: overAgent ? null : (room?.id ?? null) });
    });
    this.input.on(Phaser.Input.Events.POINTER_UP, (p: Phaser.Input.Pointer) => {
      const wasDrag = this.drag?.moved ?? false;
      this.drag = null;
      if (!wasDrag) this.click(p);
    });
    this.input.on(Phaser.Input.Events.GAME_OUT, () => this.deps.ui.set({ hoverRoom: null }));
    this.input.on(
      Phaser.Input.Events.POINTER_WHEEL,
      (p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
        this.setCssZoom(this.cssZoom * (dy < 0 ? 1.15 : 1 / 1.15), p.x, p.y);
      },
    );
  }

  roomAtClient(clientX: number, clientY: number): string | null {
    const rect = this.game.canvas.getBoundingClientRect();
    const dpr = this.deps.dpr();
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const wx = this.cam.scrollX + px / this.cam.zoom;
    const wy = this.cam.scrollY + py / this.cam.zoom;
    return this.deps.map.roomAt(Math.floor(wx / TILE), Math.floor(wy / TILE))?.id ?? null;
  }

  private toWorld(p: Phaser.Input.Pointer): { x: number; y: number } {
    return { x: this.cam.scrollX + p.x / this.cam.zoom, y: this.cam.scrollY + p.y / this.cam.zoom };
  }

  private click(p: Phaser.Input.Pointer): void {
    const { ui, map } = this.deps;
    const w = this.toWorld(p);
    let picked: AgentView | null = null;
    for (const v of this.agents.values()) {
      if (v.hit(w.x, w.y) && (!picked || v.y > picked.y)) picked = v;
    }
    if (picked) {
      ui.set({ selection: { kind: "agent", id: picked.crew.id } });
      return;
    }
    const room = map.roomAt(Math.floor(w.x / TILE), Math.floor(w.y / TILE));
    ui.set({ selection: room ? { kind: "room", id: room.id } : null, follow: false });
  }
}
