import { describe, expect, it } from "vitest";
import { loadProvidersFile, loadTiersFile, resolveProviders, validateConfig } from "../src/config";

describe("config files", () => {
  it("parse and pass validation", () => {
    expect(validateConfig(loadProvidersFile(), loadTiersFile())).toEqual([]);
  });

  it("keep NVIDIA's free trial out of the live lane", () => {
    const file = loadProvidersFile();
    expect(file.providers.nvidia?.lanes).toEqual(["sandbox"]);
    expect(file.images["nvidia-flux-schnell"]?.lanes).toEqual(["sandbox"]);
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
