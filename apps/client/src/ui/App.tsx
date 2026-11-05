import { useEffect, useState } from "react";
import type { SimClock } from "../sim/clock";
import type { LinkStatus, StationLink } from "../sim/link";
import type { World } from "../sim/world";
import { AgentInspector } from "./AgentInspector";
import { ArtifactViewer } from "./ArtifactViewer";
import { DeskPanel } from "./DeskPanel";
import { ACTIVITY_COLOR, ACTIVITY_LABEL, stationTime } from "./format";
import { Portrait } from "./Portrait";
import { RecruitmentBay } from "./RecruitmentBay";
import { RoomPanel } from "./RoomPanel";
import { StationLog } from "./StationLog";
import { type UiStore, useUi } from "./store";
import { WorkPanel } from "./WorkPanel";

export interface Ctx {
  world: World;
  clock: SimClock;
  ui: UiStore;
  link: StationLink;
  /** Sim time at the last refresh. */
  now: number;
}

/** Re-renders the panels a few times a second instead of on every station event. */
function useTick(clock: SimClock, ms = 250): number {
  const [now, setNow] = useState(clock.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(clock.now()), ms);
    return () => window.clearInterval(id);
  }, [clock, ms]);
  return now;
}

function useLinkStatus(link: StationLink): LinkStatus {
  const [status, setStatus] = useState(link.status());
  useEffect(() => {
    // The link may have connected between the first render and this effect.
    setStatus(link.status());
    return link.onStatus(setStatus);
  }, [link]);
  return status;
}

export function App({
  world,
  clock,
  ui,
  link,
  seed,
}: {
  world: World;
  clock: SimClock;
  ui: UiStore;
  link: StationLink;
  seed: number | null;
}) {
  const now = useTick(clock);
  const selection = useUi(ui, (s) => s.selection);
  const panel = useUi(ui, (s) => s.panel);
  const viewing = useUi(ui, (s) => s.viewing);
  const status = useLinkStatus(link);
  const ctx: Ctx = { world, clock, ui, link, now };
  return (
    <div className="absolute inset-0 text-[12px] leading-snug">
      <TopBar ctx={ctx} seed={seed} status={status} />
      <Roster ctx={ctx} />
      <StationLog ctx={ctx} />
      {panel === "hire" && <RecruitmentBay ctx={ctx} />}
      {panel === "work" && <WorkPanel ctx={ctx} />}
      {panel === "desk" && <DeskPanel ctx={ctx} />}
      {panel === null && selection?.kind === "agent" && (
        <AgentInspector key={selection.id} ctx={ctx} id={selection.id} />
      )}
      {panel === null && selection?.kind === "room" && (
        <RoomPanel key={selection.id} ctx={ctx} id={selection.id} />
      )}
      {viewing && <ArtifactViewer key={viewing} ctx={ctx} id={viewing} />}
      {(status === "offline" || (status === "connecting" && world.crew.size === 0)) && (
        <Offline status={status} />
      )}
    </div>
  );
}

export function Button({
  onClick,
  active = false,
  title,
  disabled = false,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`min-w-7 h-7 px-2 rounded-md border text-[12px] cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default ${
        active
          ? "bg-cyan/20 border-cyan/60 text-cyan"
          : "border-white/10 text-ink hover:bg-white/10 hover:border-white/25"
      }`}
    >
      {children}
    </button>
  );
}

const STATUS_BADGE: Record<LinkStatus, { label: string; color: string; title: string }> = {
  online: { label: "LIVE", color: "#69e08a", title: "Connected to the station server" },
  connecting: { label: "CONNECTING", color: "#ffd166", title: "Connecting to the station server" },
  offline: {
    label: "OFFLINE",
    color: "#ff5f6d",
    title: "The station server is not reachable; retrying",
  },
  mock: {
    label: "MOCK",
    color: "#ff9f43",
    title: "Offline mode: a local sim runs the crew. No server, no models.",
  },
};

function TopBar({ ctx, seed, status }: { ctx: Ctx; seed: number | null; status: LinkStatus }) {
  const { world, ui, link, now } = ctx;
  const zoom = useUi(ui, (s) => s.zoom);
  const fps = useUi(ui, (s) => s.fps);
  const showNames = useUi(ui, (s) => s.showNames);
  const panel = useUi(ui, (s) => s.panel);
  const sim = world.sim;
  const badge = STATUS_BADGE[status];
  const run = (change: { paused?: boolean; speed?: number }) => {
    link.commands.setSim(change).catch((err: unknown) => ui.toast(String(err)));
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
          className="px-2 py-0.5 rounded-md text-[10px] font-bold tracking-widest border"
          style={{
            color: badge.color,
            borderColor: `${badge.color}66`,
            background: `${badge.color}1a`,
          }}
          title={seed !== null ? `${badge.title} (seed ${seed})` : badge.title}
        >
          {badge.label}
        </span>
      </div>
      <div className="panel rounded-xl px-2.5 py-2 flex items-center gap-1.5">
        <Button
          title="Objectives and the task board"
          onClick={() => ui.set({ panel: panel === "work" ? null : "work" })}
          active={panel === "work"}
        >
          Work
        </Button>
        <Button
          title="Owner's Desk: results, approvals and escalations waiting for you"
          onClick={() => ui.set({ panel: panel === "desk" ? null : "desk" })}
          active={panel === "desk"}
        >
          Desk
          {world.pendingApprovals().length > 0 && (
            <span className="ml-1 px-1 rounded bg-[#ff5f6d] text-white text-[10px] font-bold">
              {world.pendingApprovals().length}
            </span>
          )}
        </Button>
        <Button
          title="Recruitment Bay: hire crew"
          onClick={() => ui.set({ panel: panel === "hire" ? null : "hire" })}
          active={panel === "hire"}
        >
          Hire
        </Button>
        <span className="w-px h-5 bg-white/15 mx-1" />
        <Button
          title={sim.paused ? "Resume" : "Pause"}
          onClick={() => run({ paused: !sim.paused })}
          active={sim.paused}
        >
          {sim.paused ? "▶" : "❚❚"}
        </Button>
        {[1, 2, 4].map((s) => (
          <Button
            key={s}
            title={`Speed ${s}×`}
            onClick={() => run({ paused: false, speed: s })}
            active={!sim.paused && sim.speed === s}
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
  const crew = [...world.crew.values()];
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 panel rounded-xl px-2 py-1.5 flex gap-1 max-w-[calc(100%-24px)] xl:max-w-[calc(100%-660px)] overflow-x-auto">
      {crew.map((c) => {
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
              ui.set({ selection: { kind: "agent", id: c.id }, panel: null });
              ui.camera?.focusAgent(c.id);
            }}
            className={`flex flex-col items-center w-[64px] shrink-0 rounded-lg pt-1 pb-1 cursor-pointer border transition-colors ${
              selected ? "border-gold/70 bg-gold/10" : "border-transparent hover:bg-white/10"
            }`}
          >
            <Portrait look={c.look} scale={2} />
            <span
              className={`text-[11px] font-bold ${c.role === "overseer" ? "text-gold" : "text-ink"}`}
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

function Offline({ status }: { status: LinkStatus }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="panel rounded-xl px-5 py-4 max-w-[420px] text-center">
        <div className="text-[15px] font-bold mb-1" style={{ color: STATUS_BADGE[status].color }}>
          {status === "offline" ? "Station server offline" : "Connecting to the station…"}
        </div>
        <p className="text-dim">
          Start it with <code className="text-ink">npm run dev</code> (server and client) or{" "}
          <code className="text-ink">npm run server</code>. The client reconnects on its own.
        </p>
        <a href="?mock=1" className="inline-block mt-3 text-cyan hover:underline">
          Run offline with a local mock crew instead
        </a>
      </div>
    </div>
  );
}
