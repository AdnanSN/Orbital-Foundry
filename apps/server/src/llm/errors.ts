import type { Lane } from "@orbital/shared";

export type FailureKind =
  | "rate-limited"
  | "busy"
  | "quota"
  | "auth"
  | "forbidden"
  | "not-found"
  | "bad-request"
  | "server"
  | "timeout"
  | "network"
  | "invalid-output"
  | "truncated"
  | "circuit-open"
  | "unknown";

export interface Attempt {
  ref: string;
  outcome: "ok" | FailureKind;
  message?: string;
  ms?: number;
}

export interface FailureInfo {
  kind: FailureKind;
  message: string;
  retryAfterMs?: number;
}

/** An HTTP-level failure from a provider. `status` is 0 for timeouts and connection errors. */
export class ProviderHttpError extends Error {
  override name = "ProviderHttpError";

  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
    readonly hint?: FailureKind,
  ) {
    super(redact(message));
  }
}

/**
 * Strip account identifiers and anything key-shaped from provider error text before it is logged
 * or written to committed files. NVIDIA's 404s, for example, include the caller's account id.
 */
export function redact(text: string): string {
  return text
    .replace(/(account\s+(?:id\s+)?')[^']+(')/gi, "$1[redacted]$2")
    .replace(/(accounts\/)[0-9a-f]{32}/gi, "$1[redacted]")
    .replace(/nvapi-[\w-]+/g, "nvapi-[redacted]")
    .replace(/\bgsk_[\w-]+/g, "gsk_[redacted]")
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]");
}

export class QuotaExhaustedError extends Error {
  override name = "QuotaExhaustedError";

  constructor(readonly provider: string) {
    super(`Today's request budget for "${provider}" is used up`);
  }
}

/** No model in the tier is usable in this lane (missing keys, lane rules, census failures). */
export class NoCandidateError extends Error {
  override name = "NoCandidateError";

  constructor(
    readonly what: string,
    readonly lane: Lane,
    readonly reasons: string[],
  ) {
    super(
      `No usable model for ${what} in the ${lane} lane.${
        reasons.length > 0
          ? `\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`
          : " No candidates are configured."
      }`,
    );
  }
}

/** Every candidate was tried and failed. */
export class RouterError extends Error {
  override name = "RouterError";

  constructor(
    readonly what: string,
    readonly lane: Lane,
    readonly attempts: Attempt[],
  ) {
    super(
      `Every candidate failed for ${what} in the ${lane} lane:\n${attempts
        .map((a) => `  - ${a.ref}: ${a.outcome}${a.message ? ` (${a.message})` : ""}`)
        .join("\n")}`,
    );
  }
}

export function classifyError(err: unknown): FailureInfo {
  if (err instanceof QuotaExhaustedError) return { kind: "quota", message: err.message };
  if (err instanceof ProviderHttpError) {
    const { status } = err;
    let kind: FailureKind = err.hint ?? "unknown";
    if (status === 429) kind = "rate-limited";
    else if (status === 401) kind = "auth";
    else if (status === 403) kind = "forbidden";
    else if (status === 404) kind = "not-found";
    else if (status === 408) kind = "timeout";
    else if (status >= 500) kind = "server";
    else if (status >= 400) kind = "bad-request";
    return { kind, message: err.message, retryAfterMs: err.retryAfterMs };
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { kind: "timeout", message: err.message };
    }
    if (
      /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up/i.test(
        err.message,
      )
    ) {
      return { kind: "network", message: err.message };
    }
    return { kind: "unknown", message: redact(err.message) };
  }
  return { kind: "unknown", message: String(err) };
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Collapse whitespace and cut long provider messages down to size for logs. */
export function truncate(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
