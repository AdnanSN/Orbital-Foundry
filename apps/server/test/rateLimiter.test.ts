import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaExhaustedError } from "../src/llm/errors";
import { ProviderGate } from "../src/llm/rateLimiter";

describe("ProviderGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows `rpm` requests per minute, then waits for the window to slide", async () => {
    const gate = new ProviderGate("p", { rpm: 2, concurrency: 10 });
    (await gate.acquire())();
    (await gate.acquire())();
    let started = false;
    const third = gate.acquire().then((release) => {
      started = true;
      release();
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await third;
    expect(started).toBe(true);
  });

  it("never runs more than `concurrency` requests at once", async () => {
    const gate = new ProviderGate("p", { rpm: 100, concurrency: 1 });
    const releaseFirst = await gate.acquire();
    let second = false;
    const pending = gate.acquire().then((release) => {
      second = true;
      release();
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second).toBe(false);
    releaseFirst();
    await pending;
    expect(second).toBe(true);
  });

  it("rejects once the daily budget is used up, and resets at UTC midnight", async () => {
    const gate = new ProviderGate("p", { rpm: 100, rpd: 2, concurrency: 5 }, 1);
    (await gate.acquire())();
    await expect(gate.acquire()).rejects.toBeInstanceOf(QuotaExhaustedError);
    vi.setSystemTime(new Date("2026-11-05T00:00:01Z"));
    (await gate.acquire())();
    expect(gate.stats().today).toBe(1);
  });

  it("holds requests during a cooldown", async () => {
    const gate = new ProviderGate("p", { rpm: 100, concurrency: 5 });
    gate.cooldown(10_000);
    let started = false;
    const pending = gate.acquire().then((release) => {
      started = true;
      release();
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(started).toBe(true);
  });

  it("estimates the wait while cooling down", () => {
    const gate = new ProviderGate("p", { rpm: 60, concurrency: 5 });
    gate.cooldown(30_000);
    expect(gate.estimatedWaitMs()).toBeGreaterThanOrEqual(30_000);
  });

  it("ignores a release function that is called twice", async () => {
    const gate = new ProviderGate("p", { rpm: 100, concurrency: 1 });
    const release = await gate.acquire();
    release();
    release();
    expect(gate.stats().inFlight).toBe(0);
  });
});
