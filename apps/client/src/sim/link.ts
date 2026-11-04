import type { MockDirector } from "../mock/director";
import type { World } from "./world";

/**
 * Where station events come from. Stage 2 has only the mock director; Stage 3 adds a WebSocket
 * link to the server that delivers the same events (a snapshot on connect, then increments).
 */
export interface StationLink {
  readonly kind: "mock" | "server";
  /** Deliver the opening snapshot. */
  start(): void;
  /** Called once per frame with the current sim time. */
  update(now: number): void;
}

export class MockLink implements StationLink {
  readonly kind = "mock";

  constructor(
    private readonly director: MockDirector,
    private readonly world: World,
  ) {}

  start(): void {
    this.world.apply(this.director.snapshot());
    this.world.commit();
  }

  update(now: number): void {
    const events = this.director.advanceTo(now);
    for (const e of events) this.world.apply(e);
    this.world.commit();
  }
}
