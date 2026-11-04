import type { Capability, ProbeResult } from "@orbital/shared";
import { z } from "zod";
import { solidPng } from "../images/png";
import { truncate } from "./errors";
import { jsonInstruction, parseStructured } from "./json";
import type { ChatResult, ToolSpec, Transport } from "./transport";

/** Room for reasoning models that think before they answer. */
const PROBE_MAX_TOKENS = 1500;

export const ADD_NUMBERS_TOOL: ToolSpec = {
  name: "add_numbers",
  description: "Add two integers and return their sum.",
  parameters: {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
    additionalProperties: false,
  },
};

/** A 96×96 red square as a data URL, for vision checks. */
export function redSquareDataUrl(): string {
  return `data:image/png;base64,${solidPng(96, 96, [220, 30, 30]).toString("base64")}`;
}

export function snippet(text: string, max = 80): string {
  return truncate(text || "(empty reply)", max);
}

const stationSchema = z.object({
  name: z.string().min(1),
  tags: z.array(z.string().min(1)).length(3),
});

export type Probe = (
  transport: Transport,
  provider: string,
  model: string,
) => Promise<Omit<ProbeResult, "ms">>;

function describeMiss(result: ChatResult): string {
  if (!result.content && result.finishReason === "length") {
    return "empty reply (ran out of tokens while thinking)";
  }
  return `replied: ${snippet(result.content)}`;
}

/** One small, cheap request per capability. Used by `npm run census`. */
export const PROBES: Record<Capability, Probe> = {
  async chat(transport, provider, model) {
    const r = await transport.chat(provider, {
      model,
      messages: [{ role: "user", content: "Reply with exactly one word: OK" }],
      temperature: 0,
      maxTokens: PROBE_MAX_TOKENS,
    });
    return /\bok\b/i.test(r.content) ? { ok: true } : { ok: false, note: describeMiss(r) };
  },

  async json(transport, provider, model) {
    const r = await transport.chat(provider, {
      model,
      messages: [
        { role: "system", content: jsonInstruction(stationSchema) },
        {
          role: "user",
          content:
            "Invent a name for a space station and give exactly 3 short tags that describe it.",
        },
      ],
      temperature: 0.2,
      maxTokens: PROBE_MAX_TOKENS,
    });
    const parsed = parseStructured(r.content, stationSchema);
    return parsed.ok ? { ok: true } : { ok: false, note: truncate(parsed.error, 160) };
  },

  async tools(transport, provider, model) {
    const r = await transport.chat(provider, {
      model,
      messages: [{ role: "user", content: "Use the add_numbers tool to add 17 and 25." }],
      tools: [ADD_NUMBERS_TOOL],
      temperature: 0,
      maxTokens: PROBE_MAX_TOKENS,
    });
    const call = r.toolCalls[0];
    if (!call) return { ok: false, note: `no tool call; ${describeMiss(r)}` };
    if (call.name !== ADD_NUMBERS_TOOL.name) {
      return { ok: false, note: `called an unknown tool "${call.name}"` };
    }
    try {
      const args = JSON.parse(call.arguments) as { a?: unknown; b?: unknown };
      return Number(args.a) + Number(args.b) === 42
        ? { ok: true }
        : { ok: false, note: `wrong arguments ${snippet(call.arguments)}` };
    } catch {
      return { ok: false, note: `arguments are not JSON: ${snippet(call.arguments)}` };
    }
  },

  async vision(transport, provider, model) {
    const r = await transport.chat(provider, {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What colour is this image? Answer with one word." },
            { type: "image_url", image_url: { url: redSquareDataUrl() } },
          ],
        },
      ],
      temperature: 0,
      maxTokens: PROBE_MAX_TOKENS,
    });
    return /\bred\b/i.test(r.content) ? { ok: true } : { ok: false, note: describeMiss(r) };
  },

  async embed(transport, provider, model) {
    const r = await transport.embed(provider, {
      model,
      input: ["orbital foundry space station"],
      inputType: "query",
    });
    const dimensions = r.vectors[0]?.length ?? 0;
    return dimensions > 0
      ? { ok: true, note: `${dimensions} dimensions` }
      : { ok: false, note: "empty embedding" };
  },
};
