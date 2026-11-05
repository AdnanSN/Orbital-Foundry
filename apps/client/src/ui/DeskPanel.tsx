import type { Approval } from "@orbital/shared";
import { useState } from "react";
import type { Ctx } from "./App";
import { ago } from "./format";
import { Panel, Section } from "./Panel";

const KIND_LABEL: Record<Approval["kind"], { label: string; color: string }> = {
  deliverable: { label: "RESULT", color: "#69e08a" },
  action: { label: "ACTION", color: "#ffd166" },
  escalation: { label: "HELP", color: "#ff5f6d" },
};

/**
 * The Owner's Desk (ROADMAP §2): everything waiting for the owner. Results to accept or send
 * back, actions that would leave the station, and crew who are stuck.
 */
export function DeskPanel({ ctx }: { ctx: Ctx }) {
  const { world, ui } = ctx;
  const pending = world.pendingApprovals();
  const recent = [...world.approvals.values()]
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    .slice(0, 5);
  return (
    <Panel
      title="Owner's Desk"
      accent="#f0b8ff"
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold text-[#f0b8ff]">Owner's Desk</div>
          <div className="text-dim text-[11px]">
            Nothing leaves the station without you. Accept results, approve actions, unblock crew.
          </div>
        </div>
      }
    >
      <Section title={`Waiting for you (${pending.length})`}>
        {pending.length === 0 ? (
          <div className="text-dim">All clear.</div>
        ) : (
          <ul className="space-y-2">
            {pending.map((a) => (
              <DeskItem key={a.id} approval={a} ctx={ctx} />
            ))}
          </ul>
        )}
      </Section>
      {recent.length > 0 && (
        <Section title="Decided">
          <ul className="space-y-0.5 text-[11px]">
            {recent.map((a) => (
              <li key={a.id} className="flex justify-between gap-2">
                <span className="truncate" title={a.title}>
                  {a.title}
                </span>
                <span className={a.status === "approved" ? "text-[#69e08a]" : "text-[#ff5f6d]"}>
                  {a.status}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Panel>
  );
}

function DeskItem({ approval, ctx }: { approval: Approval; ctx: Ctx }) {
  const { world, ui, link, now } = ctx;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const kind = KIND_LABEL[approval.kind];
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      await link.commands.decide(approval.id, decision, note.trim() || undefined);
      ui.toast(decision === "approve" ? "Approved." : "Sent back.");
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const yes =
    approval.kind === "escalation" ? "Retry" : approval.kind === "action" ? "Approve" : "Accept";
  const no =
    approval.kind === "escalation"
      ? "Cancel task"
      : approval.kind === "action"
        ? "Reject"
        : "Send back";
  return (
    <li className="rounded-lg bg-white/5 border border-white/10 p-2">
      <div className="flex items-center gap-2">
        <span
          className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider border"
          style={{ color: kind.color, borderColor: `${kind.color}66` }}
        >
          {kind.label}
        </span>
        <span className="text-dim text-[10px]">
          {approval.id} · {world.name(approval.requestedBy)} · {ago(now - approval.createdAt)} ago
        </span>
      </div>
      <div className="font-bold mt-1">{approval.title}</div>
      <div className="text-dim text-[11px] mt-0.5">{approval.summary}</div>
      {approval.artifactId && (
        <button
          type="button"
          onClick={() => ui.set({ viewing: approval.artifactId })}
          className="text-cyan hover:underline cursor-pointer text-[11px] mt-1"
        >
          Read it
        </button>
      )}
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note for the crew (optional)"
        aria-label="Note"
        className="w-full mt-1.5 bg-black/30 border border-white/15 rounded px-2 py-1 text-ink text-[11px] outline-none"
      />
      <div className="flex gap-1.5 mt-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("approve")}
          className="flex-1 h-7 rounded-md border border-[#69e08a]/60 bg-[#69e08a]/15 text-[#69e08a] font-bold cursor-pointer disabled:opacity-40"
        >
          {yes}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("reject")}
          className="flex-1 h-7 rounded-md border border-[#ff5f6d]/50 text-[#ff5f6d] cursor-pointer disabled:opacity-40"
        >
          {no}
        </button>
      </div>
    </li>
  );
}
