import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths";

let loaded = false;

/** Load the repo-root .env into process.env once. Variables already set in the shell win. */
export function loadEnv(file: string = path.join(REPO_ROOT, ".env")): void {
  if (loaded) return;
  loaded = true;
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/** Replace ${NAME} placeholders with environment values (missing ones become ""). */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(PLACEHOLDER, (_match, name: string) => env[name] ?? "");
}

/** Names of ${NAME} placeholders in `value` that are unset or empty. */
export function missingEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...value.matchAll(PLACEHOLDER)]
    .map((match) => match[1] ?? "")
    .filter((name) => !env[name]?.trim());
}
