import type { CrewMember } from "@orbital/shared";
import type Phaser from "phaser";
import type { AgentView as AgentModel, AgentPose } from "../sim/world";
import { crewAnim, crewTexture, ICONS_TEXTURE, makeBubble } from "./textures";

/**
 * One crew member on screen: body sprite, shadow, selection ring, and the overhead name tag,
 * status icon and speech bubble. Everything is derived each frame from the world model.
 */

export const TILE = 16;
/** Feet sit 2px above the bottom of the tile, so heads overlap the tile above a little. */
const FEET = 14;

let bubbleCounter = 0;

export class AgentView {
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly shadow: Phaser.GameObjects.Image;
  private readonly ring: Phaser.GameObjects.Sprite;
  private readonly tag: Phaser.GameObjects.Image;
  private readonly icon: Phaser.GameObjects.Sprite;
  private bubble: Phaser.GameObjects.Image | null = null;
  private bubbleKey: string | null = null;
  private bubbleText: string | null = null;
  private anim = "";
  private iconName = "";
  /** World-space position of the feet, for hit tests and the camera. */
  x = 0;
  y = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    readonly crew: CrewMember,
    private readonly order: number,
    world: Phaser.GameObjects.Layer,
    overlay: Phaser.GameObjects.Layer,
  ) {
    this.shadow = scene.add.image(0, 0, "agent-shadow", "0").setOrigin(0.5, 0.5);
    this.ring = scene.add.sprite(0, 0, "select-ring", "0").setOrigin(0.5, 0.5).setVisible(false);
    this.ring.play("select-ring");
    this.sprite = scene.add.sprite(0, 0, crewTexture(crew.id)).setOrigin(0.5, 1);
    this.tag = scene.add.image(0, 0, `tag-${crew.id}`).setOrigin(0.5, 1);
    this.icon = scene.add.sprite(0, 0, ICONS_TEXTURE, "dots0").setOrigin(0.5, 1).setVisible(false);
    world.add([this.shadow, this.ring, this.sprite]);
    overlay.add([this.tag, this.icon]);
  }

  update(
    model: AgentModel,
    pose: AgentPose,
    now: number,
    opts: { selected: boolean; showNames: boolean; showBubbles: boolean },
    overlay: Phaser.GameObjects.Layer,
  ): void {
    const x = pose.x * TILE + TILE / 2;
    const y = pose.y * TILE + FEET;
    this.x = x;
    this.y = y;
    const depth = 10 + y + this.order * 0.01;
    this.sprite.setPosition(x, y).setDepth(depth);
    this.shadow.setPosition(x, y - 1).setDepth(depth - 0.5);
    this.ring
      .setPosition(x, y - 1)
      .setDepth(depth - 0.6)
      .setVisible(opts.selected);

    // Animation from motion, activity and what the agent carries.
    const s = model.state;
    let anim: string;
    if (pose.moving) anim = s.carrying ? `carry-${s.carrying}` : "walk";
    else if (s.carrying) anim = `hold-${s.carrying}`;
    else if ((s.activity === "work" || s.activity === "review") && s.anchor) anim = "type";
    else anim = "idle";
    const key = crewAnim(this.crew.id, anim, pose.facing);
    if (key !== this.anim) {
      // Keep the step cycle going when a walker turns a corner.
      const sameKind = this.anim.split(":")[1] === anim;
      const startFrame = sameKind ? (this.sprite.anims.currentFrame?.index ?? 1) - 1 : 0;
      this.sprite.play({ key, startFrame: Math.max(0, startFrame) });
      this.anim = key;
    }

    // Overhead: name tag, then icon and bubble above it.
    const headTop = y - 16;
    this.tag
      .setPosition(Math.round(x), Math.round(headTop - 1))
      .setVisible(opts.showNames || opts.selected);
    this.tag.setDepth(20_000 + y);
    const tagTop = this.tag.visible ? headTop - 10 : headTop - 1;

    const icon = this.pickIcon(model, pose, now);
    if (icon !== this.iconName) {
      this.iconName = icon;
      if (icon === "dots") this.icon.play("icon:dots");
      else if (icon) this.icon.stop().setFrame(icon);
    }
    const bubbleUp = opts.showBubbles && model.bubble !== null && now < model.bubble.until;
    this.icon
      .setVisible(icon !== "" && !(bubbleUp && icon === "dots"))
      .setPosition(
        Math.round(x + (this.tag.visible ? this.tag.width / 2 + 5 : 6)),
        Math.round(headTop + (this.tag.visible ? -1 : 0)),
      )
      .setDepth(20_001 + y);

    this.updateBubble(model, now, x, tagTop, overlay, opts.showBubbles);
  }

  private pickIcon(model: AgentModel, pose: AgentPose, now: number): string {
    const s = model.state;
    if (s.activity === "coffee" && !pose.moving) return "coffee";
    if (pose.moving) return "";
    switch (s.activity) {
      case "work":
        return s.anchor ? "dots" : "";
      case "review":
        return "search";
      case "nudge":
        return "alert";
      case "idle":
        return now - s.since > 2_500 ? "zzz" : "";
      default:
        return "";
    }
  }

  private updateBubble(
    model: AgentModel,
    now: number,
    x: number,
    top: number,
    overlay: Phaser.GameObjects.Layer,
    show: boolean,
  ): void {
    const b = model.bubble;
    if (!b || now >= b.until || !show) {
      this.dropBubble();
      return;
    }
    if (b.text !== this.bubbleText || !this.bubble) {
      this.dropBubble();
      bubbleCounter += 1;
      const key = `bubble-${this.crew.id}-${bubbleCounter}`;
      makeBubble(this.scene, key, b.text);
      this.bubble = this.scene.add.image(0, 0, key).setOrigin(0.5, 1);
      overlay.add(this.bubble);
      this.bubbleKey = key;
      this.bubbleText = b.text;
      this.bubble.setScale(0.6);
      this.scene.tweens.add({ targets: this.bubble, scale: 1, duration: 140, ease: "Back.Out" });
    }
    const fade = Math.min(1, (b.until - now) / 350);
    this.bubble
      .setPosition(Math.round(x), Math.round(top))
      .setAlpha(fade)
      .setDepth(30_000 + this.y);
  }

  private dropBubble(): void {
    if (this.bubble) {
      this.scene.tweens.killTweensOf(this.bubble);
      this.bubble.destroy();
      this.bubble = null;
    }
    if (this.bubbleKey) {
      this.scene.textures.remove(this.bubbleKey);
      this.bubbleKey = null;
    }
    this.bubbleText = null;
  }

  destroy(): void {
    this.dropBubble();
    for (const o of [this.sprite, this.shadow, this.ring, this.tag, this.icon]) o.destroy();
  }

  /** The bubble's box in world space, for keeping bubbles from overlapping. */
  bubbleBox(): { x: number; y: number; w: number; h: number } | null {
    if (!this.bubble) return null;
    const w = this.bubble.width;
    const h = this.bubble.height;
    return { x: this.bubble.x - w / 2, y: this.bubble.y - h, w, h };
  }

  setBubbleBottom(y: number): void {
    this.bubble?.setY(Math.round(y));
  }

  /** True when a world point is on this crew member's body. */
  hit(wx: number, wy: number): boolean {
    return Math.abs(wx - this.x) <= 6 && wy >= this.y - 16 && wy <= this.y + 2;
  }
}
