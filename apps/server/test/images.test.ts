import { inflateSync } from "node:zlib";
import type { ImageEndpointConfig } from "@orbital/shared";
import { describe, expect, it, vi } from "vitest";
import {
  decodeCloudflareRun,
  decodeNvidiaGenai,
  ImageService,
  NVCF_STATUS_URL,
} from "../src/images/imageService";
import { circlePng, detectImageMime, solidPng } from "../src/images/png";
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
      supportsSeed: true,
      pollSeconds: 30,
    },
    "cf-flux": {
      provider: "cloudflare",
      kind: "cloudflare-run",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an env placeholder the service fills in
      url: "https://cf.test/run/${CF_ACCOUNT}/flux",
      lanes: ["sandbox", "live"],
      maxSteps: 8,
      supportsSize: false,
      supportsSeed: false,
      pollSeconds: 30,
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

describe("circlePng", () => {
  /** Read one pixel back. Our encoder writes a single unfiltered IDAT chunk right after IHDR. */
  function pixelAt(image: Buffer, width: number, x: number, y: number): number[] {
    const idat = 8 + 25; // PNG signature + IHDR chunk
    const length = image.readUInt32BE(idat);
    const raw = inflateSync(image.subarray(idat + 8, idat + 8 + length));
    const offset = y * (1 + width * 3) + 1 + x * 3;
    return [raw[offset] ?? -1, raw[offset + 1] ?? -1, raw[offset + 2] ?? -1];
  }

  it("draws a filled circle on a plain background (not a uniform image)", () => {
    const image = circlePng(64, [220, 30, 30]);
    expect(detectImageMime(image)).toBe("image/png");
    expect(pixelAt(image, 64, 32, 32)).toEqual([220, 30, 30]);
    expect(pixelAt(image, 64, 0, 0)).toEqual([245, 245, 245]);
  });
});

describe("ImageService requests", () => {
  const providers = {
    nvidia: provider("nvidia", ["sandbox"]),
    cloudflare: provider("cloudflare", ["sandbox", "live"]),
  };
  const nvidiaFlux: ImageEndpointConfig = {
    provider: "nvidia",
    kind: "nvidia-genai",
    url: "https://nvidia.test/flux",
    lanes: ["sandbox"],
    maxSteps: 4,
    supportsSize: true,
    supportsSeed: true,
    pollSeconds: 30,
  };
  const cloudflareFlux: ImageEndpointConfig = {
    provider: "cloudflare",
    kind: "cloudflare-run",
    url: "https://cf.test/flux",
    lanes: ["sandbox", "live"],
    maxSteps: 8,
    supportsSize: false,
    supportsSeed: false,
    pollSeconds: 30,
  };
  type FetchArgs = [string | URL | Request, RequestInit?];

  it("omits the seed for endpoints that reject one", async () => {
    const fetchImpl = vi.fn(
      async (..._args: FetchArgs) =>
        new Response(JSON.stringify({ success: true, result: { image: base64 } })),
    );
    const service = new ImageService({
      providers,
      endpoints: { "cf-flux": cloudflareFlux },
      gates: createGates(providers),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
    });
    const result = await service.generate("live", { prompt: "p", seed: 7 });
    expect(result.seed).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      prompt: "p",
      steps: 8,
    });
  });

  it("follows NVIDIA's 202 + request id flow", async () => {
    const fetchImpl = vi.fn(async (..._args: FetchArgs) =>
      fetchImpl.mock.calls.length === 1
        ? new Response(null, { status: 202, headers: { "NVCF-REQID": "req-1" } })
        : new Response(JSON.stringify({ artifacts: [{ base64, finishReason: "SUCCESS" }] })),
    );
    const service = new ImageService({
      providers,
      endpoints: { "nvidia-flux": nvidiaFlux },
      gates: createGates(providers),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
    });
    const result = await service.generate("sandbox", { prompt: "p" });
    expect(result.bytes).toEqual(png);
    const first = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(first["NVCF-POLL-SECONDS"]).toBe("30");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(`${NVCF_STATUS_URL}/req-1`);
  });

  it("stops trying an endpoint that keeps failing and uses the next one", async () => {
    const fetchImpl = vi.fn(async (...args: FetchArgs) =>
      String(args[0]).includes("nvidia")
        ? new Response("", { status: 504, headers: { "nvcf-status": "errored" } })
        : new Response(JSON.stringify({ success: true, result: { image: base64 } })),
    );
    const service = new ImageService({
      providers,
      endpoints: { "nvidia-flux": nvidiaFlux, "cf-flux": cloudflareFlux },
      gates: createGates(providers),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
    });
    for (let i = 0; i < 4; i++) {
      const result = await service.generate("sandbox", { prompt: "p" });
      expect(result.endpoint).toBe("cf-flux");
    }
    const nvidiaCalls = fetchImpl.mock.calls.filter((call) => String(call[0]).includes("nvidia"));
    expect(nvidiaCalls).toHaveLength(3); // the breaker opens after three failures
  });
});
