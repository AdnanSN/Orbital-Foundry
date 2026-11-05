import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Optional external tools: Real-ESRGAN (GPU upscaling) and rembg (ML background removal). Both
 * need downloads the owner has to OK first (ROADMAP Stage 5), so they stay off until a path or
 * command is set in config/creative.yaml. Inputs and outputs go through a private temp folder.
 */

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: false });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2_000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(cmd)} timed out after ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-creative-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** realesrgan-ncnn-vulkan -i in.png -o out.png -s 4 -n <model>. Returns the PNG bytes. */
export function realEsrgan(
  exe: string,
  png: Buffer,
  scale: 2 | 3 | 4,
  model: string,
): Promise<Buffer> {
  return withTemp(async (dir) => {
    const input = path.join(dir, "in.png");
    const output = path.join(dir, "out.png");
    fs.writeFileSync(input, png);
    await run(exe, ["-i", input, "-o", output, "-s", String(scale), "-n", model], 300_000);
    return fs.readFileSync(output);
  });
}

/** `<command> i in.png out.png`, for example "uvx rembg". Returns the PNG bytes. */
export function rembg(command: string, png: Buffer): Promise<Buffer> {
  const [cmd, ...pre] = command.trim().split(/\s+/);
  if (!cmd) return Promise.reject(new Error("No rembg command configured"));
  return withTemp(async (dir) => {
    const input = path.join(dir, "in.png");
    const output = path.join(dir, "out.png");
    fs.writeFileSync(input, png);
    await run(cmd, [...pre, "i", input, output], 300_000);
    return fs.readFileSync(output);
  });
}
