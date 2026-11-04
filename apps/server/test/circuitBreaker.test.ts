import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/llm/circuitBreaker";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens after the threshold, half-opens after the cooldown, and closes on success", () => {
    const breaker = new CircuitBreaker(3, 60_000);
    breaker.recordFailure("m");
    breaker.recordFailure("m");
    expect(breaker.isOpen("m")).toBe(false);
    breaker.recordFailure("m");
    expect(breaker.isOpen("m")).toBe(true);

    vi.advanceTimersByTime(60_001);
    expect(breaker.isOpen("m")).toBe(false);
    breaker.recordFailure("m"); // half-open: a single failure re-opens it
    expect(breaker.isOpen("m")).toBe(true);

    vi.advanceTimersByTime(60_001);
    breaker.recordSuccess("m");
    breaker.recordFailure("m");
    expect(breaker.isOpen("m")).toBe(false);
  });

  it("trips immediately for a given time", () => {
    const breaker = new CircuitBreaker();
    breaker.trip("m", 1_000);
    expect(breaker.isOpen("m")).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(breaker.isOpen("m")).toBe(false);
  });
});
