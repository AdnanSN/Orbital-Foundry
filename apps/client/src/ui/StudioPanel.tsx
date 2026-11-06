import { useCallback, useEffect, useState } from "react";
import {
  BOARD_STEP_NAMES,
  type BoardStepName,
  type StudioBoardInfo,
  type StudioBoardItem,
  withToken,
} from "../sim/link";
import type { Ctx } from "./App";
import { Panel, Section } from "./Panel";

const ACCENT = "#7ce0ff";
const GOOD = "#5dd39e";
const BAD = "#ff5f6d";
const WARN = "#ffb347";

const STEP_LABEL: Record<BoardStepName, string> = {
  idea: "Idea",
  script: "Script",
  voice: "Voice",
  visuals: "Visuals",
  render: "Render",
  screening: "Screening",
  approval: "Approval",
  posted: "Posted",
};

const STATE_COLOR = {
  done: GOOD,
  current: ACCENT,
  failed: BAD,
  todo: "rgba(255,255,255,0.12)",
} as const;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString();
}

function Tile(props: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
      <div className="text-dim text-[10px] uppercase tracking-wide">{props.label}</div>
      <div className="font-bold" style={{ color: props.warn ? WARN : undefined }}>
        {props.value}
      </div>
      {props.note && <div className="text-dim text-[10px]">{props.note}</div>}
    </div>
  );
}

function Meter(props: { label: string; value: number; note: string }) {
  return (
    <div>
      <div className="flex justify-between text-[11px]">
        <span className="text-ink">{props.label}</span>
        <span className="text-dim">{props.note}</span>
      </div>
      <div className="h-1.5 rounded bg-white/10 overflow-hidden">
        <div
          className="h-full rounded"
          style={{ width: pct(Math.min(1, Math.max(0, props.value))), background: ACCENT }}
        />
      </div>
    </div>
  );
}

/** The eight steps from idea to posted, as one segmented bar. */
function Steps({ item }: { item: StudioBoardItem }) {
  return (
    <div className="flex gap-0.5 mt-1" title="From idea to posted">
      {BOARD_STEP_NAMES.map((s) => {
        const state = item.steps[s];
        return (
          <div key={s} className="flex-1 min-w-0" title={`${STEP_LABEL[s]}: ${state}`}>
            <div
              className="h-1.5 rounded-sm"
              style={{
                background: STATE_COLOR[state],
                opacity:
                  state === "current" && item.progress < 100 ? 0.55 + item.progress / 250 : 1,
              }}
            />
            <div
              className="text-[9px] truncate"
              style={{ color: state === "todo" ? "rgba(255,255,255,0.35)" : STATE_COLOR[state] }}
            >
              {STEP_LABEL[s]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Studio (ROADMAP Stage 20): every script and video on its way from idea to posted, with a
 * player, the budgets left, platform status and the production schedule. Approvals happen at the
 * Owner's Desk (or from your phone); this panel shows where everything stands.
 */
export function StudioPanel({ ctx }: { ctx: Ctx }) {
  const { link, ui } = ctx;
  const live = link.kind === "server";
  const [board, setBoard] = useState<StudioBoardInfo | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tests, setTests] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    link.commands
      .studioBoard()
      .then(setBoard)
      .catch(() => setBoard(null));
  }, [link]);

  useEffect(() => {
    if (!live) return;
    load();
    const timer = window.setInterval(load, 4_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const planPosts = async (videoId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await link.commands.planPost(videoId);
      ui.toast("The post plan is at the Owner's Desk.");
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runSchedule = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await link.commands.runSchedule();
      ui.toast(
        r.started.length
          ? `Started ${r.started.length} script(s); they'll wait at the Owner's Desk.`
          : "The pipeline is full for the cadence; nothing new to start.",
      );
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const items = (board?.items ?? []).filter((i) => tests || !i.test);
  const hiddenTests = (board?.items ?? []).filter((i) => i.test).length;
  const b = board?.budgets;
  const yt = board?.numbers?.progress.youtube;
  const tt = board?.numbers?.progress.tiktok;

  return (
    <Panel
      title="Studio"
      accent={ACCENT}
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold" style={{ color: ACCENT }}>
            Studio: from idea to posted
          </div>
          <div className="text-dim text-[11px]">
            You approve scripts, cuts and post plans at the Owner's Desk; the rest runs itself.
          </div>
        </div>
      }
    >
      {!live ? (
        <div className="text-dim">Needs the station server (npm run dev).</div>
      ) : board === null ? (
        <div className="text-dim">Loading…</div>
      ) : (
        <>
          {board.schedule && (
            <Section title="This week">
              <div className="space-y-1.5 text-[12px]">
                {board.schedule.pipeline.map((p) => (
                  <div key={p.channel} className="flex flex-wrap gap-x-3">
                    <span className="font-bold text-ink">
                      {board.channels.find((c) => c.id === p.channel)?.name ?? p.channel}
                    </span>
                    <span className="text-dim">
                      Shorts on the way {p.short}/{p.target.short}
                    </span>
                    <span className="text-dim">
                      Long-form {p.long}/{p.target.long}
                    </span>
                  </div>
                ))}
                <div className="text-dim text-[11px]">
                  {board.schedule.enabled
                    ? `The schedule runs daily at ${String(board.schedule.hour).padStart(2, "0")}:00 and has started ${board.schedule.startedToday} script(s) today.`
                    : "The schedule is off (config/studio.yaml)."}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runSchedule()}
                  className="h-7 px-2.5 rounded-md border font-bold text-[11px] cursor-pointer disabled:opacity-40"
                  style={{ borderColor: `${ACCENT}99`, background: `${ACCENT}22`, color: ACCENT }}
                >
                  {busy ? "Starting…" : "Run today's schedule now"}
                </button>
              </div>
            </Section>
          )}

          {b && (
            <Section title="Budgets left">
              <div className="grid grid-cols-2 gap-1.5 text-[12px]">
                <Tile
                  label="ElevenLabs credits"
                  value={
                    b.elevenlabs.creditsLeft === null
                      ? "unknown"
                      : compact(b.elevenlabs.creditsLeft)
                  }
                  note={`${compact(b.elevenlabs.usedThisMonth)} used this month${b.elevenlabs.budget ? ` of ${compact(b.elevenlabs.budget)}` : ""}`}
                  warn={b.elevenlabs.creditsLeft !== null && b.elevenlabs.creditsLeft < 10_000}
                />
                <Tile
                  label="AI stills today"
                  value={String(b.stills.madeToday)}
                  note="Cloudflare's free daily images"
                />
                <Tile
                  label="GPU queue"
                  value={`${b.gpu.counts.queued ?? 0} queued, ${b.gpu.counts.running ?? 0} running`}
                  note={
                    b.gpu.ready.length
                      ? `ready: ${b.gpu.ready.join(", ")}`
                      : "no generator installed (infra/gpu)"
                  }
                />
                <Tile
                  label="Modal this month"
                  value={`$${b.gpu.spend.modal.toFixed(2)} of $${b.gpu.spend.modalCap}`}
                  note="the burst lane's hard cap"
                />
                <Tile
                  label="Free disk"
                  value={b.disk.freeGb === null ? "unknown" : `${b.disk.freeGb} GB`}
                  warn={b.disk.freeGb !== null && b.disk.freeGb < 15}
                />
              </div>
            </Section>
          )}

          {board.posting && (
            <Section title="Platforms">
              <div className="text-[12px] mb-1">
                <span
                  className="font-bold"
                  style={{ color: board.posting.mode === "live" ? GOOD : WARN }}
                >
                  {board.posting.mode === "live" ? "Posting live" : "Dry run"}
                </span>
                {board.posting.killed && (
                  <span className="font-bold ml-2" style={{ color: BAD }}>
                    Kill switch on
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                {board.posting.platforms.map((p) => (
                  <Tile
                    key={p.platform}
                    label={p.platform}
                    value={p.connected ? "connected" : "upload kits"}
                    note={`${p.today}/${p.dailyCap} today`}
                  />
                ))}
              </div>
            </Section>
          )}

          {(yt || tt) && (
            <Section title="Toward monetisation">
              <div className="space-y-1.5">
                {yt && (
                  <>
                    <Meter
                      label="YouTube, 500-subscriber tier"
                      value={yt.tiers.early}
                      note={`${yt.subscribers} subs, ${compact(yt.watchHours12m)} h, ${compact(yt.shortsViews90d)} Shorts views`}
                    />
                    <Meter
                      label="YouTube ad revenue"
                      value={yt.tiers.full}
                      note={pct(yt.tiers.full)}
                    />
                    <Meter
                      label="New applicants from 2027"
                      value={yt.tiers.from2027}
                      note={pct(yt.tiers.from2027)}
                    />
                  </>
                )}
                {tt && (
                  <Meter
                    label="TikTok Creator Rewards"
                    value={tt.rewards}
                    note={`${compact(tt.followers)} followers, ${compact(tt.views30d)} views (30 d); videos over ${tt.minVideoSeconds} s only`}
                  />
                )}
              </div>
            </Section>
          )}

          <Section title="Videos">
            {items.length === 0 ? (
              <div className="text-dim text-[12px]">
                Nothing yet. Approve a script at the Owner's Desk, or run the schedule.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {items.map((i) => (
                  <li key={i.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                    <div className="flex justify-between gap-2">
                      <button
                        type="button"
                        className="truncate text-left text-ink font-bold cursor-pointer disabled:cursor-default"
                        disabled={!i.hasFile}
                        onClick={() => setOpen(open === i.id ? null : i.id)}
                        title={i.hasFile ? "Play it" : undefined}
                      >
                        {i.title}
                      </button>
                      <span className="shrink-0 text-[10px] text-dim">
                        {i.id} ·{" "}
                        {i.format === "long"
                          ? "long-form"
                          : i.kind === "cutdown"
                            ? "cut-down"
                            : "short"}
                        {i.test ? " · test" : ""}
                      </span>
                    </div>
                    <Steps item={i} />
                    <div
                      className="text-[11px] mt-0.5"
                      style={{ color: i.status.startsWith("Failed") ? BAD : undefined }}
                    >
                      <span className={i.status.startsWith("Failed") ? "" : "text-dim"}>
                        {i.status}
                      </span>
                      {i.steps.render === "current" ||
                      i.steps.visuals === "current" ||
                      i.steps.voice === "current" ||
                      i.steps.screening === "current"
                        ? ` · ${Math.round(i.progress)}%`
                        : ""}
                    </div>
                    {i.voice?.fallback && !i.test && (
                      <div className="text-[11px]" style={{ color: WARN }}>
                        Voiced by Kokoro, not the channel voice ({i.voice.fallback}).
                      </div>
                    )}
                    {i.videoId &&
                      !i.test &&
                      i.steps.approval === "done" &&
                      i.steps.posted === "todo" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void planPosts(i.videoId as string)}
                          className="mt-1 h-6 px-2 rounded border text-[11px] font-bold cursor-pointer disabled:opacity-40"
                          style={{
                            borderColor: `${ACCENT}99`,
                            background: `${ACCENT}22`,
                            color: ACCENT,
                          }}
                        >
                          Plan posts
                        </button>
                      )}
                    {i.posts.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {i.posts.map((p) => (
                          <a
                            key={`${p.platform}-${p.at}`}
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[10px] px-1.5 py-0.5 rounded border border-white/15"
                            style={{
                              color:
                                p.status === "posted" || p.status === "draft" ? GOOD : undefined,
                            }}
                          >
                            {p.platform} {p.status}
                            {p.mode === "dry-run" ? " (dry)" : ""}
                          </a>
                        ))}
                      </div>
                    )}
                    {open === i.id && i.videoId && (
                      // biome-ignore lint/a11y/useMediaCaption: captions are burned into shorts; long-form has an SRT.
                      <video
                        className="w-full rounded mt-1.5 bg-black"
                        controls
                        preload="metadata"
                        poster={withToken(`/api/studio/videos/${i.videoId}/thumbnail`)}
                        src={withToken(`/api/studio/videos/${i.videoId}/file`)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {hiddenTests > 0 && (
              <button
                type="button"
                className="mt-1.5 text-[11px] text-dim underline cursor-pointer"
                onClick={() => setTests(!tests)}
              >
                {tests ? "Hide test renders" : `Show ${hiddenTests} test render(s)`}
              </button>
            )}
          </Section>
        </>
      )}
    </Panel>
  );
}
