import fs from "node:fs";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  Transport,
} from "./transport";

/**
 * A mock LLM provider for deterministic end-to-end tests (ROADMAP Stage 4). Each fixture says
 * which requests it answers (by text in the system prompt, the latest user message, or the
 * latest tool result) and what to reply. `RecordingTransport` captures fixtures from real runs.
 */

export interface Fixture {
  when: {
    system?: string;
    user?: string;
    /** Text in the latest tool result (the model's previous tool call came back with this). */
    tool?: string;
    /** Only when the request offers this tool. */
    offers?: string;
  };
  reply: {
    content?: string;
    toolCalls?: { name: string; arguments: unknown }[];
  };
  /** Use the fixture once, then drop it (default: reusable). */
  once?: boolean;
}

function textOf(m: ChatMessage | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
}

export class FixtureTransport implements Transport {
  readonly calls: ChatRequest[] = [];
  private callCount = 0;

  constructor(
    private readonly fixtures: Fixture[],
    private readonly fallback?: (req: ChatRequest) => ChatResult,
  ) {}

  async chat(_provider: string, req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req);
    const system = req.messages
      .filter((m) => m.role === "system")
      .map(textOf)
      .join("\n");
    const lastUser = textOf([...req.messages].reverse().find((m) => m.role === "user"));
    const last = req.messages[req.messages.length - 1];
    const lastTool = last?.role === "tool" ? last.content : "";
    const index = this.fixtures.findIndex((f) => {
      const w = f.when;
      if (w.system && !system.includes(w.system)) return false;
      if (w.user && !lastUser.includes(w.user)) return false;
      if (w.tool && !lastTool.includes(w.tool)) return false;
      if (w.offers && !(req.tools ?? []).some((t) => t.name === w.offers)) return false;
      return true;
    });
    const fixture = this.fixtures[index];
    if (!fixture) {
      if (this.fallback) return this.fallback(req);
      throw new Error(
        `No fixture matches this request (last user message: ${lastUser.slice(0, 120)})`,
      );
    }
    if (fixture.once) this.fixtures.splice(index, 1);
    this.callCount += 1;
    return {
      content: fixture.reply.content ?? "",
      toolCalls: (fixture.reply.toolCalls ?? []).map((c, i) => ({
        id: `call_${this.callCount}_${i}`,
        name: c.name,
        arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
      })),
      finishReason: fixture.reply.toolCalls?.length ? "tool_calls" : "stop",
      inputTokens: 100,
      outputTokens: 50,
    };
  }

  async embed(_provider: string, req: EmbedRequest): Promise<EmbedResult> {
    // Bag-of-letters vectors: deterministic and good enough for similarity in tests.
    return {
      vectors: req.input.map((text) => {
        const v = new Array(26).fill(0) as number[];
        for (const ch of text.toLowerCase()) {
          const i = ch.charCodeAt(0) - 97;
          if (i >= 0 && i < 26) v[i] = (v[i] ?? 0) + 1;
        }
        return v;
      }),
    };
  }
}

/** Wraps a real transport and appends every exchange to a JSON fixture file. */
export class RecordingTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly file: string,
  ) {}

  async chat(provider: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await this.inner.chat(provider, req, signal);
    const system = req.messages.find((m) => m.role === "system");
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const entry: Fixture = {
      when: {
        ...(system ? { system: textOf(system).slice(0, 80) } : {}),
        ...(lastUser ? { user: textOf(lastUser).slice(0, 120) } : {}),
      },
      reply: {
        content: res.content,
        toolCalls: res.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      },
      once: true,
    };
    const existing = fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as Fixture[])
      : [];
    fs.writeFileSync(this.file, `${JSON.stringify([...existing, entry], null, 2)}\n`);
    return res;
  }

  embed(provider: string, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult> {
    return this.inner.embed(provider, req, signal);
  }
}
