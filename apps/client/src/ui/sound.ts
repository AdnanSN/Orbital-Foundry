/**
 * Station sounds (ROADMAP Stage 11 polish), synthesized with Web Audio: no sound files. A ping
 * when something new waits at the Owner's Desk, a soft chime when real work finishes, a low buzz
 * when a crew member gets stuck. Muted in quiet hours (23:00 to 07:00) and by the toolbar toggle.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function muted(): boolean {
  try {
    return window.localStorage.getItem("orbital.muted") === "1";
  } catch {
    return false;
  }
}

export function setMuted(on: boolean): void {
  try {
    window.localStorage.setItem("orbital.muted", on ? "1" : "0");
  } catch {
    // Private windows may refuse storage; the toggle just won't persist.
  }
}

function quietNow(): boolean {
  const h = new Date().getHours();
  return h >= 23 || h < 7;
}

function tone(
  freq: number,
  start: number,
  length: number,
  type: OscillatorType,
  volume: number,
): void {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = a.currentTime + start;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + length + 0.05);
}

export type Cue = "desk" | "done" | "alert";

export function play(cue: Cue): void {
  if (muted() || quietNow()) return;
  if (cue === "desk") {
    tone(880, 0, 0.18, "sine", 0.08);
    tone(1320, 0.12, 0.25, "sine", 0.07);
  } else if (cue === "done") {
    tone(660, 0, 0.3, "triangle", 0.05);
    tone(990, 0.08, 0.4, "triangle", 0.04);
  } else {
    tone(140, 0, 0.35, "square", 0.04);
    tone(110, 0.2, 0.35, "square", 0.04);
  }
}

/** The light over the station by local time: night blue, dawn and dusk warm, none by day. */
export function ambientTint(date = new Date()): { color: string; opacity: number } {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 21 || h < 5) return { color: "#1b2a6b", opacity: 0.32 };
  if (h < 7) return { color: "#ff9a5c", opacity: 0.14 * (1 - (h - 5) / 2) + 0.06 };
  if (h >= 18) return { color: "#ff8a4c", opacity: 0.06 + 0.12 * ((h - 18) / 3) };
  return { color: "#000000", opacity: 0 };
}
