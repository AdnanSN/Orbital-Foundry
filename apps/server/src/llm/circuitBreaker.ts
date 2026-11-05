/**
 * Stops calling a model that keeps failing. After `threshold` consecutive failures the circuit
 * opens for `cooldownMs`; once that passes, a single further failure re-opens it (half-open).
 */
export class CircuitBreaker {
  private readonly state = new Map<string, { failures: number; openUntil: number }>();

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 5 * 60_000,
  ) {}

  isOpen(key: string): boolean {
    const entry = this.state.get(key);
    return entry !== undefined && entry.openUntil > Date.now();
  }

  /** When an open circuit closes again (ms), or 0 while it is closed. */
  openUntil(key: string): number {
    const until = this.state.get(key)?.openUntil ?? 0;
    return until > Date.now() ? until : 0;
  }

  recordSuccess(key: string): void {
    this.state.delete(key);
  }

  recordFailure(key: string): void {
    const entry = this.state.get(key) ?? { failures: 0, openUntil: 0 };
    entry.failures++;
    if (entry.failures >= this.threshold) {
      entry.openUntil = Date.now() + this.cooldownMs;
      entry.failures = this.threshold - 1;
    }
    this.state.set(key, entry);
  }

  /** Open immediately, e.g. when a model doesn't exist or isn't available to this account. */
  trip(key: string, ms: number = this.cooldownMs): void {
    this.state.set(key, { failures: this.threshold - 1, openUntil: Date.now() + ms });
  }
}
