import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { normalizeLoudness, probeMedia, runTool } from "./ffmpeg";

/**
 * Renders a HyperFrames project to MP4 on this laptop (D-052): headless Chrome captures each
 * frame, FFmpeg encodes (NVENC when asked), and the audio is then brought to -14 LUFS for the
 * platforms. Progress comes from the CLI's `@hf-progress` lines. Telemetry is always off.
 */

const require = createRequire(import.meta.url);

export interface RenderOptions {
  fps?: number;
  quality?: "draft" | "looks" | "delivery";
  workers?: number;
  /** Hardware video encoding (NVENC); retried without it if it fails. */
  gpu?: boolean;
  /** Integrated loudness target for the final file (null keeps the mix as it is). */
  loudness?: number | null;
  onProgress?: (pct: number, stage: string) => void;
  timeoutMs?: number;
}

export interface RenderResult {
  file: string;
  seconds: number;
  duration: number;
  width?: number;
  height?: number;
}

export function hyperframesBin(): string {
  return path.join(
    path.dirname(require.resolve("hyperframes/package.json")),
    "bin",
    "hyperframes.mjs",
  );
}

/** Reads one `@hf-progress {...}` line from the CLI. */
export function parseProgress(line: string): { pct: number; code: string } | null {
  const at = line.indexOf("@hf-progress ");
  if (at < 0) return null;
  try {
    const json = JSON.parse(line.slice(at + 13)) as { pct?: number; code?: string };
    return typeof json.pct === "number" ? { pct: json.pct, code: json.code ?? "" } : null;
  } catch {
    return null;
  }
}

export async function renderProject(
  dir: string,
  out: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const started = Date.now();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const raw = opts.loudness === null ? out : `${out}.raw.mp4`;
  const args = (gpu: boolean) => [
    hyperframesBin(),
    "render",
    dir,
    "-o",
    raw,
    "--quality",
    opts.quality ?? "looks",
    "--workers",
    String(opts.workers ?? 3),
    ...(opts.fps ? ["--fps", String(opts.fps)] : []),
    ...(gpu ? ["--gpu"] : []),
  ];
  const onLine = (line: string) => {
    const p = parseProgress(line);
    if (p) opts.onProgress?.(p.pct, p.code);
  };
  const run = (gpu: boolean) =>
    runTool(process.execPath, args(gpu), {
      cwd: dir,
      onLine,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  try {
    await run(Boolean(opts.gpu));
  } catch (err) {
    if (!opts.gpu) throw err;
    await run(false);
  }
  if (!fs.existsSync(raw)) throw new Error("HyperFrames finished without writing the video.");
  if (raw !== out) {
    await normalizeLoudness(raw, out, opts.loudness ?? -14);
    fs.rmSync(raw, { force: true });
  }
  const info = await probeMedia(out);
  return {
    file: out,
    seconds: (Date.now() - started) / 1000,
    duration: info.duration,
    ...(info.width ? { width: info.width } : {}),
    ...(info.height ? { height: info.height } : {}),
  };
}

/** Lints a project with HyperFrames' own checks; returns the error messages. */
export async function lintProject(dir: string): Promise<string[]> {
  try {
    const { stdout } = await runTool(process.execPath, [hyperframesBin(), "lint", dir, "--json"], {
      cwd: dir,
    });
    const json = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("[")))) as {
      severity?: string;
      message?: string;
    }[];
    return json.filter((f) => f.severity === "error").map((f) => f.message ?? "lint error");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes("exited with 1") ? [message] : [];
  }
}
