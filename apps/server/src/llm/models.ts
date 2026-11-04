import type { ResolvedProvider } from "../config";
import { ProviderHttpError, parseRetryAfter, truncate } from "./errors";

/** Model IDs from GET {baseURL}/models. Works without a key for providers with public lists. */
export async function listModels(
  provider: ResolvedProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const res = await fetchImpl(`${provider.resolvedBaseURL}/models`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderHttpError(
      provider.id,
      res.status,
      `GET /models returned HTTP ${res.status}: ${truncate(body, 200)}`,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  const json = (await res.json()) as { data?: { id?: unknown }[] };
  return (json.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}
