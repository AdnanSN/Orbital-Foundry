import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { PlatformId, PostInfo, TikTokUploadInfo, UplinkInfo } from "../sim/link";
import type { Ctx } from "./App";
import { Panel, Section } from "./Panel";

const ACCENT = "#ff4d8d";
const GOOD = "#5dd39e";
const BAD = "#ff5f6d";

const NAMES: Record<PlatformId, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

const UPLOAD_LABEL: Record<TikTokUploadInfo["status"], string> = {
  uploading: "Uploading…",
  processing: "TikTok is processing…",
  in_inbox: "In your TikTok inbox",
  unconfirmed: "Check TikTok",
  failed: "Failed",
};

const POST_LABEL: Record<PostInfo["status"], string> = {
  awaiting: "Waiting for your approval",
  scheduled: "Scheduled",
  posting: "Posting…",
  posted: "Posted",
  draft: "In your TikTok inbox",
  kit: "Upload kit ready",
  held: "Held",
  failed: "Failed",
  cancelled: "Cancelled",
};

function postColor(status: PostInfo["status"]): string {
  if (status === "failed") return BAD;
  if (status === "posted" || status === "draft") return GOOD;
  if (status === "cancelled") return "#8a8fa3";
  return ACCENT;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const BUTTON =
  "h-8 px-3 rounded-md border font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default";
const SMALL =
  "h-6 px-2 rounded border border-white/20 bg-white/5 text-[11px] font-bold text-ink cursor-pointer disabled:opacity-40 inline-flex items-center";
const accentStyle = { borderColor: `${ACCENT}99`, background: `${ACCENT}22`, color: ACCENT };

function Account(props: {
  name: string;
  configured: boolean;
  connected: boolean;
  who?: string | undefined;
  note?: string | undefined;
  setup: string;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-ink">{props.name}</div>
          <div className="text-dim text-[11px] truncate">
            {!props.configured
              ? props.setup
              : props.connected
                ? props.who || "Connected"
                : "Not connected: posts become upload kits"}
          </div>
        </div>
        {props.configured &&
          (props.connected ? (
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onDisconnect}
              className={SMALL}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onConnect}
              className={`${SMALL} shrink-0`}
              style={accentStyle}
            >
              Connect
            </button>
          ))}
      </div>
      {props.note && props.connected && (
        <div className="text-dim text-[10px] mt-0.5">{props.note}</div>
      )}
    </div>
  );
}

/**
 * The Uplink (ROADMAP Stage 17): the platform accounts, the posting mode and kill switch, and every
 * post. Approved videos get a post plan at the Owner's Desk; approving the plan posts them. You
 * can also send a video to your TikTok inbox as a draft by hand.
 */
export function UplinkPanel({ ctx }: { ctx: Ctx }) {
  const { link, ui } = ctx;
  const live = link.kind === "server";
  const [info, setInfo] = useState<UplinkInfo | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    link.commands
      .uplink()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [link]);

  useEffect(() => {
    if (!live) return;
    load();
    const timer = window.setInterval(load, 3_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const here = () => `${window.location.origin}${window.location.pathname}`;
  const connect = (platform: PlatformId) =>
    run(async () => {
      window.location.href =
        platform === "tiktok"
          ? await link.commands.tiktokConnect(here())
          : await link.commands.platformConnect(platform, here());
    });
  const disconnect = (platform: PlatformId) =>
    run(() =>
      platform === "tiktok"
        ? link.commands.tiktokDisconnect()
        : link.commands.platformDisconnect(platform),
    );

  const upload = () =>
    run(async () => {
      if (!file) return;
      await link.commands.tiktokUpload(file);
      ui.toast("Sending the video to your TikTok inbox.");
      setFile(null);
      if (input.current) input.current.value = "";
    });

  const pub = info?.publisher ?? null;
  const tiktok = info?.tiktok ?? null;
  const yt = info?.youtube ?? null;
  const ig = info?.instagram ?? null;
  const running = tiktok?.uploads.some(
    (u) => u.status === "uploading" || u.status === "processing",
  );

  let body: ReactNode;
  if (!live) body = <div className="text-dim">Needs the station server (npm run dev).</div>;
  else if (info === null) body = <div className="text-dim">Loading…</div>;

  return (
    <Panel
      title="Uplink"
      accent={ACCENT}
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold" style={{ color: ACCENT }}>
            Uplink: posting
          </div>
          <div className="text-dim text-[11px]">
            Nothing reaches a platform until you approve its post plan.
          </div>
        </div>
      }
    >
      {body ?? (
        <>
          {pub && (
            <Section title="Posting">
              <div className="space-y-1.5">
                <div className="text-[12px]">
                  <span
                    className="font-bold"
                    style={{ color: pub.mode === "live" ? GOOD : ACCENT }}
                  >
                    {pub.mode === "live" ? "Live" : "Dry run"}
                  </span>
                  <span className="text-dim">
                    {pub.mode === "live"
                      ? ": approved post plans really post."
                      : ": approved plans are recorded and nothing is sent. PUBLISH_MODE=live in .env posts for real."}
                  </span>
                </div>
                {pub.killed && (
                  <div className="text-[12px] font-bold" style={{ color: BAD }}>
                    The kill switch is on: nothing goes out, and scheduled posts are held.
                  </div>
                )}
                <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                  {pub.platforms.map((p) => (
                    <div
                      key={p.platform}
                      className="rounded border border-white/10 bg-black/20 px-2 py-1"
                    >
                      <div className="font-bold text-ink">{NAMES[p.platform]}</div>
                      <div className="text-dim">
                        {!p.enabled ? "off" : p.connected ? "connected" : "kits"} · {p.today}/
                        {p.dailyCap} today
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          )}

          <Section title="Accounts">
            <div className="space-y-1.5">
              {yt && (
                <Account
                  name="YouTube"
                  configured={yt.configured}
                  connected={yt.connected}
                  who={yt.channel?.title}
                  note={`Today: ${yt.quota.uploads}/${yt.quota.limits.uploads} uploads, ${yt.quota.units.toLocaleString()}/${yt.quota.limits.units.toLocaleString()} quota units.`}
                  setup="Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env"
                  busy={busy}
                  onConnect={() => void connect("youtube")}
                  onDisconnect={() => void disconnect("youtube")}
                />
              )}
              {ig && (
                <Account
                  name="Instagram"
                  configured={ig.configured}
                  connected={ig.connected}
                  who={ig.account?.username ? `@${ig.account.username}` : undefined}
                  note={
                    ig.expiresAt
                      ? `The sign-in renews itself (valid until ${new Date(ig.expiresAt).toLocaleDateString()}).`
                      : undefined
                  }
                  setup="Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to .env"
                  busy={busy}
                  onConnect={() => void connect("instagram")}
                  onDisconnect={() => void disconnect("instagram")}
                />
              )}
              {tiktok && (
                <Account
                  name="TikTok"
                  configured={tiktok.configured}
                  connected={tiktok.connected}
                  who={tiktok.account?.displayName}
                  note="Drafts land in your TikTok inbox; you post them in the app."
                  setup="Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to .env"
                  busy={busy}
                  onConnect={() => void connect("tiktok")}
                  onDisconnect={() => void disconnect("tiktok")}
                />
              )}
            </div>
          </Section>

          {pub && pub.posts.length > 0 && (
            <Section title="Posts">
              <ul className="space-y-1.5">
                {pub.posts.map((p) => (
                  <li key={p.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                    <div className="flex justify-between gap-2">
                      <span className="truncate text-ink">
                        <span className="font-bold">{NAMES[p.platform]}</span> · {p.title}
                      </span>
                      <span className="shrink-0 font-bold" style={{ color: postColor(p.status) }}>
                        {POST_LABEL[p.status]}
                      </span>
                    </div>
                    <div className="text-dim text-[11px]">
                      {p.videoId} · {when(p.at)}
                      {p.mode === "dry-run" ? " · dry run" : ""}
                      {p.detail ? ` · ${p.detail}` : ""}
                    </div>
                    {p.warnings.length > 0 && (
                      <div className="text-[11px]" style={{ color: "#ffb347" }}>
                        {p.warnings.join(" ")}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {p.url && (
                        <a href={p.url} target="_blank" rel="noreferrer" className={SMALL}>
                          Open
                        </a>
                      )}
                      {p.status === "kit" && (
                        <a href={link.commands.kitUrl(p.id)} className={SMALL}>
                          Download kit
                        </a>
                      )}
                      {(p.status === "held" || p.status === "failed") && (
                        <button
                          type="button"
                          disabled={busy || pub.killed}
                          className={SMALL}
                          onClick={() => void run(() => link.commands.postAction(p.id, "resume"))}
                        >
                          Resume
                        </button>
                      )}
                      {["awaiting", "scheduled", "held", "kit", "failed"].includes(p.status) && (
                        <button
                          type="button"
                          disabled={busy}
                          className={SMALL}
                          onClick={() => void run(() => link.commands.postAction(p.id, "cancel"))}
                        >
                          Cancel
                        </button>
                      )}
                      {p.status === "cancelled" && (
                        <button
                          type="button"
                          disabled={busy}
                          className={SMALL}
                          onClick={() =>
                            void run(async () => {
                              await link.commands.planPost(p.videoId, { platforms: [p.platform] });
                              ui.toast("A new post plan is at the Owner's Desk.");
                            })
                          }
                        >
                          Plan again
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {tiktok?.connected && (
            <Section title="Send any video to TikTok as a draft">
              <div className="space-y-2">
                <input
                  ref={input}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  aria-label="Video file"
                  disabled={busy || running}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-[12px] text-dim file:mr-2 file:rounded file:border file:border-white/20 file:bg-white/10 file:text-ink file:px-2 file:py-1"
                />
                {file && (
                  <div className="text-dim text-[11px]">
                    {file.name}, {size(file.size)}
                  </div>
                )}
                <button
                  type="button"
                  disabled={busy || running || !file || tiktok.killed}
                  onClick={() => void upload()}
                  className={`${BUTTON} w-full`}
                  style={accentStyle}
                >
                  {busy ? "Sending…" : "Upload to my TikTok inbox"}
                </button>
                <div className="text-dim text-[10px]">
                  {tiktok.killed
                    ? "The station kill switch is on, so nothing can be sent."
                    : "TikTok puts it in your inbox as a draft. Open TikTok to review, edit and post it."}
                </div>
              </div>
            </Section>
          )}

          {tiktok && tiktok.uploads.length > 0 && (
            <Section title="TikTok uploads">
              <ul className="space-y-1.5">
                {tiktok.uploads.map((u) => (
                  <li key={u.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                    <div className="flex justify-between gap-2">
                      <span className="truncate text-ink">{u.file}</span>
                      <span
                        className="shrink-0 font-bold"
                        style={{
                          color:
                            u.status === "failed" ? BAD : u.status === "in_inbox" ? GOOD : ACCENT,
                        }}
                      >
                        {UPLOAD_LABEL[u.status]}
                      </span>
                    </div>
                    <div className="text-dim text-[11px]">
                      {size(u.bytes)} · {new Date(u.updatedAt).toLocaleString()}
                      {u.detail && u.status !== "uploading" ? ` · ${u.detail}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </Panel>
  );
}
