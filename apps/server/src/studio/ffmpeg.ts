import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * FFmpeg and FFprobe from npm (ffmpeg-static 6.1 and ffprobe-static), so the studio needs no
 * system install. HyperFrames finds both on PATH, which `toolEnv` sets up for child processes.
 */

const require = createRequire(import.meta.url);

function resolveFfmpeg(): string {
  try {
    const p = require("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {
    // fall through to PATH
  }
  return "ffmpeg";
}

function resolveFfprobe(): string {
  try {
    const p = (require("ffprobe-static") as { path?: string }).path;
    if (p && fs.existsSync(p)) return p;
  } catch {
    // fall through to PATH
  }
  return "ffprobe";
}

export const FFMPEG = resolveFfmpeg();
export const FFPROBE = resolveFfprobe();

/** Environment for media child processes: both tools on PATH, HyperFrames' telemetry off. */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dirs = [FFMPEG, FFPROBE].filter((p) => path.isAbsolute(p)).map((p) => path.dirname(p));
  const key = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...base,
    [key]: [...dirs, base[key] ?? ""].join(path.delimiter),
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    HYPERFRAMES_NO_OPTIONAL_INSTALL: "1",
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Runs a tool to completion; rejects with the end of stderr when it fails. */
export function runTool(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: toolEnv(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const feed = (chunk: string) => {
      if (!opts.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) opts.onLine(line);
    };
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout = (stdout + s).slice(-200_000);
      feed(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-200_000);
      feed(s);
    });
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
            reject(new Error(`${path.basename(cmd)} timed out after ${opts.timeoutMs} ms`));
          }, opts.timeoutMs);
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split(/\r?\n/).slice(-6).join(" | ");
        reject(new Error(`${path.basename(cmd)} exited with ${code}: ${tail.slice(0, 800)}`));
      }
    });
  });
}

/** Duration of a media file in seconds. */
export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await runTool(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds))
    throw new Error(`Couldn't read the duration of ${path.basename(file)}`);
  return seconds;
}

export interface MediaInfo {
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await runTool(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,width,height",
    "-of",
    "json",
    file,
  ]);
  const json = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  return {
    duration: Number.parseFloat(json.format?.duration ?? "0") || 0,
    ...(video?.width ? { width: video.width } : {}),
    ...(video?.height ? { height: video.height } : {}),
    hasAudio: Boolean(json.streams?.some((s) => s.codec_type === "audio")),
    hasVideo: Boolean(video),
  };
}

/** Writes 16-bit mono PCM WAV. */
export function writeWav(file: string, samples: Float32Array, rate: number): void {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/** Joins audio files end to end (re-encoded, so formats may differ). */
export async function concatAudio(files: string[], out: string): Promise<void> {
  if (files.length === 1 && path.extname(files[0] ?? "") === path.extname(out)) {
    fs.copyFileSync(files[0] ?? "", out);
    return;
  }
  const inputs = files.flatMap((f) => ["-i", f]);
  const labels = files.map((_f, i) => `[${i}:a]`).join("");
  await runTool(FFMPEG, [
    "-y",
    "-hide_banner",
    ...inputs,
    "-filter_complex",
    `${labels}concat=n=${files.length}:v=0:a=1[a]`,
    "-map",
    "[a]",
    ...(out.endsWith(".mp3") ? ["-c:a", "libmp3lame", "-b:a", "192k"] : []),
    out,
  ]);
}

/**
 * Loudness to a platform target (integrated LUFS, EBU R128): -14 for YouTube, TikTok and Reels.
 * The video stream is copied untouched.
 */
export async function normalizeLoudness(input: string, out: string, target = -14): Promise<void> {
  await runTool(FFMPEG, [
    "-y",
    "-hide_banner",
    "-i",
    input,
    "-c:v",
    "copy",
    "-af",
    `loudnorm=I=${target}:TP=-1.5:LRA=11`,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    out,
  ]);
}

/** Integrated loudness (LUFS) and true peak of a file's audio, for screening. */
export async function measureLoudness(file: string): Promise<{ lufs: number; truePeak: number }> {
  const { stderr } = await runTool(FFMPEG, [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-af",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const lufs = Number.parseFloat(/I:\s*(-?[\d.]+)\s*LUFS/.exec(summary)?.[1] ?? "NaN");
  const truePeak = Number.parseFloat(/Peak:\s*(-?[\d.]+)\s*dBFS/.exec(summary)?.[1] ?? "NaN");
  return { lufs, truePeak };
}

/** Grabs one frame as a PNG (for thumbnails and vision QA). */
export async function frameAt(
  file: string,
  seconds: number,
  out: string,
  width?: number,
): Promise<void> {
  await runTool(FFMPEG, [
    "-y",
    "-hide_banner",
    "-ss",
    seconds.toFixed(2),
    "-i",
    file,
    "-frames:v",
    "1",
    ...(width ? ["-vf", `scale=${width}:-2`] : []),
    out,
  ]);
}
