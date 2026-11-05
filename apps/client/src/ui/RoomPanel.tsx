import type { Task } from "@orbital/shared";
import { themeFor } from "../art/themes";
import { StatusChip } from "./AgentInspector";
import type { Ctx } from "./App";
import { ACTIVITY_COLOR, ACTIVITY_LABEL, ago } from "./format";
import { Panel, Section, Stat } from "./Panel";
import { Portrait } from "./Portrait";

const PROVIDER_COLOR = { ok: "#69e08a", limited: "#ffb347", down: "#ff5f6d" } as const;

/** Click a room: what it is for, who is in it, and its (mock) numbers. */
export function RoomPanel({ ctx, id }: { ctx: Ctx; id: string }) {
  const { world, ui, now } = ctx;
  const room = world.map.room(id);
  const accent = themeFor(room.theme).accent;
  const inRoom = (x: number, y: number) =>
    x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
  const everyone = [...world.crew.values()];
  const here = everyone.filter((c) => {
    const a = world.agents.get(c.id);
    return a && inRoom(a.state.tile.x, a.state.tile.y);
  });
  const assigned = everyone.filter((c) => c.room === id);
  const tasks = [...world.tasks.values()].filter((t) => t.room === id);

  return (
    <Panel
      title={room.name}
      accent={accent}
      onClose={() => ui.set({ selection: null })}
      header={
        <div className="min-w-0">
          <div className="text-[16px] font-bold" style={{ color: accent }}>
            {room.name}
          </div>
          <div className="text-dim text-[11px] mt-0.5">{room.description}</div>
        </div>
      }
    >
      <Section title={`Here now (${here.length})`}>
        {here.length === 0 ? (
          <div className="text-dim">Nobody.</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {here.map((c) => {
              const a = world.agents.get(c.id);
              const activity = a?.state.activity ?? "idle";
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => ui.set({ selection: { kind: "agent", id: c.id } })}
                  className="flex items-center gap-1 rounded-md bg-white/5 border border-white/10 pr-2 hover:bg-white/10 cursor-pointer"
                  title={ACTIVITY_LABEL[activity]}
                >
                  <Portrait look={c.look} scale={2} />
                  <span>
                    <span className="block text-[11px] font-bold leading-tight">{c.name}</span>
                    <span
                      className="block text-[10px] leading-tight"
                      style={{ color: ACTIVITY_COLOR[activity] }}
                    >
                      {ACTIVITY_LABEL[activity]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {assigned.length > 0 && (
          <div className="mt-1 text-dim text-[11px]">
            Assigned: {assigned.map((c) => c.name).join(", ")}
          </div>
        )}
      </Section>

      <RoomDetails ctx={ctx} id={id} tasks={tasks} />

      {tasks.length > 0 && (
        <Section title="Recent tasks">
          <ul className="space-y-1">
            {[...tasks]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 6)
              .map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate" title={t.title}>
                      {t.title}
                    </span>
                    <span className="block text-dim text-[10px]">
                      {t.id} · {t.assignee} · {ago(now - t.updatedAt)} ago
                    </span>
                  </span>
                  <StatusChip status={t.status} />
                </li>
              ))}
          </ul>
        </Section>
      )}
      <p className="text-dim text-[10px]">
        Mock data from the Stage 2 director. No models are called.
      </p>
    </Panel>
  );
}

function count(tasks: Task[], status: Task["status"]): number {
  return tasks.filter((t) => t.status === status).length;
}

function RoomDetails({ ctx, id, tasks }: { ctx: Ctx; id: string; tasks: Task[] }) {
  const { world, now } = ctx;
  const all = [...world.tasks.values()];
  switch (id) {
    case "server-room":
      return (
        <Section title="Providers (mock status)">
          <ul className="space-y-1">
            {[...world.providers.values()].map((p) => (
              <li key={p.provider} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: PROVIDER_COLOR[p.state] }}
                  />
                  {p.provider}
                </span>
                <span className="text-[11px]" style={{ color: PROVIDER_COLOR[p.state] }}>
                  {p.state === "ok"
                    ? "ok"
                    : `${p.state}${p.until ? `, ${ago(p.until - now)} left` : ""}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-dim text-[11px]">
            Racks turn amber on a rate limit and spark when a provider is down.
          </div>
        </Section>
      );
    case "qa-bay": {
      const reviewed = all.filter(
        (t) => t.status === "done" && t.room !== "research" && t.room !== "vault",
      );
      return (
        <Section title="Quality">
          <div className="grid grid-cols-3 gap-1.5">
            <Stat label="On intake" value={world.intakeCount()} />
            <Stat label="Passed" value={reviewed.length} />
            <Stat label="Sent back" value={all.reduce((n, t) => n + t.reworks, 0)} />
          </div>
        </Section>
      );
    }
    case "cafe": {
      const onBreak = [...world.crew.values()].filter(
        (c) => world.agents.get(c.id)?.state.activity === "coffee",
      );
      const limited = [...world.providers.values()].filter((p) => p.state === "limited");
      return (
        <Section title="Breaks">
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="On a break" value={onBreak.length} />
            <Stat label="Rate limits now" value={limited.length} />
          </div>
          <div className="mt-1 text-dim text-[11px]">
            {limited.length > 0
              ? `Backing off: ${limited.map((p) => p.provider).join(", ")}.`
              : "No provider is rate-limited right now."}
          </div>
        </Section>
      );
    }
    case "bridge": {
      const states = [...world.crew.values()].map(
        (c) => world.agents.get(c.id)?.state.activity ?? "idle",
      );
      return (
        <Section title="Crew">
          <div className="grid grid-cols-3 gap-1.5">
            <Stat
              label="Working"
              value={states.filter((s) => s === "work" || s === "review").length}
            />
            <Stat label="Idle" value={states.filter((s) => s === "idle").length} />
            <Stat label="On break" value={states.filter((s) => s === "coffee").length} />
          </div>
          <div className="mt-1.5 text-dim text-[11px]">
            Objectives (mock): 3 listings per store · 3 thumbnail variants · 1 icon pack.
          </div>
        </Section>
      );
    }
    case "vault":
      return (
        <Section title="Ledger">
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Revenue" value="$0.00" />
            <Stat label="Goal" value="$1T" />
          </div>
          <div className="mt-1 text-dim text-[11px]">
            Real money and the weekly plan live in the Vault.
          </div>
        </Section>
      );
    case "owners-desk":
      return (
        <Section title="Approvals">
          <Stat label="Waiting for you" value={world.pendingApprovals().length} />
          <button
            type="button"
            onClick={() => ctx.ui.set({ panel: "desk" })}
            className="mt-1 text-cyan hover:underline cursor-pointer text-[11px]"
          >
            Open the Owner's Desk
          </button>
        </Section>
      );
    case "airlock":
      return (
        <Section title="Hiring">
          <div className="text-dim text-[11px]">The Recruitment Bay arrives in Stage 3.</div>
        </Section>
      );
    default:
      return (
        <Section title="Work">
          <div className="grid grid-cols-3 gap-1.5">
            <Stat
              label="In progress"
              value={count(tasks, "in_progress") + count(tasks, "assigned")}
            />
            <Stat label="In QA" value={count(tasks, "review")} />
            <Stat label="Done" value={count(tasks, "done")} />
          </div>
          {id === "factory-1" && (
            <ul className="mt-1.5 space-y-0.5 text-[11px]">
              <li>Store A · candles · Wick</li>
              <li>Store B · personalized gifts · Gift</li>
              <li>Store C · wall art · Frame</li>
            </ul>
          )}
        </Section>
      );
  }
}
