import { useState } from "react";
import type { Ctx } from "./App";
import { ago } from "./format";
import { useUi } from "./store";

const KIND_COLOR = {
  say: "#c9c4ef",
  task: "#5ff2ff",
  crew: "#69e08a",
  provider: "#ffb347",
  sim: "#ffd166",
} as const;

/** The station log: a running feed of what the crew say and do. */
export function StationLog({ ctx }: { ctx: Ctx }) {
  const { world, ui, now } = ctx;
  const [open, setOpen] = useState(true);
  const toast = useUi(ui, (s) => s.toast);
  const entries = world.feed.slice(-40).reverse();
  return (
    <>
      {toast && (
        <div className="absolute top-[72px] left-1/2 -translate-x-1/2 panel rounded-lg px-3 py-1.5 text-ink">
          {toast.text}
        </div>
      )}
      <section
        aria-label="Station log"
        className="absolute bottom-3 left-3 panel rounded-xl w-[300px] hidden xl:block"
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-bold tracking-[0.18em] text-dim cursor-pointer hover:text-ink"
        >
          <span>STATION LOG</span>
          <span>{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <ul className="px-3 pb-2 space-y-0.5 max-h-[220px] overflow-y-auto">
            {entries.length === 0 && <li className="text-dim">Quiet so far.</li>}
            {entries.map((e) => (
              <li key={e.id} className="flex gap-2 text-[11px]">
                <span className="text-dim tabular-nums w-9 shrink-0 text-right">
                  {ago(now - e.t)}
                </span>
                <button
                  type="button"
                  disabled={!e.who}
                  onClick={() =>
                    e.who && ui.set({ selection: { kind: "agent", id: e.who }, panel: null })
                  }
                  className="min-w-0 truncate text-left enabled:cursor-pointer enabled:hover:underline"
                  style={{ color: KIND_COLOR[e.kind] }}
                  title={e.text}
                >
                  {e.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
