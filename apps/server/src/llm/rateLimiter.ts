import type { ProviderLimits } from "@orbital/shared";
import type { ResolvedProviders } from "../config";
import { QuotaExhaustedError } from "./errors";

const MINUTE = 60_000;

export interface GateStats {
  provider: string;
  inFlight: number;
  queued: number;
  /** Requests started in the last 60 seconds. */
  lastMinute: number;
  /** Requests started today (UTC). */
  today: number;
  cooldownMs: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

/**
 * Per-provider request gate: requests per minute (sliding window), requests per UTC day,
 * maximum concurrency, and a cooldown after HTTP 429. Waiters are served first come, first served.
 */
export class ProviderGate {
  private inFlight = 0;
  private readonly starts: number[] = [];
  private day: string;
  private dayCount: number;
  private cooldownUntil = 0;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly provider: string,
    private readonly limits: ProviderLimits,
    usedToday = 0,
  ) {
    this.day = utcDay(Date.now());
    this.dayCount = usedToday;
  }

  /** Resolves with a release function once a slot is free. Rejects if today's budget is used up. */
  acquire(): Promise<() => void> {
    this.rollDay(Date.now());
    if (this.dailyBudgetUsed()) return Promise.reject(new QuotaExhaustedError(this.provider));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.pump();
    });
  }

  /** Pause this provider, e.g. after an HTTP 429. */
  cooldown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    this.pump();
  }

  /** Rough time until a new request would start. Used to prefer a less busy provider. */
  estimatedWaitMs(): number {
    const now = Date.now();
    this.prune(now);
    const cooldown = Math.max(0, this.cooldownUntil - now);
    const windowFull = this.starts.length >= this.limits.rpm;
    const windowWait = windowFull ? (this.starts[0] ?? now) + MINUTE - now : 0;
    const queueWait = this.queue.length * (MINUTE / this.limits.rpm);
    return Math.max(cooldown, windowWait) + queueWait;
  }

  stats(): GateStats {
    const now = Date.now();
    this.prune(now);
    return {
      provider: this.provider,
      inFlight: this.inFlight,
      queued: this.queue.length,
      lastMinute: this.starts.length,
      today: this.dayCount,
      cooldownMs: Math.max(0, this.cooldownUntil - now),
    };
  }

  private pump(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.queue.length > 0) {
      const now = Date.now();
      this.rollDay(now);
      if (this.dailyBudgetUsed()) {
        for (const waiter of this.queue.splice(0)) {
          waiter.reject(new QuotaExhaustedError(this.provider));
        }
        return;
      }
      const wait = this.waitMs(now);
      if (wait === Number.POSITIVE_INFINITY) return; // a release() will pump again
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, wait);
        return;
      }
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.inFlight++;
      this.starts.push(now);
      this.dayCount++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.inFlight--;
        this.pump();
      });
    }
  }

  private waitMs(now: number): number {
    if (now < this.cooldownUntil) return this.cooldownUntil - now;
    if (this.inFlight >= this.limits.concurrency) return Number.POSITIVE_INFINITY;
    this.prune(now);
    if (this.starts.length >= this.limits.rpm) return (this.starts[0] ?? now) + MINUTE - now;
    return 0;
  }

  private prune(now: number): void {
    while (this.starts.length > 0 && (this.starts[0] ?? 0) <= now - MINUTE) this.starts.shift();
  }

  private rollDay(now: number): void {
    const day = utcDay(now);
    if (day !== this.day) {
      this.day = day;
      this.dayCount = 0;
    }
  }

  private dailyBudgetUsed(): boolean {
    return this.limits.rpd !== undefined && this.dayCount >= this.limits.rpd;
  }
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One gate per provider, seeded with today's usage so restarts don't reset daily budgets. */
export function createGates(
  providers: ResolvedProviders,
  usedToday: (provider: string) => number = () => 0,
): Map<string, ProviderGate> {
  const gates = new Map<string, ProviderGate>();
  for (const provider of Object.values(providers)) {
    gates.set(provider.id, new ProviderGate(provider.id, provider.limits, usedToday(provider.id)));
  }
  return gates;
}
