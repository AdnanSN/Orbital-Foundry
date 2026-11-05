import { useCallback, useEffect, useState } from "react";
import type { PackInfo } from "../sim/link";
import type { Ctx } from "./App";
import { Panel, Section } from "./Panel";

/**
 * Factory 3, the Asset Forge (ROADMAP Stage 9): a theme becomes a consistent pixel-art icon pack
 * with a sprite sheet, a preview, a licence and itch.io copy. Uploading is a separate approval.
 */
export function ForgePanel({ ctx }: { ctx: Ctx }) {
  const { link, ui } = ctx;
  const live = link.kind === "server";
  const [packs, setPacks] = useState<PackInfo[] | null>(null);
  const [theme, setTheme] = useState("");
  const [size, setSize] = useState(32);
  const [count, setCount] = useState(32);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    link.commands
      .packs()
      .then(setPacks)
      .catch(() => setPacks([]));
  }, [link]);

  useEffect(() => {
    if (!live) return;
    load();
    const timer = window.setInterval(load, 4_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const submit = async () => {
    if (theme.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      await link.commands.forgePack({ theme: theme.trim(), size, count });
      ui.toast("Forge is planning the pack.");
      setTheme("");
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "w-full bg-black/30 border border-white/15 rounded px-2 py-1 text-ink outline-none focus:border-cyan/70";
  return (
    <Panel
      title="Forge"
      accent="#b388ff"
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold text-[#b388ff]">Factory 3: Asset Forge</div>
          <div className="text-dim text-[11px]">
            A theme becomes a consistent pixel-art icon pack for itch.io.
          </div>
        </div>
      }
    >
      <Section title="New pack">
        <div className="space-y-1.5">
          <input
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="Theme, e.g. cozy alchemy ingredients"
            aria-label="Pack theme"
            disabled={!live || busy}
            className={field}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <label className="block text-[11px] text-dim">
              Size
              <select
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                disabled={!live || busy}
                className={field}
              >
                <option value={16}>16 px</option>
                <option value={32}>32 px</option>
                <option value={64}>64 px</option>
              </select>
            </label>
            <label className="block text-[11px] text-dim">
              Icons
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                disabled={!live || busy}
                className={field}
              >
                <option value={16}>16</option>
                <option value={32}>32</option>
                <option value={48}>48</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            disabled={!live || busy || theme.trim().length < 3}
            onClick={() => void submit()}
            className="w-full h-8 rounded-md border border-[#b388ff]/60 bg-[#b388ff]/15 text-[#b388ff] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {busy ? "Sending…" : "Forge a pack"}
          </button>
          <div className="text-dim text-[10px]">
            About 3 to 4 generated sheets per 32 icons, from the free daily image budget.
          </div>
        </div>
      </Section>
      <Section title={`Packs (${packs?.length ?? 0})`}>
        {!live ? (
          <div className="text-dim">Needs the station server (npm run dev).</div>
        ) : packs === null ? (
          <div className="text-dim">Loading…</div>
        ) : packs.length === 0 ? (
          <div className="text-dim">No packs yet.</div>
        ) : (
          <ul className="space-y-2">
            {packs.slice(0, 6).map((p) => (
              <li key={p.id} className="rounded-lg bg-white/5 border border-white/10 p-2 space-y-1">
                <div className="flex justify-between gap-2 text-[11px]">
                  <span className="truncate font-bold">{p.plan?.title ?? p.request.theme}</span>
                  <span
                    className={
                      p.status === "failed"
                        ? "text-[#ff5f6d]"
                        : p.running
                          ? "text-gold"
                          : "text-[#69e08a]"
                    }
                  >
                    {p.running ? "forging…" : p.status}
                  </span>
                </div>
                <div className="text-[10px] text-dim">
                  {p.icons.length}/{p.request.count} icons · {p.request.size}px
                  {p.score !== null ? ` · consistency ${p.score}/10` : ""}
                  {p.uploaded ? ` · uploaded (${p.uploaded.mode})` : ""}
                </div>
                {p.error && <div className="text-[10px] text-[#ff5f6d]">{p.error}</div>}
                {p.preview && (
                  <button
                    type="button"
                    onClick={() => p.deliveryId && ui.set({ viewing: p.deliveryId })}
                    className="block w-full cursor-pointer"
                  >
                    <img
                      src={link.commands.fileUrl(p.preview)}
                      alt={`${p.plan?.title ?? "pack"} preview`}
                      loading="lazy"
                      className="w-full rounded border border-white/10"
                      style={{ imageRendering: "pixelated" }}
                    />
                  </button>
                )}
                {p.deliveryId && (
                  <a
                    href={link.commands.zipUrl(p.deliveryId)}
                    className="text-cyan hover:underline text-[10px]"
                    download
                  >
                    Download the pack (ZIP)
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Panel>
  );
}
