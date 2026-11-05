import {
  describe,
  describe as describeLive,
  expect,
  expect as expectLive,
  it,
  it as itLive,
} from "vitest";
import { loadProvidersFile, loadTiersFile, resolveProviders, validateConfig } from "../src/config";

describeLive("live lane terms", () => {
  itLive("refuses the live lane for a provider whose terms are not recorded as allowing it", () => {
    const providers = loadProvidersFile();
    const groq = providers.providers.groq;
    if (!groq) throw new Error("groq missing");
    providers.providers.groq = { ...groq, lanes: ["sandbox", "live"], production: "unverified" };
    expectLive(validateConfig(providers, loadTiersFile()).join("\n")).toContain(
      "providers.groq: the live lane needs production: allowed",
    );
  });
});

describe("config files", () => {
  it("parse and pass validation", () => {
    expect(validateConfig(loadProvidersFile(), loadTiersFile())).toEqual([]);
  });

  it("keep NVIDIA's free trial out of the live lane", () => {
    const file = loadProvidersFile();
    expect(file.providers.nvidia?.lanes).toEqual(["sandbox"]);
    expect(file.images["nvidia-flux-schnell"]?.lanes).toEqual(["sandbox"]);
  });

  it("serve the live lane only from providers whose terms allow it (D-045)", () => {
    const allowed = Object.entries(loadProvidersFile().providers)
      .filter(([, p]) => p.production === "allowed")
      .map(([id]) => id)
      .sort();
    expect(allowed).toEqual(["cloudflare", "groq"]);
    const live = Object.values(loadTiersFile().tiers).flatMap((t) => t.live);
    for (const ref of live) expect(allowed).toContain(ref.split(":")[0]);
    // Groq's preview models are for evaluation only, so none of them serves the live lane.
    expect(live).not.toContain("groq:qwen/qwen3.8-27b");
  });

  it("flag a live tier that names a sandbox-only provider", () => {
    const tiers = loadTiersFile();
    tiers.tiers.fast.live.push("nvidia:openai/gpt-oss-20b");
    expect(validateConfig(loadProvidersFile(), tiers).join("\n")).toContain(
      'provider "nvidia" is not allowed in the live lane',
    );
  });

  it("fill env-var placeholders in URLs and report missing ones", () => {
    const partial = resolveProviders(loadProvidersFile(), { CLOUDFLARE_API_TOKEN: "t" });
    expect(partial.cloudflare?.missingEnv).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);

    const full = resolveProviders(loadProvidersFile(), {
      CLOUDFLARE_ACCOUNT_ID: "abc",
      CLOUDFLARE_API_TOKEN: "t",
    });
    expect(full.cloudflare?.resolvedBaseURL).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
    );
    expect(full.cloudflare?.apiKey).toBe("t");
    expect(full.nvidia?.apiKey).toBeUndefined();
  });
});
