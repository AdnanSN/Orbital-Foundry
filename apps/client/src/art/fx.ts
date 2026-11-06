import { withAlpha } from "./color";
import { hash2, Pen } from "./pen";
import { MAT } from "./themes";

/**
 * Animated overlays, drawn as horizontal frame strips. The scene turns each strip into a
 * texture with numbered frames and plays it on sprites placed over the static background.
 */

export interface FxStrip {
  frameW: number;
  frameH: number;
  frames: number;
  draw: (p: Pen, frame: number) => void;
}

export function stripSize(fx: FxStrip): { width: number; height: number } {
  return { width: fx.frameW * fx.frames, height: fx.frameH };
}

export function paintStrip(ctx: CanvasRenderingContext2D, fx: FxStrip): void {
  const pen = new Pen(ctx);
  for (let f = 0; f < fx.frames; f++) fx.draw(pen.at(f * fx.frameW, 0), f);
}

/** A working screen: lines of "output" scroll up in the room's colour. */
export function screenOn(accent: string): FxStrip {
  return {
    frameW: 10,
    frameH: 7,
    frames: 4,
    draw: (p, f) => {
      p.rect(0, 0, 10, 7, "#0f2130");
      for (let line = 0; line < 4; line++) {
        const n = line + f;
        const w = 2 + Math.floor(hash2(n, 3) * 6);
        const color = hash2(n, 9) < 0.3 ? "#e9f4ff" : accent;
        p.hline(1, 1 + line * 2 - (f % 2), w, withAlpha(color, 0.9));
      }
      if (f % 2 === 0) p.rect(8, 5, 1, 1, "#ffffff");
    },
  };
}

/** An idle screen: dim, with a slow blinking dot. */
export function screenOff(accent: string): FxStrip {
  return {
    frameW: 10,
    frameH: 7,
    frames: 2,
    draw: (p, f) => {
      p.rect(0, 0, 10, 7, "#0b1520");
      p.hline(1, 1, 4, withAlpha(accent, 0.25));
      if (f === 0) p.px(2, 4, withAlpha(accent, 0.7));
    },
  };
}

export type RackState = "ok" | "limited" | "down";

/** Server rack lights. Amber when the provider is rate-limited; red with sparks when down. */
export function rackLights(state: RackState): FxStrip {
  const palette: Record<RackState, string[]> = {
    ok: ["#4dff88", "#5ff2ff", "#4dff88", "#2a8f55"],
    limited: ["#ffb347", "#ffcf5a", "#a8692a", "#ffb347"],
    down: ["#ff4d4d", "#8f2a2a", "#ff4d4d", "#5a1f1f"],
  };
  return {
    frameW: 10,
    frameH: 26,
    frames: 4,
    draw: (p, f) => {
      const colors = palette[state];
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 4; col++) {
          const on = hash2(row * 7 + col, f, state.length) < (state === "down" ? 0.35 : 0.6);
          const c = colors[(row + col + f) % colors.length] as string;
          p.rect(1 + col * 2, 3 + row * 3, 1, 1, on ? c : "#1d2433");
        }
        if (state !== "down" || f % 2 === 0)
          p.px(9, 3 + row * 3, row % 3 === f % 3 ? (colors[0] as string) : "#1d2433");
      }
      if (state === "down") {
        // Sparks jumping off the front panel.
        const sparks = [
          [2, 6],
          [7, 12],
          [4, 19],
          [8, 4],
        ];
        const s = sparks[f] as number[];
        p.px(s[0] as number, s[1] as number, "#ffffff");
        p.px((s[0] as number) + 1, (s[1] as number) - 1, "#ffe066");
        p.px((s[0] as number) - 1, (s[1] as number) + 1, "#ffb347");
      }
    },
  };
}

export const DATABANK: FxStrip = {
  frameW: 8,
  frameH: 24,
  frames: 4,
  draw: (p, f) => {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 4; j++) {
        const on = hash2(i * 5 + j, f, 2) < 0.55;
        p.rect(j * 2, i * 4, 1, 2, on ? (j % 2 ? "#5ff2d0" : "#4dff88") : "#132028");
      }
    }
  },
};

/** A rotating wireframe globe (Research Lab). */
export function holoGlobe(accent: string): FxStrip {
  const W = 22;
  const H = 20;
  return {
    frameW: W,
    frameH: H,
    frames: 8,
    draw: (p, f) => {
      const cx = W / 2;
      const cy = H / 2 - 1;
      const r = 8;
      for (let a = 0; a < 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        p.px(
          Math.round(cx + Math.cos(t) * r),
          Math.round(cy + Math.sin(t) * r * 0.95),
          withAlpha(accent, 0.8),
        );
      }
      // Meridians sweep across as the globe turns.
      for (let m = 0; m < 3; m++) {
        const phase = ((f / 8 + m / 3) % 1) * Math.PI;
        const k = Math.cos(phase);
        for (let a = 0; a < 32; a++) {
          const t = (a / 32) * Math.PI * 2;
          p.px(
            Math.round(cx + Math.cos(t) * r * k),
            Math.round(cy + Math.sin(t) * r * 0.95),
            withAlpha(accent, 0.45),
          );
        }
      }
      p.hline(cx - r, cy, r * 2 + 1, withAlpha(accent, 0.45));
      p.hline(cx - 6, cy - 5, 13, withAlpha(accent, 0.3));
      p.hline(cx - 6, cy + 5, 13, withAlpha(accent, 0.3));
      p.rect(cx - 1, H - 3, 3, 3, withAlpha(accent, 0.5));
    },
  };
}

/** The Command Bridge hologram: a slowly turning ring of the station's rooms. */
export function holoBridge(accent: string): FxStrip {
  const W = 52;
  const H = 26;
  return {
    frameW: W,
    frameH: H,
    frames: 8,
    draw: (p, f) => {
      const cx = W / 2;
      const cy = 12;
      for (let a = 0; a < 96; a++) {
        const t = (a / 96) * Math.PI * 2;
        p.px(
          Math.round(cx + Math.cos(t) * 20),
          Math.round(cy + Math.sin(t) * 7),
          withAlpha(accent, 0.55),
        );
      }
      for (let i = 0; i < 9; i++) {
        const t = ((i / 9 + f / 64) % 1) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(t) * 20);
        const y = Math.round(cy + Math.sin(t) * 7);
        const front = Math.sin(t) > 0;
        p.rect(x - 1, y - 3, 3, 3, withAlpha(i === 4 ? "#ffffff" : accent, front ? 0.95 : 0.4));
      }
      // The station core in the middle, pulsing.
      const pulse = f % 4 < 2 ? 0.9 : 0.6;
      p.rect(cx - 3, cy - 6, 7, 7, withAlpha(accent, 0.25));
      p.rect(cx - 2, cy - 5, 5, 5, withAlpha(accent, pulse));
      p.vline(cx, cy + 1, 10, withAlpha(accent, 0.35));
    },
  };
}

export const STEAM: FxStrip = {
  frameW: 6,
  frameH: 9,
  frames: 4,
  draw: (p, f) => {
    for (let i = 0; i < 3; i++) {
      const y = 8 - ((f * 2 + i * 3) % 9);
      const x = 2 + ((i + f) % 3) - 1;
      p.px(x, y, withAlpha("#ffffff", 0.55 - i * 0.12));
      p.px(x + 1, y - 1, withAlpha("#ffffff", 0.3));
    }
  },
};

export const FORGE_GLOW: FxStrip = {
  frameW: 18,
  frameH: 10,
  frames: 4,
  draw: (p, f) => {
    p.rect(0, 0, 18, 10, "#3a1408");
    for (let i = 0; i < 18; i++) {
      const h = 3 + Math.floor(hash2(i, f, 4) * 6);
      p.vline(i, 10 - h, h, i % 3 === f % 3 ? "#ffd166" : "#ff6b35");
      p.px(i, 10 - h, "#fff1b0");
    }
  },
};

export function scanBeam(accent: string): FxStrip {
  return {
    frameW: 22,
    frameH: 22,
    frames: 6,
    draw: (p, f) => {
      const y = 2 + f * 3;
      p.rect(0, y - 2, 22, 5, withAlpha(accent, 0.12));
      p.hline(0, y, 22, withAlpha(accent, 0.9));
      p.hline(0, y - 1, 22, withAlpha(accent, 0.35));
    },
  };
}

export const FAN: FxStrip = {
  frameW: 8,
  frameH: 8,
  frames: 2,
  draw: (p, f) => {
    const c = MAT.steel;
    if (f === 0) {
      p.hline(1, 4, 7, c).vline(4, 1, 7, c);
    } else {
      for (let i = 0; i < 7; i++) {
        p.px(1 + i, 1 + i, c);
        p.px(7 - i, 1 + i, c);
      }
    }
    p.px(4, 4, MAT.white);
  },
};

export function wallScreen(width: number, variant: string | undefined, accent: string): FxStrip {
  return {
    frameW: width,
    frameH: 7,
    frames: 2,
    draw: (p, f) => {
      p.rect(0, 0, width, 7, "#0f2130");
      if (variant === "goal") {
        p.text(1, 1, "$1T", withAlpha(accent, 0.95));
        p.rect(17, 2, width - 19, 3, "#1d2b3a");
        p.rect(17, 2, 1 + f, 3, accent);
      } else if (variant === "studio") {
        // Idle: "CUT" and a blinking cursor; the scene draws the live bar over it while a video renders.
        p.text(1, 1, "CUT", withAlpha(accent, 0.95));
        if (f === 0) p.rect(width - 4, 1, 2, 5, withAlpha(accent, 0.8));
      } else {
        p.text(1, 1, "INBOX 0", withAlpha(accent, 0.95));
        if (f === 0) p.rect(width - 4, 1, 2, 5, withAlpha(accent, 0.8));
      }
    },
  };
}

/** Sliding doors: frame 0 is shut, the last frame fully open. */
export function doorPanels(orientation: "horizontal" | "vertical", tiles: number): FxStrip {
  const T = 16;
  const len = tiles * T;
  const frames = 5;
  return {
    frameW: orientation === "horizontal" ? len : T,
    frameH: orientation === "horizontal" ? T : len,
    frames,
    draw: (p, f) => {
      const half = len / 2;
      const offset = Math.round((f / (frames - 1)) * half);
      const panel = (a: number, b: number) => {
        // a..b along the door's length, clipped to the opening.
        const s = Math.max(0, a);
        const e = Math.min(len, b);
        if (e <= s) return;
        if (orientation === "horizontal") {
          p.rect(s, 3, e - s, 10, MAT.metalLight);
          p.hline(s, 3, e - s, MAT.steel);
          p.hline(s, 12, e - s, MAT.outline);
          p.rect(s, 7, e - s, 2, "#2f3a52");
        } else {
          p.rect(3, s, 10, e - s, MAT.metalLight);
          p.vline(3, s, e - s, MAT.steel);
          p.vline(12, s, e - s, MAT.outline);
          p.rect(7, s, 2, e - s, "#2f3a52");
        }
      };
      panel(-offset, half - offset);
      panel(half + offset, len + offset);
      if (f === 0) {
        // The seam light where the panels meet.
        if (orientation === "horizontal") p.rect(half - 1, 5, 2, 6, "#5ff2ff");
        else p.rect(5, half - 1, 6, 2, "#5ff2ff");
      }
    },
  };
}

export const INTAKE_CRATE: FxStrip = {
  frameW: 10,
  frameH: 9,
  frames: 1,
  draw: (p) => {
    p.box(0, 1, 10, 8, "#c98a4b", MAT.outline);
    p.hline(1, 2, 8, "#e0a866");
    p.rect(3, 4, 4, 2, "#5ff2ff");
  },
};

export const AGENT_SHADOW: FxStrip = {
  frameW: 12,
  frameH: 4,
  frames: 1,
  draw: (p) => {
    p.rect(2, 0, 8, 4, "rgba(5, 4, 18, 0.32)");
    p.rect(0, 1, 12, 2, "rgba(5, 4, 18, 0.32)");
  },
};

/** A pulsing ring under the selected crew member. */
export const SELECT_RING: FxStrip = {
  frameW: 18,
  frameH: 8,
  frames: 4,
  draw: (p, f) => {
    const alpha = [0.95, 0.75, 0.55, 0.75][f] as number;
    const c = withAlpha("#ffe066", alpha);
    p.hline(5, 0, 8, c).hline(5, 7, 8, c);
    p.hline(2, 1, 3, c).hline(13, 1, 3, c);
    p.hline(2, 6, 3, c).hline(13, 6, 3, c);
    p.vline(1, 2, 4, c).vline(16, 2, 4, c);
  },
};
