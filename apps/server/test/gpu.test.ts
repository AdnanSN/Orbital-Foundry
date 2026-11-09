import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import {
  ComfyUIGenerator,
  FalGenerator,
  fillTemplate,
  frameCount,
  type GpuConfig,
  GpuQueue,
  gpuConfigSchema,
  ModalGenerator,
  type VideoGenerator,
  type VideoGenRequest,
} from "../src/studio/gpu";
import { AssetLibrary } from "../src/studio/library";
import { MediaHub, MediaUsage, mediaConfigSchema } from "../src/studio/media";
import { WorkStore } from "../src/work/store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-gpu-"));
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
  fs.rmSync(root, { recursive: true, force: true });
});

const HOUR = 3_600_000;
/** Thursday 5 November 2026, local time. */
const at = (h: number, m = 0) => new Date(2026, 10, 5, h, m).getTime();

function fakeGen(id: string, local: boolean, opts: { ready?: boolean; cost?: number } = {}) {
  const calls: VideoGenRequest[] = [];
  let failures = 0;
  const gen: VideoGenerator & { failNext: (n: number) => void } = {
    id,
    local,
    ready: async () => opts.ready ?? true,
    estimate: () => opts.cost ?? 0,
    generate: async (req) => {
      calls.push(req);
      if (failures > 0) {
        failures -= 1;
        throw new Error("out of memory");
      }
      fs.mkdirSync(path.dirname(req.out), { recursive: true });
      fs.writeFileSync(req.out, "mp4");
      return { file: req.out, costUsd: opts.cost ?? 0 };
    },
    failNext: (n) => {
      failures = n;
    },
  };
  return { gen, calls };
}

function setup(
  opts: {
    generators?: VideoGenerator[];
    config?: Partial<GpuConfig>;
    util?: () => number | null;
    busy?: () => boolean;
    modalCap?: number;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(root, "q-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => db.close());
  let now = at(14);
  const hub = new MediaHub(
    mediaConfigSchema.parse({
      providers: {
        "comfyui-video": {
          name: "ComfyUI",
          kind: "video",
          local: true,
          lanes: ["sandbox", "live"],
          production: "allowed",
          licence: "Apache-2.0",
        },
        "modal-video": {
          name: "Modal",
          kind: "video",
          lanes: ["sandbox", "live"],
          production: "allowed",
          licence: "Apache-2.0",
          budget: { unit: "usd", monthly: 25 },
        },
      },
    }),
    new MediaUsage(db, () => now),
    {},
  );
  const store = new WorkStore(db);
  const library = new AssetLibrary(db, path.join(dir, "library"));
  const settled: string[] = [];
  const config = gpuConfigSchema.parse({
    ...opts.config,
    modal: { monthlyCapUsd: opts.modalCap ?? 25 },
  });
  const make = () =>
    new GpuQueue({
      db,
      hub,
      library,
      store,
      generators: opts.generators ?? [],
      config,
      dir: path.join(dir, "gpu"),
      utilization: async () => opts.util?.() ?? null,
      ...(opts.busy ? { busy: opts.busy } : {}),
      onSettled: (id) => void settled.push(id),
      now: () => now,
    });
  const queue = make();
  return {
    queue,
    make,
    db,
    hub,
    settled,
    setNow: (t: number) => {
      now = t;
    },
    shot: {
      prompt: "a glowing sphere drifting down a dark corridor",
      orientation: "portrait" as const,
      lane: "live" as const,
    },
  };
}

describe("GPU lane helpers", () => {
  it("counts frames as 4n+1 and fills workflow placeholders with typed values", () => {
    expect(frameCount(5, 24)).toBe(121);
    expect(frameCount(4, 16)).toBe(65);
    expect(
      fillTemplate(
        { a: "{{width}}", b: ["x {{prompt}} y"], c: { seed: "{{seed}}", keep: "{{other}}" } },
        { width: 480, prompt: "sphere", seed: 7 },
      ),
    ).toEqual({ a: 480, b: ["x sphere y"], c: { seed: 7, keep: "{{other}}" } });
  });

  it("keeps Hunyuan-based models out of the live lane", () => {
    const bad = mediaConfigSchema.safeParse({
      providers: {
        hy: {
          name: "HunyuanVideo",
          kind: "video",
          lanes: ["live"],
          production: "allowed",
          licence: "Tencent Hunyuan Community License",
        },
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe("GPU queue", () => {
  it("runs a clip on the local GPU in quiet hours and reports the script once", async () => {
    const local = fakeGen("comfyui-video", true);
    const t = setup({ generators: [local.gen], util: () => 95 });
    const job = t.queue.request("S-1", 2, t.shot);
    expect(t.queue.request("S-1", 2, t.shot).id).toBe(job.id);
    expect(t.queue.settled("S-1")).toBe(false);

    // 14:00 with a busy GPU: nothing runs.
    await t.queue.tick();
    expect(local.calls).toHaveLength(0);
    // 23:30 is quiet hours, so the GPU works even though it reads busy.
    t.setNow(at(23, 30));
    await t.queue.tick();
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0]).toMatchObject({ width: 480, height: 832, frames: 121, fps: 24 });
    expect(t.queue.jobs()[0]).toMatchObject({ status: "done", provider: "comfyui-video" });
    const clip = t.queue.clip("S-1", t.shot.prompt);
    expect(clip).toMatchObject({ kind: "video", source: "generated", sourceId: "comfyui-video" });
    expect(t.settled).toEqual(["S-1"]);
    await t.queue.tick();
    expect(t.settled).toEqual(["S-1"]);
  });

  it("waits for the GPU to be idle long enough outside quiet hours, and for renders to finish", async () => {
    const local = fakeGen("comfyui-video", true);
    let util = 50;
    let rendering = false;
    const t = setup({ generators: [local.gen], util: () => util, busy: () => rendering });
    t.queue.request("S-1", 0, t.shot);
    await t.queue.tick();
    util = 3;
    await t.queue.tick();
    expect(local.calls).toHaveLength(0);
    t.setNow(at(14, 11));
    rendering = true;
    await t.queue.tick();
    expect(local.calls).toHaveLength(0);
    rendering = false;
    await t.queue.tick();
    expect(local.calls).toHaveLength(1);
  });

  it("expires a clip that misses its deadline so the cut can go on", async () => {
    const t = setup({ generators: [fakeGen("comfyui-video", true, { ready: false }).gen] });
    const job = t.queue.request("S-2", 1, t.shot);
    expect(Date.parse(job.deadline)).toBe(at(14) + 12 * HOUR);
    await t.queue.tick();
    expect(t.settled).toEqual([]);
    t.setNow(at(14) + 12 * HOUR + 1);
    await t.queue.tick();
    expect(t.queue.jobs()[0]?.status).toBe("expired");
    expect(t.queue.clip("S-2", t.shot.prompt)).toBeNull();
    expect(t.settled).toEqual(["S-2"]);
  });

  it("gives up after 10 minutes when no generator is set up or reachable", async () => {
    const t = setup({ generators: [fakeGen("comfyui-video", true, { ready: false }).gen] });
    t.queue.request("S-3", 0, t.shot);
    await t.queue.tick();
    t.setNow(at(14, 9));
    await t.queue.tick();
    expect(t.queue.jobs()[0]?.status).toBe("queued");
    // Nothing came up in 10 minutes: the shot falls back and the waiting cut goes on.
    t.setNow(at(14, 11));
    await t.queue.tick();
    expect(t.queue.jobs()[0]).toMatchObject({ status: "expired" });
    expect(t.queue.jobs()[0]?.detail).toMatch(/No AI video generator/);
    expect(t.settled).toEqual(["S-3"]);
  });

  it("bursts to Modal near the deadline, within the monthly cap", async () => {
    const local = fakeGen("comfyui-video", true);
    const modal = fakeGen("modal-video", false, { cost: 0.12 });
    const t = setup({
      generators: [local.gen, modal.gen],
      util: () => 90,
      config: { deadlineHours: 4 },
    });
    t.queue.request("S-3", 0, t.shot);
    await t.queue.tick();
    // The local GPU is ready but busy, and the deadline is 4 hours away: no burst yet.
    expect(modal.calls).toHaveLength(0);
    // 2.5 hours before the deadline, still outside quiet hours: Modal takes it.
    t.setNow(at(15, 30));
    await t.queue.tick();
    expect(modal.calls).toHaveLength(1);
    expect(t.queue.jobs()[0]).toMatchObject({
      status: "done",
      provider: "modal-video",
      costUsd: 0.12,
    });
    expect(t.hub.usage.monthUnits("modal-video")).toBeCloseTo(0.12);

    const capped = setup({ generators: [modal.gen], modalCap: 0.1 });
    capped.queue.request("S-4", 0, capped.shot);
    await capped.queue.tick();
    expect(modal.calls).toHaveLength(1);
    expect(capped.queue.jobs()[0]?.status).toBe("queued");
  });

  it("retries a failed clip once, then gives up, and requeues a job cut off by a restart", async () => {
    const local = fakeGen("comfyui-video", true);
    const t = setup({ generators: [local.gen] });
    t.setNow(at(23, 30));
    local.gen.failNext(2);
    t.queue.request("S-5", 0, t.shot);
    await t.queue.tick();
    expect(t.queue.jobs()[0]).toMatchObject({ status: "queued", attempts: 1 });
    await t.queue.tick();
    expect(t.queue.jobs()[0]).toMatchObject({ status: "failed", attempts: 2 });
    expect(t.settled).toEqual(["S-5"]);

    t.queue.request("S-6", 0, t.shot);
    t.db
      .prepare(
        "UPDATE gpu_jobs SET status = 'running', data = json_set(data, '$.status', 'running') WHERE script_id = 'S-6'",
      )
      .run();
    const again = t.make();
    expect(again.jobs({ scriptId: "S-6" })[0]?.status).toBe("queued");
  });
});

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
function fakeFetch(routes: [RegExp, Route][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    for (const [pattern, route] of routes) {
      if (pattern.test(`${init?.method ?? "GET"} ${url.toString()}`)) return route(url, init);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const req = (out: string): VideoGenRequest => ({
  job: "G-0001",
  prompt: "a glowing sphere",
  negative: "blurry",
  seconds: 5,
  fps: 24,
  frames: 121,
  width: 480,
  height: 832,
  seed: 42,
  out,
});

describe("video generators", () => {
  it("drives ComfyUI's API: queue the workflow, wait for the history, download the video", async () => {
    const dir = fs.mkdtempSync(path.join(root, "comfy-"));
    const workflow = path.join(dir, "wf.json");
    fs.writeFileSync(
      workflow,
      JSON.stringify({
        "4": { inputs: { text: "{{prompt}}" } },
        "6": { inputs: { width: "{{width}}", height: "{{height}}", length: "{{frames}}" } },
        "8": { inputs: { seed: "{{seed}}" } },
        "11": { inputs: { filename_prefix: "orbital/{{job}}" } },
      }),
    );
    let polls = 0;
    const net = fakeFetch([
      [/system_stats/, () => json({ devices: [{ name: "RTX 3050" }] })],
      [/^POST .*\/prompt$/, () => json({ prompt_id: "p1" })],
      [
        /\/history\/p1$/,
        () =>
          json(
            ++polls < 2
              ? {}
              : {
                  p1: {
                    outputs: {
                      "11": {
                        images: [
                          { filename: "G-0001_00001_.mp4", subfolder: "orbital", type: "output" },
                        ],
                        animated: [true],
                      },
                    },
                    status: { completed: true, status_str: "success" },
                  },
                },
          ),
      ],
      [/\/view\?/, () => new Response("video-bytes", { status: 200 })],
    ]);
    const comfy = new ComfyUIGenerator({
      url: "http://127.0.0.1:8188",
      workflow,
      timeoutMinutes: 1,
      fetchImpl: net.impl,
      sleep: async () => {},
    });
    expect(await comfy.ready()).toBe(true);
    const out = path.join(dir, "clip.mp4");
    const res = await comfy.generate(req(out));
    expect(res).toEqual({ file: out, costUsd: 0 });
    expect(fs.readFileSync(out, "utf8")).toBe("video-bytes");
    const sent = JSON.parse(String(net.calls.find((c) => c.url.endsWith("/prompt"))?.init?.body));
    expect(sent.prompt["6"].inputs).toEqual({ width: 480, height: 832, length: 121 });
    expect(sent.prompt["8"].inputs.seed).toBe(42);
    expect(sent.prompt["11"].inputs.filename_prefix).toBe("orbital/G-0001");
    const view = new URL(net.calls.find((c) => c.url.includes("/view?"))?.url ?? "");
    expect(view.searchParams.get("subfolder")).toBe("orbital");
  });

  it("calls the Modal app with its proxy token and counts the GPU time it paid for", async () => {
    const dir = fs.mkdtempSync(path.join(root, "modal-"));
    let now = 0;
    const net = fakeFetch([
      [
        /^POST https:\/\/orbital--video\.modal\.run/,
        () => {
          now += 100_000;
          return new Response("mp4", { status: 200 });
        },
      ],
    ]);
    const modal = new ModalGenerator({
      url: "https://orbital--video.modal.run/",
      key: "wk-1",
      secret: "ws-1",
      costPerSecond: 0.0005,
      estimateSeconds: 240,
      fetchImpl: net.impl,
      now: () => now,
    });
    expect(await modal.ready()).toBe(true);
    expect(modal.estimate()).toBeCloseTo(0.12);
    const res = await modal.generate(req(path.join(dir, "m.mp4")));
    expect(res.costUsd).toBeCloseTo(0.05);
    const headers = (net.calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers).toMatchObject({ "Modal-Key": "wk-1", "Modal-Secret": "ws-1" });
    expect(await new ModalGenerator({ costPerSecond: 1, estimateSeconds: 1 }).ready()).toBe(false);
  });

  it("uses fal's queue API only when it is enabled", async () => {
    const dir = fs.mkdtempSync(path.join(root, "fal-"));
    const net = fakeFetch([
      [
        /^POST https:\/\/queue\.fal\.run\//,
        () =>
          json({
            request_id: "r1",
            status_url: "https://queue.fal.run/x/requests/r1/status",
            response_url: "https://queue.fal.run/x/requests/r1",
          }),
      ],
      [/requests\/r1\/status/, () => json({ status: "COMPLETED" })],
      [/requests\/r1$/, () => json({ video: { url: "https://cdn.fal.test/v.mp4" } })],
      [/cdn\.fal\.test/, () => new Response("fal-video", { status: 200 })],
    ]);
    const off = new FalGenerator({ key: "k", model: "m", costPerClip: 0.25, enabled: false });
    expect(await off.ready()).toBe(false);
    const fal = new FalGenerator({
      key: "k",
      model: "fal-ai/kling-video/v2.1/standard/text-to-video",
      costPerClip: 0.25,
      enabled: true,
      fetchImpl: net.impl,
      sleep: async () => {},
    });
    const out = path.join(dir, "f.mp4");
    expect(await fal.generate(req(out))).toEqual({ file: out, costUsd: 0.25 });
    const body = JSON.parse(String(net.calls[0]?.init?.body));
    expect(body).toMatchObject({ aspect_ratio: "9:16", duration: "5" });
    const headers = (net.calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Key k");
  });
});
