import type { Approval } from "@orbital/shared";

/**
 * Phone notifications with Approve and Reject buttons (ROADMAP Stage 11) through a Telegram bot.
 *
 * - New Owner's Desk items are sent to one chat with two inline buttons.
 * - Button presses (callback queries) are read by long polling (no public webhook needed) and
 *   decided only when they come from the configured chat and, if set, the allowed user ids.
 * - During quiet hours nothing is sent; waiting items are summarized when they end.
 * - Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. The token never appears in logs.
 */

export interface TelegramOptions {
  token: string;
  chatId: string;
  /** Telegram user ids allowed to press the buttons (empty: anyone in the chat). */
  allowedUsers?: string[];
  fetchImpl?: typeof fetch;
  quiet?: () => boolean;
  decide(id: string, decision: "approve" | "reject"): Promise<Approval>;
  pending(): Approval[];
  log?: (m: string) => void;
}

const API = "https://api.telegram.org";

interface Update {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number }; text?: string };
  };
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
}

const LABELS: Record<Approval["kind"], [string, string]> = {
  deliverable: ["✅ Accept", "↩️ Send back"],
  action: ["✅ Approve", "⛔ Reject"],
  escalation: ["🔁 Retry", "✖️ Cancel task"],
};

export class TelegramNotifier {
  private readonly fetchImpl: typeof fetch;
  private offset = 0;
  private stopped = false;
  private readonly sent = new Set<string>();
  private held = 0;

  constructor(private readonly opts: TelegramOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Send a new Desk item (or hold it during quiet hours). */
  async notify(a: Approval): Promise<boolean> {
    if (a.status !== "pending" || this.sent.has(a.id)) return false;
    if (this.opts.quiet?.()) {
      this.held += 1;
      return false;
    }
    this.sent.add(a.id);
    const [yes, no] = LABELS[a.kind];
    await this.call("sendMessage", {
      chat_id: this.opts.chatId,
      text: `🛰️ ${a.title}\n\n${a.summary.slice(0, 700)}\n\n${a.id} · Orbital Foundry`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: yes, callback_data: `approve:${a.id}` },
            { text: no, callback_data: `reject:${a.id}` },
          ],
        ],
      },
    });
    return true;
  }

  /** When quiet hours end, one message lists what is waiting. */
  async morningSummary(): Promise<boolean> {
    if (this.held === 0 || this.opts.quiet?.()) return false;
    const waiting = this.opts.pending();
    this.held = 0;
    if (waiting.length === 0) return false;
    await this.call("sendMessage", {
      chat_id: this.opts.chatId,
      text: `☀️ Good morning. ${waiting.length} item(s) wait at the Owner's Desk:\n${waiting
        .slice(0, 10)
        .map((a) => `• ${a.title}`)
        .join("\n")}`,
    });
    for (const a of waiting.slice(0, 10)) await this.notify(a);
    return true;
  }

  /** Read button presses and commands once (long poll up to `timeoutSec`). */
  async poll(timeoutSec = 25): Promise<number> {
    const res = (await this.call("getUpdates", {
      offset: this.offset,
      timeout: timeoutSec,
      allowed_updates: ["callback_query", "message"],
    })) as { result?: Update[] };
    let handled = 0;
    for (const u of res.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      if (u.callback_query) {
        handled += (await this.onCallback(u.callback_query)) ? 1 : 0;
      } else if (u.message?.text?.startsWith("/status") && this.allowedChat(u.message.chat.id)) {
        const waiting = this.opts.pending();
        await this.call("sendMessage", {
          chat_id: this.opts.chatId,
          text: waiting.length
            ? `${waiting.length} waiting:\n${waiting.map((a) => `• ${a.title}`).join("\n")}`
            : "All clear at the Owner's Desk.",
        });
        handled += 1;
      }
    }
    return handled;
  }

  /** Poll until stopped, backing off after errors. */
  async run(): Promise<void> {
    let backoff = 2_000;
    while (!this.stopped) {
      try {
        await this.poll();
        backoff = 2_000;
      } catch (err) {
        this.opts.log?.(
          `telegram: ${String(err).replace(this.opts.token, "[token]").slice(0, 160)}`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private allowedChat(chatId: number): boolean {
    return String(chatId) === String(this.opts.chatId);
  }

  private async onCallback(q: NonNullable<Update["callback_query"]>): Promise<boolean> {
    const fromAllowed =
      !this.opts.allowedUsers?.length || this.opts.allowedUsers.includes(String(q.from.id));
    const m = /^(approve|reject):([A-Z]-\d+)$/.exec(q.data ?? "");
    if (!q.message || !this.allowedChat(q.message.chat.id) || !fromAllowed || !m) {
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "Not allowed." });
      return false;
    }
    const decision = m[1] as "approve" | "reject";
    const id = m[2] as string;
    let text: string;
    try {
      const decided = await this.opts.decide(id, decision);
      text =
        decided.status === "approved"
          ? "✅ Approved from your phone."
          : "↩️ Sent back from your phone.";
    } catch (err) {
      text = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
    }
    await this.call("answerCallbackQuery", { callback_query_id: q.id, text: text.slice(0, 190) });
    await this.call("editMessageText", {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      text: `${q.message.text ?? id}\n\n${text}`,
    });
    return true;
  }

  private async call(method: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${API}/bot${this.opts.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(`Telegram ${method} failed: ${res.status} ${data.description ?? ""}`.trim());
    }
    return data;
  }
}
