import type { CensusFile } from "@orbital/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NoCandidateError, ProviderHttpError, RouterError } from "../src/llm/errors";
import { fitTokens, mergeSystemIntoUser } from "../src/llm/router";
import { FakeTransport, makeRouter, provider, reply, tiersWith } from "./helpers";

const providers = {
  alpha: provider("alpha", ["sandbox"]),
  beta: provider("beta", ["sandbox", "live"]),
  gamma: provider("gamma", ["sandbox", "live"]),
};

function fails(status: number, message: string, retryAfterMs?: number) {
  return () => {
    throw new ProviderHttpError("test", status, message, retryAfterMs);
  };
}

describe("ModelRouter lanes", () => {
  it("never sends live traffic to a sandbox-only provider", async () => {
    const transport = new FakeTransport({
      "alpha:a1": () => reply("should never be called"),
      "beta:b1": () => reply("live ok"),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { live: ["alpha:a1", "beta:b1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "live", prompt: "hi" });
    expect(res.ref).toBe("beta:b1");
    expect(transport.callsTo("alpha:a1")).toBe(0);
  });

  it("refuses outright when the live lane only lists sandbox providers", async () => {
    const transport = new FakeTransport({ "alpha:a1": () => reply("nope") });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { live: ["alpha:a1"] } }),
    });
    await expect(
      router.generate({ tier: "fast", lane: "live", prompt: "hi" }),
    ).rejects.toBeInstanceOf(NoCandidateError);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("ModelRouter fallbacks", () => {
  it("falls back to the next candidate when one fails", async () => {
    const transport = new FakeTransport({
      "alpha:a1": fails(503, "overloaded"),
      "beta:b1": () => reply("hello"),
    });
    const { router, usage } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(res.ref).toBe("beta:b1");
    expect(res.text).toBe("hello");
    expect(res.attempts.map((a) => a.outcome)).toEqual(["server", "ok"]);
    expect(usage.entries.map((e) => e.outcome)).toEqual(["server", "ok"]);
  });

  it("skips providers whose API key is missing", async () => {
    const transport = new FakeTransport({ "beta:b1": () => reply("ok") });
    const { router } = makeRouter({
      providers: { ...providers, alpha: provider("alpha", ["sandbox"], { apiKey: undefined }) },
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(res.ref).toBe("beta:b1");
    expect(router.plan("fast", "sandbox").skipped[0]).toContain("ALPHA_API_KEY is not set");
  });

  it("cools a provider down after HTTP 429 and uses another one", async () => {
    const transport = new FakeTransport({
      "alpha:a1": fails(429, "slow down", 30_000),
      "beta:b1": () => reply("ok"),
    });
    const { router, gates } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(res.ref).toBe("beta:b1");
    expect(gates.get("alpha")?.stats().cooldownMs).toBeGreaterThan(25_000);
  });

  it("waits out a brief rate limit and tries the same provider again", async () => {
    let calls = 0;
    const transport = new FakeTransport({
      "alpha:a1": () => {
        calls += 1;
        if (calls === 1) throw new ProviderHttpError("test", 429, "tokens per minute", 50);
        return reply("second time lucky");
      },
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(res.text).toBe("second time lucky");
    expect(transport.callsTo("alpha:a1")).toBe(2);
  });

  it("fails at once on a long rate limit (a daily cap) instead of waiting", async () => {
    const transport = new FakeTransport({ "alpha:a1": fails(429, "requests per day", 3_600_000) });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    await expect(
      router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" }),
    ).rejects.toBeInstanceOf(RouterError);
    expect(transport.callsTo("alpha:a1")).toBe(1);
  });

  it("benches only the model that hit a daily cap; the provider's others stay in play", async () => {
    const transport = new FakeTransport({
      "alpha:a1": fails(429, "tokens per day (TPD)", 1_371_000),
      "alpha:a2": () => reply("from a2"),
    });
    const { router, gates } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "alpha:a2"] } }),
    });
    const first = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(first.ref).toBe("alpha:a2");
    expect(gates.get("alpha")?.stats().cooldownMs ?? 0).toBeLessThan(1000);
    // The capped model is skipped from then on.
    const second = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(second.ref).toBe("alpha:a2");
    expect(transport.callsTo("alpha:a1")).toBe(1);
  });

  it("prefers a less busy provider over waiting in a long queue", async () => {
    const transport = new FakeTransport({
      "alpha:a1": () => reply("from alpha"),
      "beta:b1": () => reply("from beta"),
    });
    const { router, gates } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    gates.get("alpha")?.cooldown(60_000);
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(res.ref).toBe("beta:b1");
    expect(res.attempts[0]?.outcome).toBe("busy");
    expect(transport.callsTo("alpha:a1")).toBe(0);
  });

  it("stops using a provider after it rejects the API key", async () => {
    const transport = new FakeTransport({
      "alpha:a1": fails(401, "invalid key"),
      "alpha:a2": () => reply("never reached"),
      "beta:b1": () => reply("ok"),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "alpha:a2", "beta:b1"] } }),
    });
    await router.generate({ tier: "fast", lane: "sandbox", prompt: "first" });
    await router.generate({ tier: "fast", lane: "sandbox", prompt: "second" });
    expect(transport.callsTo("alpha:a1")).toBe(1);
    expect(transport.callsTo("alpha:a2")).toBe(0);
  });

  it("reports every attempt when all candidates fail", async () => {
    const transport = new FakeTransport({
      "alpha:a1": fails(500, "boom"),
      "beta:b1": fails(404, "no such model"),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    const err = await router
      .generate({ tier: "fast", lane: "sandbox", prompt: "hi" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect((err as RouterError).attempts.map((a) => a.outcome)).toEqual(["server", "not-found"]);
  });
});

describe("ModelRouter structured output", () => {
  const schema = z.object({ mood: z.enum(["calm", "busy"]) });

  it("repairs invalid JSON with one follow-up turn", async () => {
    const transport = new FakeTransport({
      "alpha:a1": (_req, n) =>
        n === 1 ? reply("Sure! Here you go: calm") : reply('```json\n{"mood":"calm"}\n```'),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "mood?", schema });
    expect(res.data).toEqual({ mood: "calm" });
    expect(transport.callsTo("alpha:a1")).toBe(2);
    expect(transport.calls[1]?.req.messages.at(-1)?.role).toBe("user");
    expect(transport.calls[0]?.req.messages[0]?.role).toBe("system");
  });

  it("moves to the next model when the JSON stays invalid", async () => {
    const transport = new FakeTransport({
      "alpha:a1": () => reply("still not json"),
      "beta:b1": () => reply('{"mood":"busy"}'),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "mood?", schema });
    expect(res.ref).toBe("beta:b1");
    expect(res.data).toEqual({ mood: "busy" });
    expect(transport.callsTo("alpha:a1")).toBe(2);
  });
});

describe("ModelRouter census and quirks", () => {
  it("skips models the census marked as failing a required capability", async () => {
    const census: CensusFile = {
      generatedAt: "2026-11-04T00:00:00.000Z",
      entries: {
        "alpha:a1": {
          ref: "alpha:a1",
          testedAt: "2026-11-04T00:00:00.000Z",
          probes: { chat: { ok: true }, json: { ok: true }, tools: { ok: false } },
        },
      },
    };
    const transport = new FakeTransport({ "beta:b1": () => reply("ok") });
    const { router } = makeRouter({
      providers,
      transport,
      census,
      tiers: tiersWith({ reasoning: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    const res = await router.generate({ tier: "reasoning", lane: "sandbox", prompt: "plan" });
    expect(res.ref).toBe("beta:b1");
    expect(transport.callsTo("alpha:a1")).toBe(0);
  });

  it("retries without a system message when a model rejects it", async () => {
    const transport = new FakeTransport({
      "alpha:a1": (req) => {
        if (req.messages.some((m) => m.role === "system")) {
          throw new ProviderHttpError("alpha", 400, "System role not supported");
        }
        return reply("merged ok");
      },
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    const res = await router.generate({
      tier: "fast",
      lane: "sandbox",
      system: "You are WARDEN.",
      prompt: "hi",
    });
    expect(res.text).toBe("merged ok");
    expect(transport.calls.at(-1)?.req.messages[0]).toEqual({
      role: "user",
      content: "You are WARDEN.\n\nhi",
    });
  });

  it("folds system text into an image message as a leading text part", () => {
    const merged = mergeSystemIntoUser([
      { role: "system", content: "Rules" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] },
    ]);
    expect(merged).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Rules" },
          { type: "image_url", image_url: { url: "data:x" } },
        ],
      },
    ]);
  });
});

describe("ModelRouter token budget and empty replies", () => {
  it("caps the output tokens a request asks a provider for (limits.maxTokens)", async () => {
    const capped = provider("alpha", ["sandbox"], {
      limits: { rpm: 1000, concurrency: 8, maxTokens: 1500 },
    });
    const transport = new FakeTransport({ "alpha:a1": () => reply("short answer") });
    const { router } = makeRouter({
      providers: { alpha: capped },
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi", maxTokens: 4000 });
    expect(transport.calls.map((c) => c.req.maxTokens)).toEqual([1500]);
  });

  it("lets a caller ask for a longer reply (limits.largeTokens), trimmed to the minute's budget", async () => {
    const groqLike = provider("alpha", ["sandbox"], {
      limits: { rpm: 1000, concurrency: 8, maxTokens: 1500, largeTokens: 4500, tpm: 8000 },
    });
    const transport = new FakeTransport({ "alpha:a1": () => reply("ok") });
    const { router } = makeRouter({
      providers: { alpha: groqLike },
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    // A plain call keeps the default cap; a call that asks for more gets up to largeTokens.
    await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi", maxTokens: 6000 });
    // About 4,000 tokens of input leave room for about 3,700 of output under 8,000 a minute.
    await router.generate({
      tier: "fast",
      lane: "sandbox",
      prompt: "x".repeat(14_000),
      maxTokens: 4500,
    });
    const asked = transport.calls.map((c) => c.req.maxTokens ?? 0);
    expect(asked.slice(0, 2)).toEqual([1500, 4500]);
    expect(asked[2]).toBeGreaterThan(3500);
    expect(asked[2]).toBeLessThan(3800);
  });

  it("asks for less when a request's input would fill the minute's budget (limits.tpm)", () => {
    const msgs = [{ role: "user" as const, content: "y".repeat(35_000) }];
    // 10,000 tokens of input already pass 8,000: the floor of 512 (the provider will say no).
    expect(fitTokens(1500, 8000, msgs)).toBe(512);
    expect(fitTokens(4500, undefined, msgs)).toBe(4500);
    expect(fitTokens(undefined, 8000, msgs)).toBeUndefined();
    expect(fitTokens(4500, 8000, [{ role: "user", content: "hi" }])).toBe(4500);
  });

  it("retries with a bigger token budget when a model runs out mid-thought", async () => {
    const transport = new FakeTransport({
      "alpha:a1": (req) =>
        (req.maxTokens ?? 0) < 1600
          ? reply("", { finishReason: "length" })
          : reply("Welcome aboard!", { finishReason: "stop" }),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    const res = await router.generate({
      tier: "fast",
      lane: "sandbox",
      prompt: "hi",
      maxTokens: 400,
    });
    expect(res.text).toBe("Welcome aboard!");
    expect(transport.calls.map((c) => c.req.maxTokens)).toEqual([400, 2048]);
    expect(res.attempts.map((a) => a.outcome)).toEqual(["truncated", "ok"]);
  });

  it("keeps a reply that hit the token limit when its JSON is already complete", async () => {
    const transport = new FakeTransport({
      "alpha:a1": () =>
        reply(`{"name":"Nova","age":3}${"\n".repeat(50)}And some rambling that got cut off`, {
          finishReason: "length",
        }),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1"] } }),
    });
    const res = await router.generate({
      tier: "fast",
      lane: "sandbox",
      prompt: "hi",
      schema: z.object({ name: z.string(), age: z.number() }),
      maxTokens: 400,
    });
    expect(res.data).toEqual({ name: "Nova", age: 3 });
    expect(transport.calls).toHaveLength(1);
  });

  it("falls back when a model returns an empty reply", async () => {
    const transport = new FakeTransport({
      "alpha:a1": () => reply("", { finishReason: "stop" }),
      "beta:b1": () => reply("hello"),
    });
    const { router } = makeRouter({
      providers,
      transport,
      tiers: tiersWith({ fast: { sandbox: ["alpha:a1", "beta:b1"] } }),
    });
    const res = await router.generate({ tier: "fast", lane: "sandbox", prompt: "hi" });
    expect(res.ref).toBe("beta:b1");
    expect(res.attempts[0]).toMatchObject({ outcome: "invalid-output", message: "empty reply" });
  });
});
