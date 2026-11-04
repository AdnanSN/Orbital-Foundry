import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ResolvedProviders } from "../config";
import { ProviderHttpError, parseRetryAfter, truncate } from "./errors";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string, exactly as the model sent it. */
  arguments: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  inputType?: "query" | "passage";
}

export interface EmbedResult {
  vectors: number[][];
  inputTokens?: number;
}

/** Runs chat and embedding requests against a named provider. Tests swap in a fake. */
export interface Transport {
  chat(provider: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  embed(provider: string, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult>;
}

/**
 * Talks to any OpenAI-compatible endpoint: NVIDIA, Cloudflare, Groq, OpenRouter, Gemini, Cerebras.
 * The SDK's own retries are off; the router owns retries, fallbacks and rate limits.
 */
export class OpenAICompatibleTransport implements Transport {
  private readonly clients = new Map<string, OpenAI>();

  constructor(
    private readonly providers: ResolvedProviders,
    private readonly timeoutMs = 120_000,
  ) {}

  async chat(provider: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const client = this.client(provider);
    try {
      const res = await client.chat.completions.create(
        {
          model: req.model,
          messages: req.messages.map(toOpenAIMessage),
          ...(req.tools?.length ? { tools: req.tools.map(toOpenAITool) } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        },
        { signal },
      );
      const choice = res.choices[0];
      const toolCalls: ToolCall[] = [];
      for (const call of choice?.message.tool_calls ?? []) {
        if (call.type === "function") {
          toolCalls.push({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      }
      return {
        content: stripReasoning(choice?.message.content ?? ""),
        toolCalls,
        finishReason: choice?.finish_reason ?? undefined,
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: res.usage?.completion_tokens,
      };
    } catch (err) {
      throw toProviderError(provider, err);
    }
  }

  async embed(provider: string, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult> {
    const client = this.client(provider);
    const sendInputType = req.inputType && this.providers[provider]?.quirks?.embedInputType;
    const body = {
      model: req.model,
      input: req.input,
      encoding_format: "float" as const,
      ...(sendInputType ? { input_type: req.inputType } : {}),
    };
    try {
      const res = await client.embeddings.create(body, { signal });
      return {
        vectors: res.data.map((item) => item.embedding),
        inputTokens: res.usage?.prompt_tokens,
      };
    } catch (err) {
      throw toProviderError(provider, err);
    }
  }

  private client(id: string): OpenAI {
    const existing = this.clients.get(id);
    if (existing) return existing;
    const provider = this.providers[id];
    if (!provider) throw new Error(`Unknown provider "${id}"`);
    if (!provider.apiKey) throw new Error(`${provider.apiKeyEnv} is not set`);
    const client = new OpenAI({
      apiKey: provider.apiKey,
      baseURL: provider.resolvedBaseURL,
      maxRetries: 0,
      timeout: this.timeoutMs,
    });
    this.clients.set(id, client);
    return client;
  }
}

/** Drop <think>…</think> blocks that some reasoning models put in the visible reply. */
export function stripReasoning(content: string): string {
  const close = content.lastIndexOf("</think>");
  if (close >= 0) return content.slice(close + "</think>".length).trim();
  if (content.trimStart().startsWith("<think>")) return ""; // cut off while still thinking
  return content.trim();
}

function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string" ? message.content : message.content.map(toOpenAIPart),
      };
    case "assistant":
      return message.toolCalls?.length
        ? {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : { role: "assistant", content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

function toOpenAIPart(part: ChatContentPart): ChatCompletionContentPart {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: part.image_url.url } };
}

function toOpenAITool(tool: ToolSpec): ChatCompletionTool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function toProviderError(provider: string, err: unknown): Error {
  if (err instanceof APIUserAbortError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return new ProviderHttpError(provider, 0, "request timed out", undefined, "timeout");
  }
  if (err instanceof APIError) {
    if (typeof err.status === "number") {
      return new ProviderHttpError(
        provider,
        err.status,
        truncate(err.message),
        parseRetryAfter(err.headers?.get("retry-after")),
      );
    }
    return new ProviderHttpError(provider, 0, truncate(err.message), undefined, "network");
  }
  return err instanceof Error ? err : new Error(String(err));
}
