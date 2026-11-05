/**
 * Simulation time in milliseconds. The clock advances by real frame time scaled by `speed`, and
 * only while the page is running frames, so a hidden tab simply pauses the mock station. From
 * Stage 3 the server owns time and this clock will follow it.
 */
export class SimClock {
  /** Longest real step accepted per tick, so a stalled frame cannot fast-forward the station. */
  static readonly MAX_STEP_MS = 250;

  private t: number;
  private rate = 1;
  private stopped = false;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  get speed(): number {
    return this.rate;
  }

  get paused(): boolean {
    return this.stopped;
  }

  /** Advance by a real-time step (ms). Returns the simulated step that was applied. */
  tick(realMs: number): number {
    if (this.stopped || !(realMs > 0)) return 0;
    const step = Math.min(realMs, SimClock.MAX_STEP_MS) * this.rate;
    this.t += step;
    return step;
  }

  /** Jump to a given time, e.g. to follow the server's clock. */
  set(t: number): void {
    this.t = t;
  }

  /** Jump forward without frames, e.g. to warm up the mock station before the first render. */
  advance(simMs: number): void {
    if (simMs > 0) this.t += simMs;
  }

  setSpeed(speed: number): void {
    if (!(speed > 0)) throw new Error(`Invalid speed ${speed}`);
    this.rate = speed;
  }

  pause(): void {
    this.stopped = true;
  }

  resume(): void {
    this.stopped = false;
  }
}
