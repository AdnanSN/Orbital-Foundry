import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/server/src

export const REPO_ROOT = path.resolve(here, "../../..");
export const CONFIG_DIR = path.join(REPO_ROOT, "config");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
export const DB_PATH = path.join(DATA_DIR, "orbital.db");
