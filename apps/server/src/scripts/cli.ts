import type { ResolvedProviders } from "../config";

export interface ParsedArgs {
  flags: Map<string, string | true>;
  positionals: string[];
}

/** Minimal flag parser: `--key value`, `--key=value`, and the boolean flags named in `booleans`. */
export function parseArgs(argv: string[], booleans: readonly string[] = []): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!booleans.includes(body) && next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { flags, positionals };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** One row per provider: whether its key and URL variables are set, and its lanes. */
export function keyReport(providers: ResolvedProviders): string {
  const rows = Object.values(providers).map((p) => {
    const missing = [p.apiKey ? undefined : p.apiKeyEnv, ...p.missingEnv].filter(
      (name): name is string => Boolean(name),
    );
    return [
      p.id,
      missing.length > 0 ? `missing ${missing.join(", ")}` : "ready",
      p.lanes.join(" + "),
    ];
  });
  return formatTable(["provider", "status", "lanes"], rows);
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
