import { useCallback, useEffect, useState } from "react";
import type { OpsInfo, VaultInfo } from "../sim/link";
import type { Ctx } from "./App";
import { Panel, Section } from "./Panel";

function money(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number | null): string {
  return n === null ? "–" : `${Math.round(n * 100)}%`;
}

/**
 * The Vault (ROADMAP Stage 10): real money per business (simulated money kept apart), the
 * monthly goal beside the joke trillion-dollar meter, KPIs per room and crew member, model usage
 * with its shadow cost, and the weekly learning loop.
 */
export function VaultPanel({ ctx }: { ctx: Ctx }) {
  const { link, ui, world } = ctx;
  const live = link.kind === "server";
  const [v, setV] = useState<VaultInfo | null>(null);
  const [ops, setOps] = useState<OpsInfo | null>(null);
  const [showSim, setShowSim] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [entry, setEntry] = useState({ business: "thumbs", amount: "", note: "" });

  const load = useCallback(() => {
    link.commands
      .vault()
      .then(setV)
      .catch(() => setV(null));
    link.commands
      .ops()
      .then(setOps)
      .catch(() => setOps(null));
  }, [link]);

  useEffect(() => {
    if (!live) return;
    load();
    const timer = window.setInterval(load, 6_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      ui.toast(await fn());
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // Production (D-046) has no simulated sales: the toggle and the simulator disappear.
  const simOn = v?.simulation !== false;
  const sim = showSim && simOn;
  const rows = v ? (sim ? v.simulated : v.real) : [];
  const total = rows.reduce((s, r) => s + r.net, 0);
  return (
    <Panel
      title="Vault"
      accent="#ffd166"
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold text-gold">The Vault</div>
          <div className="text-dim text-[11px]">Money, KPIs and the weekly plan. Last 7 days.</div>
        </div>
      }
    >
      {!live ? (
        <div className="text-dim">The Vault needs the station server (npm run dev).</div>
      ) : !v ? (
        <div className="text-dim">Loading…</div>
      ) : (
        <>
          <Section title="Goals">
            <div className="text-[11px] mb-0.5">
              This month: <b>{money(v.month.net)}</b> of {money(v.month.goal)} (real net)
            </div>
            <div className="h-2.5 rounded bg-white/10 overflow-hidden">
              <div
                className="h-full bg-[#69e08a]"
                style={{ width: `${Math.min(100, v.month.progress * 100)}%` }}
              />
            </div>
            <div className="text-[11px] mt-1.5 mb-0.5">
              The $1T meter{" "}
              <span className="text-dim">(log scale; a joke, and a long way off)</span>
            </div>
            <div className="h-2.5 rounded bg-white/10 overflow-hidden">
              <div
                className="h-full bg-gold"
                style={{ width: `${Math.max(0.5, v.joke.logProgress * 100)}%` }}
              />
            </div>
          </Section>

          <Section title={sim ? "Simulated money (not real)" : "Money (real)"}>
            {simOn && (
              <label className="flex items-center gap-1 text-[11px] text-dim mb-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showSim}
                  onChange={(e) => setShowSim(e.target.checked)}
                />
                Show simulated sales instead
              </label>
            )}
            <table className="w-full text-[11px]">
              <thead className="text-dim">
                <tr>
                  <th className="text-left font-normal">Business</th>
                  <th className="text-right font-normal">Orders</th>
                  <th className="text-right font-normal">Sales</th>
                  <th className="text-right font-normal">Net</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="truncate max-w-[130px]" title={r.name}>
                      {r.name}
                    </td>
                    <td className="text-right">{r.orders}</td>
                    <td className="text-right">{money(r.sales)}</td>
                    <td className={`text-right ${r.net < 0 ? "text-[#ff5f6d]" : "text-[#69e08a]"}`}>
                      {money(r.net)}
                    </td>
                  </tr>
                ))}
                <tr className="font-bold border-t border-white/10">
                  <td>Total</td>
                  <td />
                  <td />
                  <td className="text-right">{money(total)}</td>
                </tr>
              </tbody>
            </table>
          </Section>

          <Section title="Rooms">
            <table className="w-full text-[11px]">
              <thead className="text-dim">
                <tr>
                  <th className="text-left font-normal">Room</th>
                  <th className="text-right font-normal">Done</th>
                  <th className="text-right font-normal">Rework</th>
                  <th className="text-right font-normal">QA pass</th>
                  <th className="text-right font-normal">Approved</th>
                </tr>
              </thead>
              <tbody>
                {v.rooms.map((r) => (
                  <tr key={r.room}>
                    <td>{world.map.rooms.find((x) => x.id === r.room)?.name ?? r.room}</td>
                    <td className="text-right">{r.done}</td>
                    <td className="text-right">{pct(r.reworkRate)}</td>
                    <td className="text-right">{pct(r.qaPassRate)}</td>
                    <td className="text-right">{pct(r.approvalRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[10px] text-dim mt-1">
              Crew:{" "}
              {v.crew
                .slice(0, 8)
                .map((c) => `${world.name(c.id)} ${c.done}✓${c.reworks ? ` ${c.reworks}↺` : ""}`)
                .join(" · ") || "no finished work yet"}
            </div>
          </Section>

          <Section title="Model calls (7 days)">
            <ul className="text-[11px] space-y-0.5">
              {v.usage.slice(0, 6).map((u) => (
                <li key={`${u.provider}-${u.tier}`} className="flex justify-between gap-2">
                  <span>
                    {u.provider} · {u.tier}
                  </span>
                  <span className="text-dim">
                    {u.calls} calls{u.failures ? ` (${u.failures} failed)` : ""} ·{" "}
                    {money(u.shadowCost)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="text-[10px] text-dim mt-1">
              Shadow cost {money(v.shadowCost)}: roughly what these calls would cost on paid APIs.
              They cost $0 on the free tiers.
            </div>
          </Section>

          <Section title="Learning loop">
            {v.experiments.length > 0 && (
              <ul className="text-[11px] space-y-0.5 mb-1">
                {v.experiments.map((e) => (
                  <li key={`${e.store}-${e.kind}`}>
                    <b>{e.store}</b> {e.kind}: {e.change}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-1">
              {simOn && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void act("sim", async () => {
                      const r = await link.commands.simulateWeek();
                      return `Simulated ${r.sales} sales (${r.revenue.toFixed(2)}), flagged as not real.`;
                    })
                  }
                  className="flex-1 h-7 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer disabled:opacity-40"
                  title="Add a week of simulated sales (never counted as real money)"
                >
                  {busy === "sim" ? "Simulating…" : "Simulate a week"}
                </button>
              )}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void act("retro", async () => {
                    await link.commands.weeklyRetro(
                      simOn && (showSim || v.real.every((r) => r.orders === 0)),
                    );
                    return "WARDEN's weekly plan is at your Desk.";
                  })
                }
                className="flex-1 h-7 rounded-md border border-gold/60 bg-gold/10 text-gold font-bold cursor-pointer disabled:opacity-40"
                title="WARDEN reads the week and proposes changes; you accept them at the Desk"
              >
                {busy === "retro" ? "Thinking…" : "Weekly retro"}
              </button>
            </div>
          </Section>

          {ops && (
            <Section title="Achievements">
              <ul className="text-[11px] space-y-0.5">
                {ops.achievements.map((a) => (
                  <li key={a.id} className={a.at ? "" : "text-dim"}>
                    {a.at ? "🏆" : "·"} {a.title}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {ops && (
            <Section title="Operations">
              <div className="text-[11px] space-y-0.5">
                <div>
                  Last backup:{" "}
                  {ops.lastBackup ? new Date(ops.lastBackup.at).toLocaleString() : "none yet"}
                </div>
                <div>
                  Phone approvals: {ops.telegram ? "on (Telegram)" : "off (no bot token)"} · Access
                  token: {ops.authRequired ? "required" : "off (localhost only)"}
                  {ops.quiet ? " · quiet hours" : ""}
                </div>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void act("backup", async () => {
                    await link.commands.backupNow();
                    return "Backed up.";
                  })
                }
                className="mt-1 w-full h-7 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer disabled:opacity-40"
              >
                {busy === "backup" ? "Backing up…" : "Back up now"}
              </button>
            </Section>
          )}

          <Section title="Add income by hand">
            <div className="flex gap-1">
              <select
                value={entry.business}
                onChange={(e) => setEntry({ ...entry, business: e.target.value })}
                aria-label="Business"
                className="bg-black/30 border border-white/15 rounded px-1 text-[11px]"
              >
                {v.real.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id}
                  </option>
                ))}
              </select>
              <input
                value={entry.amount}
                onChange={(e) => setEntry({ ...entry, amount: e.target.value })}
                placeholder="$"
                aria-label="Amount"
                className="w-16 bg-black/30 border border-white/15 rounded px-1 text-[11px]"
              />
              <input
                value={entry.note}
                onChange={(e) => setEntry({ ...entry, note: e.target.value })}
                placeholder="e.g. Fiverr order #123"
                aria-label="Note"
                className="flex-1 min-w-0 bg-black/30 border border-white/15 rounded px-1 text-[11px]"
              />
              <button
                type="button"
                disabled={!Number(entry.amount)}
                onClick={() =>
                  void act("entry", async () => {
                    await link.commands.addEntry({
                      business: entry.business,
                      kind: "sale",
                      amount: Number(entry.amount),
                      ...(entry.note ? { note: entry.note } : {}),
                    });
                    setEntry({ ...entry, amount: "", note: "" });
                    return "Recorded.";
                  })
                }
                className="h-6 px-2 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer disabled:opacity-40 text-[11px]"
              >
                Add
              </button>
            </div>
            <div className="text-[10px] text-dim mt-1">
              For Fiverr and itch.io income until those are synced.
            </div>
          </Section>
        </>
      )}
    </Panel>
  );
}
