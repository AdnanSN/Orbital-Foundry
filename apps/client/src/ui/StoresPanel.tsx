import type { ArtifactMeta } from "@orbital/shared";
import { useCallback, useEffect, useState } from "react";
import type { StoreInfo } from "../sim/link";
import type { Ctx } from "./App";
import { ago } from "./format";
import { Panel, Section } from "./Panel";

const REVIEW_COLOR: Record<string, string> = {
  pending: "#ffd166",
  approved: "#69e08a",
  rejected: "#ff5f6d",
};

/**
 * Factory 1's store dashboards (ROADMAP Stage 6): each Etsy print-on-demand store with today's
 * listings against its daily target, its latest listing packages, and controls to start a
 * listing, pause the store, or change how many listings it makes a day.
 */
export function StoresPanel({ ctx }: { ctx: Ctx }) {
  const { link, ui } = ctx;
  const live = link.kind === "server";
  const [stores, setStores] = useState<StoreInfo[] | null>(null);
  const [publishing, setPublishing] = useState<{
    mode: string;
    dailyCap: number;
    killed: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    link.commands
      .stores()
      .then((s) => {
        setStores(s);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
    link.commands
      .publishing()
      .then(setPublishing)
      .catch(() => setPublishing(null));
  }, [link]);

  useEffect(() => {
    if (!live) return;
    load();
    const timer = window.setInterval(load, 4_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const act = async (fn: () => Promise<void>, done: string) => {
    try {
      await fn();
      ui.toast(done);
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Panel
      title="Stores"
      accent="#ff9f43"
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold text-[#ff9f43]">Factory 1: Etsy POD</div>
          <div className="text-dim text-[11px]">
            Sandbox: listing packages for your review. Nothing is published before Stage 7.
          </div>
        </div>
      }
    >
      {publishing && (
        <div
          className={`rounded-lg border p-2 flex items-center gap-2 ${
            publishing.killed ? "border-[#ff5f6d]/70 bg-[#ff5f6d]/10" : "border-white/10 bg-white/5"
          }`}
        >
          <div className="flex-1 text-[11px]">
            <div>
              Publishing:{" "}
              <b className={publishing.mode === "live" ? "text-[#ff9f43]" : "text-cyan"}>
                {publishing.mode === "live" ? "LIVE" : "dry run"}
              </b>{" "}
              · cap {publishing.dailyCap}/store/day
            </div>
            <div className="text-dim text-[10px]">
              {publishing.killed
                ? "Kill switch ON: no new listings, nothing is published."
                : "Each publish still needs your approval at the Desk."}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              void act(
                () => link.commands.setKill(!publishing.killed),
                publishing.killed ? "Kill switch off." : "Kill switch ON: everything stops.",
              )
            }
            className={`h-7 px-2 rounded-md border font-bold cursor-pointer ${
              publishing.killed
                ? "border-[#69e08a]/60 text-[#69e08a]"
                : "border-[#ff5f6d]/60 text-[#ff5f6d] bg-[#ff5f6d]/10"
            }`}
            title="Station kill switch: stops new listings and all publishing"
          >
            {publishing.killed ? "Resume" : "KILL"}
          </button>
        </div>
      )}
      {!live ? (
        <div className="text-dim">The stores need the station server (npm run dev).</div>
      ) : error ? (
        <div className="text-[#ff5f6d]">{error}</div>
      ) : stores === null ? (
        <div className="text-dim">Loading…</div>
      ) : (
        stores.map((s) => <StoreCard key={s.id} ctx={ctx} store={s} act={act} />)
      )}
    </Panel>
  );
}

function StoreCard({
  ctx,
  store,
  act,
}: {
  ctx: Ctx;
  store: StoreInfo;
  act: (fn: () => Promise<void>, done: string) => Promise<void>;
}) {
  const { link, world } = ctx;
  const { settings } = store;
  const pending = store.packages.filter((p) => (p.review ?? "pending") === "pending").length;
  return (
    <Section title={store.name}>
      <div className="rounded-lg bg-white/5 border border-white/10 p-2 space-y-1.5">
        <div className="text-[11px] text-dim">{store.niche}</div>
        <div className="flex items-center justify-between text-[11px]">
          <span>
            Operator <b>{world.name(store.crew)}</b>
          </span>
          <span>
            Today{" "}
            <b className={store.today >= settings.listingsPerDay ? "text-[#69e08a]" : ""}>
              {store.today}/{settings.listingsPerDay}
            </b>
            {settings.paused && <span className="ml-1 text-[#ff5f6d]">paused</span>}
          </span>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={store.running}
            onClick={() =>
              void act(() => link.commands.startListing(store.id), "A new listing is under way.")
            }
            className="flex-1 h-7 rounded-md border border-[#ff9f43]/60 bg-[#ff9f43]/15 text-[#ff9f43] font-bold cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {store.running ? "Working on a listing…" : "New listing"}
          </button>
          <button
            type="button"
            title="Listings per day (the autopilot runs in working hours)"
            onClick={() =>
              void act(
                () =>
                  link.commands.updateStore(store.id, {
                    listingsPerDay: Math.max(0, settings.listingsPerDay - 1),
                  }),
                "Saved.",
              )
            }
            className="w-7 h-7 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer"
            aria-label="Fewer listings per day"
          >
            −
          </button>
          <button
            type="button"
            title="Listings per day (the autopilot runs in working hours)"
            onClick={() =>
              void act(
                () =>
                  link.commands.updateStore(store.id, {
                    listingsPerDay: Math.min(20, settings.listingsPerDay + 1),
                  }),
                "Saved.",
              )
            }
            className="w-7 h-7 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer"
            aria-label="More listings per day"
          >
            +
          </button>
          <button
            type="button"
            onClick={() =>
              void act(
                () => link.commands.updateStore(store.id, { paused: !settings.paused }),
                settings.paused ? "Resumed." : "Paused: no new listings.",
              )
            }
            className={`h-7 px-2 rounded-md border cursor-pointer ${
              settings.paused
                ? "border-[#69e08a]/60 text-[#69e08a]"
                : "border-[#ff5f6d]/50 text-[#ff5f6d]"
            }`}
            title={settings.paused ? "Resume this store" : "Kill switch: stop new listings"}
          >
            {settings.paused ? "Resume" : "Pause"}
          </button>
        </div>
        <div className="text-[10px] text-dim">
          Packages {store.packages.length}
          {pending > 0 ? ` · ${pending} waiting at your Desk` : ""}
        </div>
        {store.packages.length > 0 && (
          <ul className="space-y-1">
            {store.packages.slice(0, 4).map((p) => (
              <PackageRow key={p.id} ctx={ctx} meta={p} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function PackageRow({ ctx, meta }: { ctx: Ctx; meta: ArtifactMeta }) {
  const { link, ui, now } = ctx;
  const mockup = (meta.info?.mockups as string[] | undefined)?.[0];
  const review = meta.review ?? "pending";
  const published = meta.info?.published as { mode?: string } | undefined;
  return (
    <li>
      <button
        type="button"
        onClick={() => ui.set({ viewing: meta.id })}
        className="w-full flex gap-2 items-center text-left rounded-md hover:bg-white/10 p-1 cursor-pointer"
      >
        {mockup ? (
          <img
            src={link.commands.fileUrl(mockup)}
            alt=""
            loading="lazy"
            className="w-10 h-10 rounded object-cover shrink-0 bg-white/10"
          />
        ) : (
          <span className="w-10 h-10 rounded bg-white/10 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px]" title={meta.title}>
            {meta.title}
          </span>
          <span className="block text-[10px] text-dim">
            ${Number(meta.info?.price ?? 0).toFixed(2)} · QA {String(meta.info?.qa ?? "?")} · IP{" "}
            {String(meta.info?.ip ?? "?")} · {ago(now - meta.createdAt)} ago ·{" "}
            <span style={{ color: REVIEW_COLOR[review] }}>{review}</span>
            {published && (
              <span className="text-cyan">
                {" "}
                · published{published.mode === "dry-run" ? " (dry run)" : ""}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
