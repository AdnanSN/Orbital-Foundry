import type { ImageEndpointConfig } from "@orbital/shared";
import { describe, expect, it, vi } from "vitest";
import { decodeCloudflareRun, decodeNvidiaGenai, ImageService } from "../src/images/imageService";
import { detectImageMime, solidPng } from "../src/images/png";
import { NoCandidateError } from "../src/llm/errors";
import { createGates } from "../src/llm/rateLimiter";
import { provider } from "./helpers";

const png = solidPng(4, 4, [0, 128, 255]);
const base64 = png.toString("base64");

describe("image response decoding", () => {
  it("reads NVIDIA genai artifacts", () => {
    expect(
      decodeNvidiaGenai({ artifacts: [{ base64, finishReason: "SUCCESS", seed: 1 }] }),
    ).toEqual(png);
  });

  it("rejects content-filtered NVIDIA images", () => {
    expect(() =>
      decodeNvidiaGenai({ artifacts: [{ base64, finishReason: "CONTENT_FILTERED" }] }),
    ).toThrow(/CONTENT_FILTERED/);
  });

  it("reads Cloudflare run results", () => {
    expect(decodeCloudflareRun({ success: true, result: { image: base64 } })).toEqual(png);
  });

  it("surfaces Cloudflare errors", () => {
    expect(() =>
      decodeCloudflareRun({ success: false, errors: [{ message: "bad prompt" }] }),
    ).toThrow(/bad prompt/);
  });

  it("recognises PNG bytes", () => {
    expect(detectImageMime(png)).toBe("image/png");
    expect(detectImageMime(Buffer.from("not an image"))).toBeUndefined();
  });
});

describe("ImageService lanes", () => {
  const providers = {
    nvidia: provider("nvidia", ["sandbox"]),
    cloudflare: provider("cloudflare", ["sandbox", "live"]),
  };
  const endpoints: Record<string, ImageEndpointConfig> = {
    "nvidia-flux": {
      provider: "nvidia",
      kind: "nvidia-genai",
      url: "https://nvidia.test/flux",
      lanes: ["sandbox"],
      maxSteps: 4,
      supportsSize: true,
    },
    "cf-flux": {
      provider: "cloudflare",
      kind: "cloudflare-run",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an env placeholder the service fills in
      url: "https://cf.test/run/${CF_ACCOUNT}/flux",
      lanes: ["sandbox", "live"],
      maxSteps: 8,
      supportsSize: false,
    },
  };

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  it("only uses live-allowed endpoints in the live lane", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ success: true, result: { image: base64 } }),
    );
    const service = new ImageService({
      providers,
      endpoints,
      gates: createGates(providers),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { CF_ACCOUNT: "acc" },
    });
    const result = await service.generate("live", { prompt: "a station" });
    expect(result.endpoint).toBe("cf-flux");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://cf.test/run/acc/flux");
  });

  it("refuses the live lane when only sandbox endpoints exist", async () => {
    const service = new ImageService({
      providers,
      endpoints: { "nvidia-flux": endpoints["nvidia-flux"] as ImageEndpointConfig },
      gates: createGates(providers),
      env: {},
    });
    await expect(service.generate("live", { prompt: "x" })).rejects.toBeInstanceOf(
      NoCandidateError,
    );
  });

  it("sends size, clamped steps and the seed to NVIDIA", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ artifacts: [{ base64, finishReason: "SUCCESS" }] }),
    );
    const service = new ImageService({
      providers,
      endpoints,
      gates: createGates(providers),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
    });
    const result = await service.generateWith("nvidia-flux", "sandbox", {
      prompt: "p",
      width: 768,
      height: 1344,
      seed: 42,
      steps: 9,
    });
    expect(result.seed).toBe(42);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ prompt: "p", seed: 42, steps: 4, width: 768, height: 1344 });
  });

  it("will not run a sandbox-only endpoint in the live lane even when asked by name", async () => {
    const service = new ImageService({
      providers,
      endpoints,
      gates: createGates(providers),
      env: {},
    });
    await expect(
      service.generateWith("nvidia-flux", "live", { prompt: "x" }),
    ).rejects.toBeInstanceOf(NoCandidateError);
  });
});
