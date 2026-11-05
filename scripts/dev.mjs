// Runs the station server and the client together: `npm run dev`.
import { spawn } from "node:child_process";

const procs = [
  { name: "server", color: "\x1b[36m", args: ["run", "server"] },
  { name: "client", color: "\x1b[35m", args: ["run", "client"] },
].map(({ name, color, args }) => {
  const child = spawn("npm", args, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code ?? "signal"})`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (!p.killed) p.kill("SIGINT");
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
