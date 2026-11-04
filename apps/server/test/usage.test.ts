import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db";
import { SqliteUsageLog } from "../src/llm/usage";

describe("SqliteUsageLog", () => {
  it("records calls and counts today's requests per provider", () => {
    const db = openDb(":memory:");
    const log = new SqliteUsageLog(db);
    log.record({
      lane: "sandbox",
      provider: "nvidia",
      model: "m",
      kind: "chat",
      outcome: "ok",
      latencyMs: 120,
    });
    log.record({
      lane: "sandbox",
      provider: "nvidia",
      model: "m",
      kind: "chat",
      outcome: "rate-limited",
    });
    log.record({
      lane: "live",
      provider: "cloudflare",
      model: "flux",
      kind: "image",
      outcome: "ok",
    });
    expect(log.countToday("nvidia")).toBe(2);
    expect(log.countToday("cloudflare")).toBe(1);

    migrate(db); // running migrations again is a no-op
    expect(log.countToday("nvidia")).toBe(2);
    db.close();
  });
});
