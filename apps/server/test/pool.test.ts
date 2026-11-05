import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { loadProvidersFile, loadTiersFile, validateConfig } from "../src/config";
import { migrate } from "../src/db";
import { OpenAICompatibleTransport } from "../src/llm/transport";
import { SqliteUsageLog } from "../src/llm/usage";
import { provider } from "./helpers";

/** The FreeLLMAPI pool (D-044): sandbox only, and every answer says which upstream gave it. */

describe("the FreeLLMAPI pool", () => {
  it("is configured for the sandbox lane only, and validation keeps it there", () => {
    const providers = loadProvidersFile();
    const pool = providers.providers.freellm;
    expect(pool).toMatchObject({
      baseURL: "http://127.0.0.1:3001/v1",
      apiKeyEnv: "FREELLM_API_KEY",
      lanes: ["sandbox"],
      production: "forbidden",
    });
    const tiers = loadTiersFile();
    expect(tiers.tiers.reasoning.sandbox[0]).toBe("freellm:auto:smart");
    expect(tiers.tiers.creative.sandbox[0]).toBe("freellm:auto");
    expect(tiers.tiers.fast.sandbox[0]).toBe("freellm:auto:fast");
    expect(tiers.tiers.embed.sandbox.some((r) => r.startsWith("freellm:"))).toBe(false);
    for (const tier of Object.values(tiers.tiers)) {
      expect(tier.live.some((r) => r.startsWith("freellm:"))).toBe(false);
    }
    expect(validateConfig(providers, tiers)).toEqual([]);
    // Putting it in the live lane is refused.
    if (!pool) throw new Error("no pool");
    providers.providers.freellm = { ...pool, lanes: ["sandbox", "live"] };
    expect(validateConfig(providers, tiers).join("\n")).toContain("providers.freellm");
  });

  it("records which upstream answered (X-Routed-Via)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "auto:smart",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hi." } },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-routed-via": "google/gemini-2.5-flash%E2%9C%93",
          },
        },
      )) as typeof fetch;
    const transport = new OpenAICompatibleTransport(
      {
        freellm: provider("freellm", ["sandbox"], { resolvedBaseURL: "http://127.0.0.1:3001/v1" }),
      },
      5_000,
      fetchImpl,
    );
    const res = await transport.chat("freellm", {
      model: "auto:smart",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("Hi.");
    expect(res.routedVia).toBe("google/gemini-2.5-flash✓");

    const db = new Database(":memory:");
    migrate(db);
    new SqliteUsageLog(db).record({
      lane: "sandbox",
      tier: "reasoning",
      provider: "freellm",
      model: "auto:smart",
      kind: "chat",
      outcome: "ok",
      routedVia: res.routedVia,
    });
    expect(db.prepare("SELECT routed_via FROM llm_calls").get()).toEqual({
      routed_via: "google/gemini-2.5-flash✓",
    });
    db.close();
  });
});
