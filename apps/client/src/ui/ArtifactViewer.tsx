import { useEffect, useState } from "react";
import type { Ctx } from "./App";
import { Markdown } from "./Markdown";

/** A deliverable, opened from the task board or the Owner's Desk. */
export function ArtifactViewer({ ctx, id }: { ctx: Ctx; id: string }) {
  const { link, ui, world } = ctx;
  const meta = world.artifacts.get(id);
  const [state, setState] = useState<{ content: string | null; error: string | null }>({
    content: null,
    error: null,
  });
  useEffect(() => {
    let alive = true;
    link.commands
      .artifact(id)
      .then((a) => alive && setState({ content: a.content ?? "", error: null }))
      .catch((err: unknown) => alive && setState({ content: null, error: String(err) }));
    return () => {
      alive = false;
    };
  }, [id, link]);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-auto">
      <div className="panel rounded-xl w-[min(760px,calc(100%-32px))] max-h-[calc(100%-120px)] flex flex-col">
        <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-2 border-b border-white/10">
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-gold truncate">{meta?.title ?? id}</div>
            {meta && (
              <div className="text-dim text-[11px]">
                {id} · by {world.name(meta.createdBy)}
                {meta.taskId ? ` · ${meta.taskId}` : ""}
                {meta.objectiveId ? ` · ${meta.objectiveId}` : ""} · sandbox: not published
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => ui.set({ viewing: null })}
            aria-label="Close"
            className="w-7 h-7 shrink-0 rounded-md text-dim hover:text-ink hover:bg-white/10 cursor-pointer"
          >
            ×
          </button>
        </div>
        <div className="px-4 py-3 overflow-y-auto">
          {state.error ? (
            <div className="text-[#ff5f6d]">{state.error}</div>
          ) : state.content === null ? (
            <div className="text-dim">Loading…</div>
          ) : (
            <Markdown text={state.content} />
          )}
        </div>
      </div>
    </div>
  );
}
