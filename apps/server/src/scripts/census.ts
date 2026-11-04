/**
 * Model census: probe every candidate in config/tiers.yaml for chat, JSON, tool calling, vision
 * and embeddings, then write config/models.census.json. The router skips models that fail a
 * capability a request needs.
 *
 *   npm run census                          all providers that have keys
 *   npm run census -- --provider nvidia     one provider
 *   npm run census -- --tier vision         one tier
 *   npm run census -- --ref nvidia:openai/gpt-oss-20b
 *   npm run census -- --list-only           only check the providers' model lists
 *   npm run census -- --discover --provider nvidia
 *                                           one cheap chat ping to every chat-like model in the
 *                                           provider's catalog, to find candidates for tiers.yaml
 *   --timeout 60000                         per-request timeout in ms (default 60 s)
 */
import fs from "node:fs";
import path from "node:path";
import {
  type Capability,
  type CensusEntry,
  type CensusFile,
  LANES,
  type Lane,
  type ProbeResult,
  parseModelRef,
  TIERS,
} from "@orbital/shared";
import { loadCensus } from "../config";
import { classifyError, truncate } from "../llm/errors";
import { listModels } from "../llm/models";
import { PROBES } from "../llm/probes";
import { censusProblems } from "../llm/router";
import { CONFIG_DIR, REPO_ROOT } from "../paths";
import { createStation } from "../station";
import { formatTable, keyReport, mapLimit, parseArgs, stringFlag } from "./cli";

const CENSUS_FILE = path.join(CONFIG_DIR, "models.census.json");
const ORDER: Capability[] = ["chat", "json", "tools", "vision", "embed"];
/** Catalog entries that are clearly not chat models (embeddings, guards, parsers, rewards, …). */
const NOT_CHAT =
  /embed|guard|safety|reward|parse|clip|retriever|detector|calibration|translate|deplot|kosmos|rerank|bge|whisper|tts|flux|diffusion-xl|sdxl/i;

const args = parseArgs(process.argv.slice(2), ["list-only", "discover"]);
const onlyProvider = stringFlag(args, "provider");
const onlyTier = stringFlag(args, "tier");
const onlyRef = stringFlag(args, "ref");
const listOnly = args.flags.has("list-only");
const discover = args.flags.has("discover");
const timeoutMs = Number(stringFlag(args, "timeout") ?? 60_000);

const station = createStation({ requestTimeoutMs: timeoutMs });
const { providers, tiers } = station.config;
const mode = listOnly ? " (model lists only)" : discover ? " (discovery)" : "";
console.log(`Model census${mode}\n\n${keyReport(providers)}\n`);

if (discover) {
  await runDiscovery();
} else {
  await runCensus();
}
station.close();

async function runCensus(): Promise<void> {
  // Capabilities to probe per ref: the union over every tier that lists it.
  const wanted = new Map<string, Set<Capability>>();
  for (const tier of TIERS) {
    if (onlyTier && onlyTier !== tier) continue;
    const config = tiers.tiers[tier];
    const caps: Capability[] = config.requires.includes("embed")
      ? ["embed"]
      : config.requires.includes("vision")
        ? ["chat", "vision"]
        : ["chat", "json", "tools"];
    for (const lane of LANES) {
      for (const ref of config[lane]) {
        if (onlyRef && onlyRef !== ref) continue;
        if (onlyProvider && parseModelRef(ref).provider !== onlyProvider) continue;
        const set = wanted.get(ref) ?? new Set<Capability>();
        for (const cap of caps) set.add(cap);
        wanted.set(ref, set);
      }
    }
  }
  if (wanted.size === 0) {
    console.log("Nothing matches those filters.");
    return;
  }

  const byProvider = new Map<string, string[]>();
  for (const ref of wanted.keys()) {
    const { provider } = parseModelRef(ref);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), ref]);
  }

  const entries: Record<string, CensusEntry> = { ...(loadCensus()?.entries ?? {}) };
  if (!onlyProvider && !onlyTier && !onlyRef) {
    // A full run also forgets models that are no longer listed in any tier.
    for (const ref of Object.keys(entries)) if (!wanted.has(ref)) delete entries[ref];
  }
  let probedAny = false;

  // Providers run in parallel; within a provider, models run up to its concurrency limit.
  await Promise.all(
    [...byProvider].map(async ([id, refs]) => {
      if (await censusProvider(id, refs, wanted, entries)) probedAny = true;
    }),
  );

  const file: CensusFile = {
    generatedAt: new Date().toISOString(),
    entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(CENSUS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  printResults(file, [...wanted.keys()].sort(), probedAny);
}

/** Probe one provider's refs. Returns whether any probe ran. */
async function censusProvider(
  id: string,
  refs: string[],
  wanted: Map<string, Set<Capability>>,
  entries: Record<string, CensusEntry>,
): Promise<boolean> {
  const provider = providers[id];
  if (!provider) return false;
  let listed: Set<string> | undefined;
  if (provider.apiKey || provider.publicModelList) {
    try {
      listed = new Set(await listModels(provider));
      log(id, `model list has ${listed.size} models`);
    } catch (err) {
      log(id, `could not read the model list (${truncate(classifyError(err).message, 120)})`);
    }
  }
  const missing = [provider.apiKey ? undefined : provider.apiKeyEnv, ...provider.missingEnv].filter(
    (name): name is string => Boolean(name),
  );
  const canProbe = !listOnly && missing.length === 0;
  if (!listOnly && !canProbe) log(id, `not probing: ${missing.join(", ")} not set`);

  let keyRejected = false;
  let probed = false;
  await mapLimit(refs, provider.limits.concurrency, async (ref) => {
    const { model } = parseModelRef(ref);
    const previous = entries[ref];
    const entry: CensusEntry = {
      ref,
      testedAt: previous?.testedAt ?? new Date().toISOString(),
      listed: listed ? listed.has(model) : previous?.listed,
      probes: { ...(previous?.probes ?? {}) },
    };
    if (canProbe && !keyRejected) {
      probed = true;
      entry.testedAt = new Date().toISOString();
      entry.probes = {};
      const caps = ORDER.filter((cap) => wanted.get(ref)?.has(cap));
      for (const [i, cap] of caps.entries()) {
        const result = await runProbe(id, model, cap);
        entry.probes[cap] = result;
        // A missing model, a bad key, or a model that never answers fails every probe the same
        // way; don't spend more calls (or minutes) on it.
        const fatal = /^(not-found|forbidden|auth|timeout):/.exec(result.note ?? "");
        if (fatal && (fatal[1] !== "timeout" || i === 0)) {
          for (const rest of caps.slice(i + 1)) {
            entry.probes[rest] = { ok: false, note: `skipped after ${fatal[1]}` };
          }
          if (fatal[1] === "auth") keyRejected = true;
          break;
        }
      }
      const summary = caps.map((cap) => `${cap} ${entry.probes[cap]?.ok ? "ok" : "FAIL"}`);
      log(id, `${model}: ${summary.join(" · ")}`);
    } else if (listed) {
      log(id, `${model}: ${entry.listed ? "listed" : "NOT LISTED"}`);
    }
    entries[ref] = entry;
  });
  if (keyRejected) log(id, `the API key was rejected; check ${provider.apiKeyEnv} in .env`);
  return probed;
}

/** One chat ping per chat-like catalog model, to find what this account can really use. */
async function runDiscovery(): Promise<void> {
  const provider = onlyProvider ? providers[onlyProvider] : undefined;
  if (!provider) {
    console.log("--discover needs a known --provider, e.g. --discover --provider nvidia");
    process.exitCode = 1;
    return;
  }
  if (!provider.apiKey || provider.missingEnv.length > 0) {
    console.log(`${provider.id} is not ready: set its key and URL variables in .env first.`);
    process.exitCode = 1;
    return;
  }
  const models = (await listModels(provider)).filter((id) => !NOT_CHAT.test(id));
  console.log(
    `[${provider.id}] pinging ${models.length} chat-like models, ${timeoutMs / 1000}s timeout each\n`,
  );
  const results = await mapLimit(models, provider.limits.concurrency, async (model) => {
    const result = await runProbe(provider.id, model, "chat");
    log(provider.id, `${model}: ${result.ok ? `ok (${result.ms} ms)` : `FAIL (${result.note})`}`);
    return { model, result };
  });
  results.sort(
    (a, b) =>
      Number(b.result.ok) - Number(a.result.ok) ||
      (a.result.ms ?? Number.POSITIVE_INFINITY) - (b.result.ms ?? Number.POSITIVE_INFINITY),
  );
  const rows = results.map(({ model, result }) => [
    model,
    result.ok ? "ok" : "FAIL",
    result.ms === undefined ? "" : `${result.ms} ms`,
    result.ok ? "" : truncate(result.note ?? "", 90),
  ]);
  console.log(`\n${formatTable(["model", "chat", "time", "note"], rows)}`);
  const working = results.filter((r) => r.result.ok).length;
  console.log(
    `\n${working} of ${models.length} answered. Add good ones to config/tiers.yaml, then run \`npm run census\`.`,
  );
}

async function runProbe(providerId: string, model: string, cap: Capability): Promise<ProbeResult> {
  const gate = station.gates.get(providerId);
  if (!gate) return { ok: false, note: "no rate gate for this provider" };
  const kind = cap === "embed" ? "embed" : "chat";
  for (let attempt = 0; attempt < 2; attempt++) {
    let release: () => void;
    try {
      release = await gate.acquire();
    } catch (err) {
      return { ok: false, note: `quota: ${classifyError(err).message}` };
    }
    const started = performance.now();
    try {
      const result = await PROBES[cap](station.transport, providerId, model);
      const ms = Math.round(performance.now() - started);
      station.usage.record({
        lane: "sandbox",
        provider: providerId,
        model,
        kind,
        outcome: result.ok ? "ok" : "invalid-output",
        latencyMs: ms,
        purpose: `census:${cap}`,
      });
      return { ...result, ms };
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      const info = classifyError(err);
      station.usage.record({
        lane: "sandbox",
        provider: providerId,
        model,
        kind,
        outcome: info.kind,
        latencyMs: ms,
        purpose: `census:${cap}`,
        error: info.message,
      });
      if (info.kind === "rate-limited" && attempt === 0) {
        gate.cooldown(info.retryAfterMs ?? 20_000);
        continue;
      }
      return { ok: false, ms, note: `${info.kind}: ${truncate(info.message, 160)}` };
    } finally {
      release();
    }
  }
  return { ok: false, note: "rate-limited twice in a row" };
}

function printResults(census: CensusFile, refs: string[], probedAny: boolean): void {
  const rows = refs.map((ref) => {
    const entry = census.entries[ref];
    const cells = ORDER.map((cap) => {
      const probe = entry?.probes[cap];
      if (!probe) return "-";
      return probe.ok ? "ok" : "FAIL";
    });
    const times = ORDER.map((cap) => entry?.probes[cap]?.ms).filter(
      (ms): ms is number => typeof ms === "number",
    );
    const avg =
      times.length > 0 ? `${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms` : "";
    const listed = entry?.listed === undefined ? "?" : entry.listed ? "yes" : "NO";
    return [ref, listed, ...cells, avg];
  });
  console.log(`\n${formatTable(["model", "listed", ...ORDER, "avg"], rows)}`);

  const failures = refs.flatMap((ref) =>
    ORDER.flatMap((cap) => {
      const probe = census.entries[ref]?.probes[cap];
      return probe && !probe.ok && probe.note ? [`  ${ref} ${cap}: ${probe.note}`] : [];
    }),
  );
  if (failures.length > 0) console.log(`\nFailures:\n${failures.join("\n")}`);

  console.log("\nFirst choice per tier (what the router will try first):");
  for (const tier of TIERS) {
    for (const lane of LANES) {
      const pick = tiers.tiers[tier][lane].find((ref) => usable(census, ref, lane, tier));
      console.log(`  ${tier.padEnd(10)} ${lane.padEnd(8)} ${pick ?? "(nothing usable yet)"}`);
    }
  }
  if (!probedAny && !listOnly) {
    console.log(
      "\nNo probes ran. Add keys to .env (see .env.example), then run `npm run census` again.",
    );
  }
  console.log(`\nSaved ${path.relative(REPO_ROOT, CENSUS_FILE)}`);
}

function usable(
  census: CensusFile,
  ref: string,
  lane: Lane,
  tier: (typeof TIERS)[number],
): boolean {
  const provider = providers[parseModelRef(ref).provider];
  if (!provider?.lanes.includes(lane) || !provider.apiKey || provider.missingEnv.length > 0) {
    return false;
  }
  return censusProblems(census, ref, tiers.tiers[tier].requires).length === 0;
}

function log(provider: string, message: string): void {
  console.log(`[${provider}] ${message}`);
}
