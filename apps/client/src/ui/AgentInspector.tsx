import { crewMember } from "@orbital/shared";
import type { Ctx } from "./App";
import { ACTIVITY_COLOR, ACTIVITY_LABEL, ago, STATUS_COLOR, STATUS_LABEL } from "./format";
import { Panel, Section, Stat } from "./Panel";
import { Portrait } from "./Portrait";
import { useUi } from "./store";

/** Click a crew member: who they are, what they are doing, and their (mock) numbers. */
export function AgentInspector({ ctx, id }: { ctx: Ctx; id: string }) {
  const { world, ui, now } = ctx;
  const follow = useUi(ui, (s) => s.follow);
  const crew = crewMember(id);
  const agent = world.agents.get(id);
  if (!agent) return null;
  const s = agent.state;
  const room = world.map.roomAt(s.tile.x, s.tile.y);
  const home = world.map.room(crew.room);
  const task = s.taskId ? world.tasks.get(s.taskId) : undefined;
  const tasks = world.tasksFor(id);
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "failed");
  const facingFor = agent.move && now < agent.move.end ? "down" : s.facing;

  return (
    <Panel
      title={crew.name}
      accent={crew.look.accent}
      onClose={() => ui.set({ selection: null, follow: false })}
      header={
        <div className="flex gap-3 items-center">
          <div className="rounded-lg bg-black/40 border border-white/10 p-1">
            <Portrait look={crew.look} scale={4} facing={facingFor === "up" ? "down" : facingFor} />
          </div>
          <div className="min-w-0">
            <div
              className="text-[16px] font-bold"
              style={{ color: id === "warden" ? "#ffd166" : undefined }}
            >
              {crew.name}
            </div>
            <div className="text-dim">{crew.title}</div>
            {crew.business && <div className="text-dim text-[11px] truncate">{crew.business}</div>}
            <button
              type="button"
              className="text-cyan hover:underline cursor-pointer text-[11px]"
              onClick={() => ui.set({ selection: { kind: "room", id: home.id } })}
            >
              {home.name}
            </button>
          </div>
        </div>
      }
    >
      <Section title="Now">
        <div className="flex items-center gap-2">
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider border"
            style={{
              color: ACTIVITY_COLOR[s.activity],
              borderColor: `${ACTIVITY_COLOR[s.activity]}66`,
            }}
          >
            {ACTIVITY_LABEL[s.activity].toUpperCase()}
          </span>
          <span className="text-dim">for {ago(now - s.since)}</span>
          {agent.move && now < agent.move.end && <span className="text-dim">· walking</span>}
        </div>
        {s.status && <div className="mt-1 text-ink">{s.status}</div>}
        <div className="mt-1 text-dim text-[11px]">In {room ? room.name : "a corridor"}</div>
        {agent.bubble && now < agent.bubble.until && (
          <div className="mt-1.5 rounded-md bg-white/5 border border-white/10 px-2 py-1 italic">
            “{agent.bubble.text}”
          </div>
        )}
      </Section>

      <Section title="Task">
        {task ? (
          <div className="flex items-start justify-between gap-2">
            <div>
              <div>{task.title}</div>
              <div className="text-dim text-[11px]">
                {task.id}
                {task.reworks > 0 ? ` · rework ${task.reworks}/2` : ""}
              </div>
            </div>
            <StatusChip status={task.status} />
          </div>
        ) : (
          <div className="text-dim">No task right now.</div>
        )}
        {open.length > (task ? 1 : 0) && (
          <div className="mt-1 text-dim text-[11px]">
            Also open:{" "}
            {open
              .filter((t) => t.id !== task?.id)
              .map((t) => t.id)
              .join(", ")}
          </div>
        )}
      </Section>

      <Section title="Today (mock)">
        <div className="grid grid-cols-4 gap-1.5">
          <Stat label="Done" value={agent.stats.tasksDone} />
          <Stat label="Reworks" value={agent.stats.reworks} />
          <Stat label="Breaks" value={agent.stats.breaks} />
          <Stat label="Calls" value={agent.stats.calls} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {crew.tiers.map((t) => (
            <span
              key={t}
              className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] text-dim"
            >
              {t}
            </span>
          ))}
        </div>
        <div className="mt-1.5 text-dim text-[11px]">{crew.job}</div>
      </Section>

      <Section title="Recent">
        {agent.log.length === 0 ? (
          <div className="text-dim">Nothing yet.</div>
        ) : (
          <ul className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
            {[...agent.log].reverse().map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="text-dim tabular-nums w-12 shrink-0 text-right">
                  {ago(now - e.t)}
                </span>
                <span className="truncate min-w-0" title={e.text}>
                  {e.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="flex gap-1.5 pt-1">
        <button
          type="button"
          onClick={() => ui.set({ follow: !follow })}
          className={`flex-1 h-7 rounded-md border cursor-pointer ${
            follow ? "bg-gold/20 border-gold/60 text-gold" : "border-white/15 hover:bg-white/10"
          }`}
        >
          {follow ? "Following" : "Follow"}
        </button>
        <button
          type="button"
          onClick={() => ui.camera?.focusAgent(id)}
          className="flex-1 h-7 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer"
        >
          Center
        </button>
      </div>
      <p className="text-dim text-[10px] mt-2">
        Mock data from the Stage 2 director. No models are called.
      </p>
    </Panel>
  );
}

export function StatusChip({ status }: { status: keyof typeof STATUS_LABEL }) {
  return (
    <span
      className="shrink-0 px-1.5 py-0.5 rounded text-[10px] border"
      style={{ color: STATUS_COLOR[status], borderColor: `${STATUS_COLOR[status]}66` }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
