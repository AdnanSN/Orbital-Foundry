import { z } from "zod";

export class JsonExtractError extends Error {
  override name = "JsonExtractError";
}

/**
 * Pull the first parseable JSON object or array out of a model reply.
 * Handles ```json fences, leading prose and brackets inside strings.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  const sources = fenced?.[1] ? [fenced[1], text] : [text];
  let lastError = "no JSON object or array found in the reply";
  for (const source of sources) {
    for (let start = nextBracket(source, 0); start !== -1; start = nextBracket(source, start + 1)) {
      const end = matchingBracket(source, start);
      if (end === -1) {
        lastError = "the JSON in the reply is incomplete (unbalanced brackets)";
        continue;
      }
      try {
        return JSON.parse(source.slice(start, end + 1));
      } catch (err) {
        lastError = `the reply is not valid JSON: ${(err as Error).message}`;
      }
    }
  }
  throw new JsonExtractError(lastError);
}

function nextBracket(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") return i;
  }
  return -1;
}

function matchingBracket(text: string, start: number): number {
  const expected: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") expected.push("}");
    else if (ch === "[") expected.push("]");
    else if (ch === "}" || ch === "]") {
      if (expected.pop() !== ch) return -1;
      if (expected.length === 0) return i;
    }
  }
  return -1;
}

/** System-prompt instruction asking for JSON that matches `schema`. */
export function jsonInstruction(schema: z.ZodType): string {
  let described = "";
  try {
    const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    described = JSON.stringify(jsonSchema);
  } catch {
    // Schemas with transforms can't be expressed as JSON Schema; validation still applies.
  }
  return [
    "Respond with ONLY a JSON value. No prose before or after it, and no markdown fences.",
    described ? `It must match this JSON Schema:\n${described}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type ParseOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/** Extract JSON from a reply and validate it against `schema`. */
export function parseStructured<T>(text: string, schema: z.ZodType<T>): ParseOutcome<T> {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}
