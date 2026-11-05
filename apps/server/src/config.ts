import fs from "node:fs";
import path from "node:path";
import {
  type CensusFile,
  censusFileSchema,
  LANES,
  type ProviderConfig,
  type ProvidersFile,
  parseModelRef,
  providersFileSchema,
  TIERS,
  type TiersFile,
  tiersFileSchema,
} from "@orbital/shared";
import YAML from "yaml";
import { z } from "zod";
import { interpolateEnv, missingEnvVars } from "./env";
import { CONFIG_DIR } from "./paths";

export interface ResolvedProvider extends ProviderConfig {
  id: string;
  /** baseURL with ${ENV} placeholders filled in. */
  resolvedBaseURL: string;
  /** API key from the environment; undefined when missing or empty. */
  apiKey: string | undefined;
  /** ${ENV} placeholders in baseURL that are not set. */
  missingEnv: string[];
}
export type ResolvedProviders = Record<string, ResolvedProvider>;

export interface StationConfig {
  providers: ResolvedProviders;
  images: ProvidersFile["images"];
  tiers: TiersFile;
  census: CensusFile | null;
}

function parseFile<T>(file: string, schema: z.ZodType<T>, parse: (text: string) => unknown): T {
  const result = schema.safeParse(parse(fs.readFileSync(file, "utf8")));
  if (!result.success) {
    throw new Error(`${path.basename(file)} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadProvidersFile(dir: string = CONFIG_DIR): ProvidersFile {
  return parseFile(path.join(dir, "providers.yaml"), providersFileSchema, (text) =>
    YAML.parse(text),
  );
}

export function loadTiersFile(dir: string = CONFIG_DIR): TiersFile {
  return parseFile(path.join(dir, "tiers.yaml"), tiersFileSchema, (text) => YAML.parse(text));
}

export function loadCensus(dir: string = CONFIG_DIR): CensusFile | null {
  const file = path.join(dir, "models.census.json");
  if (!fs.existsSync(file)) return null;
  return parseFile(file, censusFileSchema, (text) => JSON.parse(text));
}

export function resolveProviders(
  file: ProvidersFile,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviders {
  const resolved: ResolvedProviders = {};
  for (const [id, provider] of Object.entries(file.providers)) {
    const key = env[provider.apiKeyEnv]?.trim();
    resolved[id] = {
      ...provider,
      id,
      resolvedBaseURL: interpolateEnv(provider.baseURL, env).replace(/\/+$/, ""),
      apiKey: key ? key : undefined,
      missingEnv: missingEnvVars(provider.baseURL, env),
    };
  }
  return resolved;
}

/** Problems that make the config unusable: unknown providers and lane violations. */
export function validateConfig(providers: ProvidersFile, tiers: TiersFile): string[] {
  const problems: string[] = [];
  for (const tier of TIERS) {
    const config = tiers.tiers[tier];
    for (const lane of LANES) {
      for (const ref of config[lane]) {
        const { provider } = parseModelRef(ref);
        const p = providers.providers[provider];
        if (!p) {
          problems.push(`tiers.${tier}.${lane}: unknown provider "${provider}" in "${ref}"`);
        } else if (!p.lanes.includes(lane)) {
          problems.push(
            `tiers.${tier}.${lane}: provider "${provider}" is not allowed in the ${lane} lane ("${ref}")`,
          );
        }
      }
    }
  }
  for (const [id, p] of Object.entries(providers.providers)) {
    if (p.lanes.includes("live") && p.production !== "allowed") {
      problems.push(
        `providers.${id}: the live lane needs production: allowed (terms checked and recorded); it is "${p.production}"`,
      );
    }
  }
  for (const [id, endpoint] of Object.entries(providers.images)) {
    const p = providers.providers[endpoint.provider];
    if (!p) {
      problems.push(`images.${id}: unknown provider "${endpoint.provider}"`);
      continue;
    }
    for (const lane of endpoint.lanes) {
      if (!p.lanes.includes(lane)) {
        problems.push(
          `images.${id}: provider "${endpoint.provider}" is not allowed in the ${lane} lane`,
        );
      }
    }
  }
  return problems;
}

export function loadStationConfig(
  dir: string = CONFIG_DIR,
  env: NodeJS.ProcessEnv = process.env,
): StationConfig {
  const providersFile = loadProvidersFile(dir);
  const tiers = loadTiersFile(dir);
  const problems = validateConfig(providersFile, tiers);
  if (problems.length > 0) {
    throw new Error(`Config problems:\n- ${problems.join("\n- ")}`);
  }
  return {
    providers: resolveProviders(providersFile, env),
    images: providersFile.images,
    tiers,
    census: loadCensus(dir),
  };
}
