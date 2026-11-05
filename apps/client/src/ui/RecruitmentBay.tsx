import { type CrewLook, type CrewRole, ROLE_TEMPLATES, randomLook } from "@orbital/shared";
import { useState } from "react";
import type { Ctx } from "./App";
import { Panel, Section } from "./Panel";
import { Portrait } from "./Portrait";

const NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,7}$/;

/**
 * The Recruitment Bay (ROADMAP §9 Stage 3): pick a role template, name the crew member, and drop
 * the card on a room (or pick the room below). The new hire walks in through the airlock.
 */
export function RecruitmentBay({ ctx }: { ctx: Ctx }) {
  const { world, ui, link } = ctx;
  const hireable = ROLE_TEMPLATES.filter((r) => r.hireable);
  const [role, setRole] = useState<CrewRole>((hireable[0]?.role ?? "operator") as CrewRole);
  const template = hireable.find((r) => r.role === role) ?? hireable[0];
  const [room, setRoom] = useState(template?.room ?? "factory-1");
  const [name, setName] = useState("");
  const [look, setLook] = useState<CrewLook>(() => randomLook(role));
  const [busy, setBusy] = useState(false);
  const workRooms = [...new Set(world.map.anchorsFor("work").map((a) => a.room))].filter(
    (r) => r !== "bridge",
  );
  const nameOk = NAME_RE.test(name);

  const hire = async (targetRoom: string) => {
    if (!nameOk || busy) return;
    if (!workRooms.includes(targetRoom)) {
      ui.toast(`${world.map.room(targetRoom).name} has no workstations.`);
      return;
    }
    setBusy(true);
    try {
      await link.commands.hire({ name, role, room: targetRoom, look });
      ui.toast(`${name} is on the way in through the airlock.`);
      setName("");
      setLook(randomLook(role));
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Recruitment Bay"
      accent="#ffd23f"
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold text-[#ffd23f]">Recruitment Bay</div>
          <div className="text-dim text-[11px]">
            Pick a role, name them, then drag the card onto a room or press Hire.
          </div>
        </div>
      }
    >
      <Section title="Role">
        <div className="grid grid-cols-2 gap-1">
          {hireable.map((r) => (
            <button
              key={r.role}
              type="button"
              onClick={() => {
                setRole(r.role);
                setRoom(r.room);
                setLook(randomLook(r.role));
              }}
              className={`text-left rounded-md border px-2 py-1 cursor-pointer ${
                r.role === role
                  ? "border-[#ffd23f]/70 bg-[#ffd23f]/10"
                  : "border-white/10 hover:bg-white/10"
              }`}
            >
              <div className="font-bold text-[11px]">{r.title}</div>
              <div className="text-dim text-[10px]">{world.map.room(r.room).name}</div>
            </button>
          ))}
        </div>
        {template && <div className="text-dim text-[11px] mt-1">{template.job}</div>}
      </Section>

      <Section title="New crew member">
        <div
          className={`flex gap-3 items-center rounded-lg border p-2 ${
            nameOk ? "border-[#ffd23f]/50" : "border-white/10"
          }`}
        >
          <button
            type="button"
            draggable={nameOk}
            onDragEnd={(e) => {
              const target = ui.camera?.roomAtClient(e.clientX, e.clientY);
              if (target) void hire(target);
            }}
            onClick={() => setLook(randomLook(role))}
            className={`rounded-md bg-black/40 border border-white/10 p-1 ${nameOk ? "cursor-grab" : "cursor-pointer"}`}
            title={
              nameOk
                ? "Drag onto a room to hire · click to shuffle the look"
                : "Name them first · click to shuffle the look"
            }
          >
            <Portrait look={look} scale={4} />
          </button>
          <div className="min-w-0 flex-1 space-y-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (up to 8 letters)"
              maxLength={8}
              aria-label="Name"
              className="w-full bg-black/30 border border-white/15 rounded px-2 py-1 text-ink outline-none focus:border-[#ffd23f]/70"
            />
            <button
              type="button"
              onClick={() => setLook(randomLook(role))}
              className="text-cyan hover:underline cursor-pointer text-[11px]"
            >
              Shuffle look
            </button>
          </div>
        </div>
      </Section>

      <Section title="Room">
        <select
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          aria-label="Room"
          className="w-full bg-black/30 border border-white/15 rounded px-2 py-1 text-ink"
        >
          {workRooms.map((r) => (
            <option key={r} value={r}>
              {world.map.room(r).name}
            </option>
          ))}
        </select>
      </Section>

      <button
        type="button"
        disabled={!nameOk || busy}
        onClick={() => void hire(room)}
        className="w-full h-8 rounded-md border border-[#ffd23f]/60 bg-[#ffd23f]/15 text-[#ffd23f] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default"
      >
        {busy ? "Hiring…" : "Hire"}
      </button>
      <p className="text-dim text-[10px] mt-2">
        Stage 3: new crew run the mock behaviours of their role. Real work arrives in Stage 4.
      </p>
    </Panel>
  );
}
