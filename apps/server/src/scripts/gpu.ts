import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../env";
import { ARTIFACTS_DIR, CONFIG_DIR, REPO_ROOT } from "../paths";
import { ComfyUIGenerator, frameCount, loadGpuConfig } from "../studio/gpu";

/**
 * The GPU lane from a terminal (Stage 18, D-060):
 *   npm run gpu -- status     the GPU, free disk, ComfyUI and the workflows in config/gpu/
 *   npm run gpu -- bench      one 5-second 480p clip per workflow, timed, with peak VRAM;
 *                             results in data/artifacts/gpu/bench/. Add a file name to run one.
 * It never downloads models; infra/gpu/README.md says what to install.
 */

loadEnv();
const config = loadGpuConfig();

function smi(query: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [`--query-gpu=${query}`, "--format=csv,noheader,nounits"],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) =>
        resolve(
          err
            ? null
            : String(stdout)
                .trim()
                .split(",")
                .map((s) => s.trim()),
        ),
    );
  });
}

function workflows(only?: string): string[] {
  const dir = path.join(CONFIG_DIR, "gpu");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".api.json") && (!only || f === only || f.startsWith(only)))
    .map((f) => path.join(dir, f));
}

function freeGb(dir: string): number {
  const s = fs.statfsSync(dir);
  return (s.bavail * s.bsize) / 1024 ** 3;
}

async function status(): Promise<void> {
  const gpu = await smi("name,memory.total,memory.used,utilization.gpu,driver_version");
  console.log(
    gpu
      ? `GPU: ${gpu[0]}, ${gpu[1]} MB VRAM (${gpu[2]} MB used), ${gpu[3]}% busy, driver ${gpu[4]}`
      : "GPU: nvidia-smi didn't answer (no NVIDIA driver on the PATH?)",
  );
  console.log(`Free disk where the repo lives: ${freeGb(REPO_ROOT).toFixed(1)} GB`);
  const comfy = new ComfyUIGenerator(config.comfyui);
  console.log(
    `ComfyUI at ${config.comfyui.url}: ${(await comfy.ready()) ? "ready" : "not answering, or its workflow file is missing"}`,
  );
  const found = workflows();
  console.log(
    found.length
      ? `Workflows: ${found.map((f) => path.basename(f)).join(", ")} (in use: ${config.comfyui.workflow})`
      : "Workflows: none in config/gpu/",
  );
  console.log(
    `Quiet hours ${config.quietHours[0]}:00 to ${config.quietHours[1]}:00; idle after ${config.idle.minutes} min under ${config.idle.belowPercent}%; deadline ${config.deadlineHours} h`,
  );
}

async function bench(only?: string): Promise<void> {
  const files = workflows(only);
  if (files.length === 0) throw new Error("No workflows in config/gpu/ to benchmark.");
  const out = path.join(ARTIFACTS_DIR, "gpu", "bench");
  fs.mkdirSync(out, { recursive: true });
  const [w, h] = config.clip.portrait;
  const { seconds, fps } = config.clip;
  const results: {
    workflow: string;
    ok: boolean;
    seconds?: number;
    peakMb?: number;
    error?: string;
  }[] = [];
  for (const file of files) {
    const name = path.basename(file, ".api.json");
    const gen = new ComfyUIGenerator({ ...config.comfyui, workflow: file });
    if (!(await gen.ready())) {
      results.push({ workflow: name, ok: false, error: "ComfyUI isn't answering" });
      continue;
    }
    let peak = 0;
    const sampler = setInterval(() => {
      void smi("memory.used").then((m) => {
        peak = Math.max(peak, Number(m?.[0] ?? 0));
      });
    }, 2_000);
    const started = Date.now();
    console.log(`${name}: generating a ${seconds}-second ${w}x${h} clip…`);
    try {
      await gen.generate({
        job: `bench-${name}`,
        prompt:
          "A glowing blue sphere of light drifts slowly down a dark stone corridor, soft reflections on wet walls, cinematic, slow camera push",
        negative: config.negative,
        seconds,
        fps,
        frames: frameCount(seconds, fps),
        width: w,
        height: h,
        seed: 1234,
        out: path.join(out, `${name}.mp4`),
      });
      results.push({
        workflow: name,
        ok: true,
        seconds: Math.round((Date.now() - started) / 1000),
        peakMb: peak,
      });
    } catch (err) {
      results.push({
        workflow: name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearInterval(sampler);
    }
  }
  fs.writeFileSync(
    path.join(out, "bench.json"),
    JSON.stringify(
      { at: new Date().toISOString(), clip: { w, h, seconds, fps }, results },
      null,
      2,
    ),
  );
  for (const r of results) {
    console.log(
      r.ok
        ? `  ${r.workflow.padEnd(28)} ${String(r.seconds).padStart(5)} s  (${((r.seconds ?? 0) / seconds).toFixed(0)} s per second of video, peak ${r.peakMb} MB)`
        : `  ${r.workflow.padEnd(28)} failed: ${r.error}`,
    );
  }
  const best = results.filter((r) => r.ok).sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0))[0];
  if (best) {
    console.log(
      `Fastest: ${best.workflow}. Set comfyui.workflow in config/gpu.yaml to config/gpu/${best.workflow}.api.json.`,
    );
  }
}

const [command = "status", arg] = process.argv.slice(2);
(command === "bench" ? bench(arg) : status()).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
