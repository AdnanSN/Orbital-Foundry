import type { Task, TaskStatus } from "@orbital/shared";
import { useState } from "react";
import { StatusChip } from "./AgentInspector";
import type { Ctx } from "./App";
import { ago } from "./format";
import { Panel, Section } from "./Panel";

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: "To do", statuses: ["assigned"] },
  { title: "Working", statuses: ["in_progress", "rework"] },
  { title: "Review", statuses: ["review", "awaiting_approval"] },
  { title: "Done", statuses: ["done", "failed"] },
];

/**
 * The station's real work (ROADMAP §9 Stage 4): an objective box and the task board. WARDEN
 * plans each objective into tasks; the crew work them; reviews send work back or pass it.
 */
export function WorkPanel({ ctx }: { ctx: Ctx }) {
  const { world, ui, link, now } = ctx;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const objectives = [...world.objectives.values()].sort((a, b) => b.createdAt - a.createdAt);
  const tasks = world.realTasks();
  const live = link.kind === "server";

  const submit = async () => {
    if (text.trim().length < 5 || busy) return;
    setBusy(true);
    try {
      await link.commands.createObjective(text.trim());
      setText("");
      ui.toast("WARDEN is planning it.");
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Work"
      accent="#5ff2ff"
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold text-cyan">Objectives and tasks</div>
          <div className="text-dim text-[11px]">
            Give WARDEN an objective; the crew plan, work, review and report back.
          </div>
        </div>
      }
    >
      <Section title="New objective">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
          }}
          rows={3}
          placeholder={
            live
              ? "e.g. Find 10 winter candle niches and rank them"
              : "Needs the station server (npm run dev)"
          }
          disabled={!live}
          aria-label="New objective"
          className="w-full bg-black/30 border border-white/15 rounded px-2 py-1 text-ink outline-none focus:border-cyan/70 resize-y"
        />
        <div className="flex gap-1.5 mt-1">
          <button
            type="button"
            disabled={!live || busy || text.trim().length < 5}
            onClick={() => void submit()}
            className="flex-1 h-7 rounded-md border border-cyan/60 bg-cyan/15 text-cyan font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {busy ? "Sending…" : "Send to WARDEN"}
          </button>
          <button
            type="button"
            disabled={!live}
            onClick={() =>
              link.commands
                .standup()
                .then(() => ui.toast("Standup written."))
                .catch((err: unknown) => ui.toast(err instanceof Error ? err.message : String(err)))
            }
            className="h-7 px-2 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer disabled:opacity-40"
            title="Ask WARDEN for a standup summary"
          >
            Standup
          </button>
        </div>
      </Section>

      <Section title={`Objectives (${objectives.length})`}>
        {objectives.length === 0 ? (
          <div className="text-dim">None yet.</div>
        ) : (
          <ul className="space-y-1">
            {objectives.slice(0, 8).map((o) => (
              <li key={o.id} className="rounded-md bg-white/5 border border-white/10 px-2 py-1">
                <div className="flex justify-between gap-2">
                  <span className="text-dim text-[10px]">
                    {o.id} · {ago(now - o.createdAt)} ago
                  </span>
                  <span className="text-[10px] text-gold">{o.status.replace("_", " ")}</span>
                </div>
                <div className="truncate" title={o.text}>
                  {o.text}
                </div>
                {o.artifactId && (
                  <button
                    type="button"
                    onClick={() => ui.set({ viewing: o.artifactId })}
                    className="text-cyan hover:underline cursor-pointer text-[11px]"
                  >
                    Read the result
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Task board">
        {tasks.length === 0 ? (
          <div className="text-dim">No real tasks yet. The crew keep busy with ambient work.</div>
        ) : (
          <div className="space-y-2">
            {COLUMNS.map((col) => {
              const items = tasks.filter((t) => col.statuses.includes(t.status));
              return (
                <div key={col.title}>
                  <div className="text-[10px] text-dim font-bold tracking-wider mb-0.5">
                    {col.title.toUpperCase()} ({items.length})
                  </div>
                  <ul className="space-y-1">
                    {items.slice(0, 6).map((t) => (
                      <TaskCard key={t.id} task={t} ctx={ctx} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </Panel>
  );
}

function TaskCard({ task, ctx }: { task: Task; ctx: Ctx }) {
  const { world, ui } = ctx;
  return (
    <li className="rounded-md bg-white/5 border border-white/10 px-2 py-1">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate" title={task.title}>
            {task.title}
          </span>
          <button
            type="button"
            onClick={() => ui.set({ selection: { kind: "agent", id: task.assignee }, panel: null })}
            className="text-dim text-[10px] hover:underline cursor-pointer"
          >
            {task.id} · {world.name(task.assignee)}
            {task.reworks > 0 ? ` · rework ${task.reworks}` : ""}
          </button>
        </span>
        <StatusChip status={task.status} />
      </div>
      {task.feedback && task.status === "rework" && (
        <div className="text-[10px] text-[#ff9f43] mt-0.5">“{task.feedback}”</div>
      )}
      {task.artifactId && (
        <button
          type="button"
          onClick={() => ui.set({ viewing: task.artifactId ?? null })}
          className="text-cyan hover:underline cursor-pointer text-[10px]"
        >
          Deliverable
        </button>
      )}
    </li>
  );
}
