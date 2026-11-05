import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Approval, getStationMap } from "@orbital/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { buildApp } from "../src/http/app";
import { Achievements } from "../src/ops/achievements";
import { isQuiet, OpsService, opsConfigSchema } from "../src/ops/ops";
import { TelegramNotifier } from "../src/ops/telegram";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import { WorkStore } from "../src/work/store";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-ops-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, store: new WorkStore(db) };
}

const approval = (id: string, kind: Approval["kind"] = "deliverable"): Approval => ({
  id,
  kind,
  status: "pending",
  title: `Listing ready: ${id}`,
  summary: "A summary.",
  requestedBy: "wick",
  objectiveId: null,
  taskId: null,
  artifactId: null,
  action: null,
  createdAt: 0,
  decidedAt: null,
  note: null,
});

describe("quiet hours and backups", () => {
  it("knows quiet hours that wrap past midnight", () => {
    const at = (h: number) => new Date(2026, 10, 5, h, 30);
    expect(isQuiet(at(23), [23, 7])).toBe(true);
    expect(isQuiet(at(3), [23, 7])).toBe(true);
    expect(isQuiet(at(7), [23, 7])).toBe(false);
    expect(isQuiet(at(12), [9, 17])).toBe(true);
  });

  it("backs up the database and new artifact files, keeping the newest copies", async () => {
    const t = tmp();
    fs.mkdirSync(path.join(t.dir, "artifacts", "images"), { recursive: true });
    fs.writeFileSync(path.join(t.dir, "artifacts", "images", "I-0001.png"), "png");
    t.store.setKv("probe", "1");
    let minute = 0;
    const ops = new OpsService(t.db, opsConfigSchema.parse({ backups: { keep: 2 } }), {
      dataDir: t.dir,
      clock: () => new Date(2026, 10, 5, 3, minute),
      getKv: (k) => t.store.getKv(k),
      setKv: (k, v) => t.store.setKv(k, v),
    });
    const first = await ops.backup();
    expect(first.copiedFiles).toBe(1);
    const copy = openDb(first.database);
    expect(new WorkStore(copy).getKv("probe")).toBe("1");
    copy.close();
    minute = 1;
    expect((await ops.backup()).copiedFiles).toBe(0); // artifacts never change: nothing new
    minute = 2;
    const third = await ops.backup();
    expect(third.removed).toHaveLength(1);
    expect(fs.readdirSync(ops.backupDir).filter((f) => f.endsWith(".db"))).toHaveLength(2);
    expect(ops.lastBackup()?.database).toBe(third.database);
  });

  it("runs the nightly backup once, at its hour", async () => {
    const t = tmp();
    let hour = 2;
    const ops = new OpsService(t.db, opsConfigSchema.parse({}), {
      dataDir: t.dir,
      clock: () => new Date(2026, 10, 5, hour, 0),
      getKv: (k) => t.store.getKv(k),
      setKv: (k, v) => t.store.setKv(k, v),
    });
    expect(await ops.tick()).toBeNull();
    hour = 3;
    expect(await ops.tick()).not.toBeNull();
    expect(await ops.tick()).toBeNull();
  });
});

describe("phone approvals over Telegram", () => {
  function bot(opts: { quiet?: boolean; updates?: unknown[] } = {}) {
    const sent: { method: string; body: Record<string, unknown> }[] = [];
    const decided: string[] = [];
    let quiet = opts.quiet ?? false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sent.push({ method, body });
      if (method === "getUpdates")
        return new Response(JSON.stringify({ ok: true, result: opts.updates ?? [] }));
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as typeof fetch;
    const pending = [approval("A-0001"), approval("A-0002", "action")];
    const n = new TelegramNotifier({
      token: "123:secret",
      chatId: "42",
      allowedUsers: ["7"],
      fetchImpl,
      quiet: () => quiet,
      decide: async (id, d) => {
        decided.push(`${id}:${d}`);
        return { ...approval(id), status: d === "approve" ? "approved" : "rejected" };
      },
      pending: () => pending,
    });
    return { n, sent, decided, setQuiet: (q: boolean) => (quiet = q) };
  }

  it("sends a Desk item with Accept and Send back buttons", async () => {
    const b = bot();
    expect(await b.n.notify(approval("A-0001"))).toBe(true);
    expect(await b.n.notify(approval("A-0001"))).toBe(false); // once
    const msg = b.sent[0];
    expect(msg?.method).toBe("sendMessage");
    expect(msg?.body.chat_id).toBe("42");
    expect(JSON.stringify(msg?.body.reply_markup)).toContain("approve:A-0001");
    expect(JSON.stringify(msg?.body.reply_markup)).toContain("Send back");
  });

  it("decides only presses from the configured chat and user", async () => {
    const press = (chat: number, user: number, data: string, id: number) => ({
      update_id: id,
      callback_query: {
        id: `q${id}`,
        from: { id: user },
        data,
        message: { message_id: 5, chat: { id: chat }, text: "x" },
      },
    });
    const b = bot({
      updates: [
        press(42, 7, "approve:A-0001", 1),
        press(99, 7, "approve:A-0002", 2), // another chat
        press(42, 8, "reject:A-0002", 3), // another user
        press(42, 7, "approve:../../etc", 4), // not an id
      ],
    });
    expect(await b.n.poll(0)).toBe(1);
    expect(b.decided).toEqual(["A-0001:approve"]);
    const answers = b.sent
      .filter((s) => s.method === "answerCallbackQuery")
      .map((s) => s.body.text);
    expect(answers).toEqual([
      "✅ Approved from your phone.",
      "Not allowed.",
      "Not allowed.",
      "Not allowed.",
    ]);
  });

  it("holds messages in quiet hours and sums them up in the morning", async () => {
    const b = bot({ quiet: true });
    expect(await b.n.notify(approval("A-0001"))).toBe(false);
    expect(b.sent).toHaveLength(0);
    b.setQuiet(false);
    expect(await b.n.morningSummary()).toBe(true);
    expect(String(b.sent[0]?.body.text)).toContain("2 item(s) wait");
  });
});

describe("access token and achievements", () => {
  it("guards the API with a token when one is set, but keeps health open", async () => {
    const t = tmp();
    const world = new SimServer({
      map: getStationMap(),
      store: new SimStore(t.db),
      seed: 1,
      mockProviders: false,
    });
    const app = await buildApp(world, undefined, { token: "s3cret-token" });
    cleanups.push(() => void app.close());
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/state",
          headers: { authorization: "Bearer wrong-token!" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/state",
          headers: { authorization: "Bearer s3cret-token" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/state?token=s3cret-token" })).statusCode,
    ).toBe(200);
  });

  it("unlocks achievements once and announces them", () => {
    const t = tmp();
    const said: string[] = [];
    const a = new Achievements(t.db, t.store, (title) => said.push(title));
    expect(a.check()).toEqual([]);
    t.store.saveArtifact(
      {
        id: "F-0001",
        kind: "listing-package",
        title: "x",
        mime: "text/markdown",
        taskId: null,
        objectiveId: null,
        createdBy: "wick",
        createdAt: 0,
        size: 1,
        info: { published: { mode: "dry-run" } },
      },
      "x",
    );
    expect(a.check()).toEqual(["first-package", "first-publish"]);
    expect(a.check()).toEqual([]);
    expect(said).toEqual(["First listing package", "First publish (a dry run counts)"]);
    expect(a.list().find((x) => x.id === "first-sale")?.at).toBeNull();
  });
});
