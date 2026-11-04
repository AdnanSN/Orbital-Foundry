/**
 * List a provider's model IDs, optionally filtered.
 *
 *   npm run models -- nvidia
 *   npm run models -- nvidia nemotron
 */
import { loadStationConfig } from "../config";
import { loadEnv } from "../env";
import { classifyError } from "../llm/errors";
import { listModels } from "../llm/models";
import { parseArgs } from "./cli";

loadEnv();
const { providers } = loadStationConfig();
const [providerId, filter] = parseArgs(process.argv.slice(2)).positionals;
const provider = providerId ? providers[providerId] : undefined;

if (!provider) {
  console.log(
    `Usage: npm run models -- <provider> [filter]\nProviders: ${Object.keys(providers).join(", ")}`,
  );
  process.exit(providerId ? 1 : 0);
}

try {
  const ids = await listModels(provider);
  const needle = filter?.toLowerCase();
  const shown = needle ? ids.filter((id) => id.toLowerCase().includes(needle)) : ids;
  console.log(shown.join("\n"));
  console.log(`\n${shown.length} of ${ids.length} models on ${provider.id}`);
} catch (err) {
  console.error(`Could not list models on ${provider.id}: ${classifyError(err).message}`);
  if (!provider.apiKey) {
    console.error(`${provider.apiKeyEnv} is not set; this provider may need a key to list models.`);
  }
  process.exitCode = 1;
}
