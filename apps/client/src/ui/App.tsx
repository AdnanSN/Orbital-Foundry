import { STARTING_CREW } from "@orbital/shared";
import { useEffect, useState } from "react";
import type { SimClock } from "../sim/clock";
import type { World } from "../sim/world";
import { AgentInspector } from "./AgentInspector";
import { ACTIVITY_COLOR, ACTIVITY_LABEL, stationTime } from "./format";
import { Portrait } from "./Portrait";
import { RoomPanel } from "./RoomPanel";
import { type UiStore, useUi } from "./store";

export interface Ctx {
  world: World;
  clock: SimClock;
  ui: UiStore;
  /** Sim time at the last refresh. */
  now: number;
}

/** Re-renders the panels a few times a second instead of on every station event. */
function useTick(world: World, clock: SimClock, ms = 250): number {
  const [now, setNow] = useState(clock.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(clock.now()), ms);
    return () => window.clearInterval(id);
  }, [clock, ms]);
  void world;
  return now;
}

export function App({
  world,
  clock,
  ui,
  seed,
}: {
  world: World;
  clock: SimClock;
  ui: UiStore;
  seed: number;
}) {
  const now = useTick(world, clock);
  const selection = useUi(ui, (s) => s.selection);
  const ctx: Ctx = { world, clock, ui, now };
  return (
    <div className="absolute inset-0 text-[12px] leading-snug">
      <TopBar ctx={ctx} seed={seed} />
      <Roster ctx={ctx} />
      <Help />
      {selection?.kind === "agent" && (
        <AgentInspector key={selection.id} ctx={ctx} id={selection.id} />
      )}
      {selection?.kind === "room" && <RoomPanel key={selection.id} ctx={ctx} id={selection.id} />}
    </div>
  );
}

function Button({
  onClick,
  active = false,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`min-w-7 h-7 px-2 rounded-md border text-[12px] cursor-pointer transition-colors ${
        active
          ? "bg-cyan/20 border-cyan/60 text-cyan"
          : "border-white/10 text-ink hover:bg-white/10 hover:border-white/25"
      }`}
    >
      {children}
    </button>
  );
}

function TopBar({ ctx, seed }: { ctx: Ctx; seed: number }) {
  const { clock, ui, now } = ctx;
  const zoom = useUi(ui, (s) => s.zoom);
  const fps = useUi(ui, (s) => s.fps);
  const showNames = useUi(ui, (s) => s.showNames);
  const [, force] = useState(0);
  const setSpeed = (s: number) => {
    clock.setSpeed(s);
    clock.resume();
    force((n) => n + 1);
  };
  const togglePause = () => {
    if (clock.paused) clock.resume();
    else clock.pause();
    force((n) => n + 1);
  };
  return (
    <div className="absolute top-3 left-3 right-3 flex items-start justify-between gap-3 pointer-events-none">
      <div className="panel rounded-xl px-4 py-2.5 flex items-center gap-3">
        <div>
          <div className="font-bold tracking-[0.2em] text-[14px] text-gold">ORBITAL FOUNDRY</div>
          <div className="text-dim text-[11px]">{stationTime(now)}</div>
        </div>
        <span
          className="px-2 py-0.5 rounded-md text-[10px] font-bold tracking-widest border border-cyan/40 text-cyan bg-cyan/10"
          title="Sandbox lane: nothing here reaches customers or marketplaces"
        >
          SANDBOX
        </span>
        <span
          className="px-2 py-0.5 rounded-md text-[10px] font-bold tracking-widest border border-[#ff9f43]/40 text-[#ff9f43] bg-[#ff9f43]/10"
          title={`Stage 2: a mock director drives the crew (seed ${seed}). No models are called.`}
        >
          MOCK CREW
        </span>
      </div>
      <div className="panel rounded-xl px-2.5 py-2 flex items-center gap-1.5">
        <Button
          title={clock.paused ? "Resume" : "Pause"}
          onClick={togglePause}
          active={clock.paused}
        >
          {clock.paused ? "▶" : "❚❚"}
        </Button>
        {[1, 2, 4].map((s) => (
          <Button
            key={s}
            title={`Speed ${s}×`}
            onClick={() => setSpeed(s)}
            active={!clock.paused && clock.speed === s}
          >
            {s}×
          </Button>
        ))}
        <span className="w-px h-5 bg-white/15 mx-1" />
        <Button title="Zoom out (−)" onClick={() => ui.camera?.zoomBy(0.8)}>
          −
        </Button>
        <span className="w-11 text-center text-dim tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button title="Zoom in (+)" onClick={() => ui.camera?.zoomBy(1.25)}>
          +
        </Button>
        <Button title="Fit the whole station (F)" onClick={() => ui.camera?.fit()}>
          Fit
        </Button>
        <Button
          title="Show name tags"
          onClick={() => ui.set({ showNames: !showNames })}
          active={showNames}
        >
          Names
        </Button>
        <span className="w-px h-5 bg-white/15 mx-1" />
        <span className="text-dim tabular-nums w-14 text-right" title="Frames per second">
          {fps > 0 ? fps : "–"} fps
        </span>
      </div>
    </div>
  );
}

function Roster({ ctx }: { ctx: Ctx }) {
  const { world, ui } = ctx;
  const selection = useUi(ui, (s) => s.selection);
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 panel rounded-xl px-2 py-1.5 flex gap-1">
      {STARTING_CREW.map((c) => {
        const a = world.agents.get(c.id);
        const activity = a?.state.activity ?? "idle";
        const selected = selection?.kind === "agent" && selection.id === c.id;
        const label = ACTIVITY_LABEL[activity];
        return (
          <button
            key={c.id}
            type="button"
            title={`${c.name}, ${c.title}: ${label}${a?.state.status ? ` (${a.state.status})` : ""}`}
            onClick={() => {
              ui.set({ selection: { kind: "agent", id: c.id } });
              ui.camera?.focusAgent(c.id);
            }}
            className={`flex flex-col items-center w-[64px] rounded-lg pt-1 pb-1 cursor-pointer border transition-colors ${
              selected ? "border-gold/70 bg-gold/10" : "border-transparent hover:bg-white/10"
            }`}
          >
            <Portrait look={c.look} scale={2} />
            <span
              className={`text-[11px] font-bold ${c.id === "warden" ? "text-gold" : "text-ink"}`}
            >
              {c.name}
            </span>
            <span
              className="flex items-center gap-1 text-[10px]"
              style={{ color: ACTIVITY_COLOR[activity] }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: ACTIVITY_COLOR[activity] }}
              />
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Help() {
  return (
    <div className="absolute bottom-3 left-3 panel rounded-lg px-3 py-2 text-dim text-[11px] max-w-[220px] hidden xl:block">
      <div className="text-ink font-bold mb-0.5">Controls</div>
      Drag or WASD to pan · scroll to zoom · F to fit · click a crew member or a room · Esc to close
    </div>
  );
}
