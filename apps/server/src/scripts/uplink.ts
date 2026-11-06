import { loadEnv } from "../env";

/**
 * The Uplink from a terminal (Stage 17), talking to the running station:
 *   npm run uplink -- status              accounts, mode, kill switch and recent posts
 *   npm run uplink -- connect youtube     prints the sign-in link (also instagram, tiktok)
 *   npm run auth:youtube                  the same as "connect youtube"
 * The sign-in itself happens in your browser; the station stores the tokens in data/secrets.
 */

loadEnv();
const port = Number(process.env.ORBITAL_PORT ?? 8787);
const base = `http://127.0.0.1:${port}/api`;
const token = process.env.ORBITAL_TOKEN;
const headers: Record<string, string> = {
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`The station isn't running on ${base}. Start it with npm run dev.`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? data.message ?? `HTTP ${res.status}`));
  return data;
}

async function main(): Promise<void> {
  const [command = "status", platform = ""] = process.argv.slice(2);
  if (command === "connect") {
    if (!["youtube", "instagram", "tiktok"].includes(platform)) {
      throw new Error("Say which platform: npm run uplink -- connect youtube|instagram|tiktok");
    }
    const { url } = await call(`/uplink/${platform}/connect`, {
      returnTo: "http://localhost:5173/",
    });
    console.log(`Open this link in your browser and allow the station:\n\n${String(url)}\n`);
    console.log("You'll come back to the station when it's done (npm run dev must be running).");
    return;
  }
  if (command !== "status") throw new Error(`Unknown command "${command}".`);
  const s = (await call("/uplink")) as {
    publisher: {
      mode: string;
      killed: boolean;
      platforms: { platform: string; connected: boolean; today: number; dailyCap: number }[];
      posts: { id: string; platform: string; status: string; at: string; title: string }[];
    } | null;
  };
  const pub = s.publisher;
  if (!pub) {
    console.log("The station has no publisher.");
    return;
  }
  console.log(`Posting: ${pub.mode}${pub.killed ? " (kill switch ON)" : ""}`);
  for (const p of pub.platforms) {
    console.log(
      `  ${p.platform.padEnd(10)} ${p.connected ? "connected" : "not connected"}, ${p.today}/${p.dailyCap} today`,
    );
  }
  for (const p of pub.posts.slice(0, 15)) {
    console.log(
      `  ${p.id} ${p.platform.padEnd(10)} ${p.status.padEnd(10)} ${new Date(p.at).toLocaleString()}  ${p.title}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
