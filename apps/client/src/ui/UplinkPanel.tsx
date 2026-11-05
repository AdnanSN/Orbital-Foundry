import { useCallback, useEffect, useRef, useState } from "react";
import type { TikTokInfo, TikTokUploadInfo } from "../sim/link";
import type { Ctx } from "./App";
import { Panel, Section } from "./Panel";

const ACCENT = "#ff4d8d";

const STATUS_LABEL: Record<TikTokUploadInfo["status"], string> = {
  uploading: "Uploading…",
  processing: "TikTok is processing…",
  in_inbox: "In your TikTok inbox",
  failed: "Failed",
};

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * The Uplink (ROADMAP Stage 17, TikTok first): connect your TikTok account and send a finished
 * video to your TikTok inbox as a draft. You review and post it yourself in the TikTok app.
 */
export function UplinkPanel({ ctx }: { ctx: Ctx }) {
  const { link, ui } = ctx;
  const live = link.kind === "server";
  const [info, setInfo] = useState<TikTokInfo | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    link.commands
      .tiktok()
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

  const connect = () =>
    run(async () => {
      const here = `${window.location.origin}${window.location.pathname}`;
      window.location.href = await link.commands.tiktokConnect(here);
    });

  const upload = () =>
    run(async () => {
      if (!file) return;
      await link.commands.tiktokUpload(file);
      ui.toast("Sending the video to your TikTok inbox.");
      setFile(null);
      if (input.current) input.current.value = "";
    });

  const account = info?.account;
  const running = info?.uploads.some((u) => u.status === "uploading" || u.status === "processing");
  const button =
    "h-8 px-3 rounded-md border font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default";

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
            Finished videos go to the platforms only when you send them.
          </div>
        </div>
      }
    >
      <Section title="TikTok account">
        {!live ? (
          <div className="text-dim">Needs the station server (npm run dev).</div>
        ) : info === null ? (
          <div className="text-dim">Loading…</div>
        ) : !info.configured ? (
          <div className="text-dim">
            Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to .env, then restart the station.
          </div>
        ) : info.connected ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              {account?.avatarUrl ? (
                <img
                  src={account.avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-10 h-10 rounded-full border border-white/20"
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-white/10" />
              )}
              <div className="min-w-0">
                <div className="font-bold text-ink truncate">
                  {account?.displayName || "Connected account"}
                </div>
                <div className="text-dim text-[11px]">
                  Allowed: {info.scopes.join(", ") || "nothing yet"}
                </div>
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => link.commands.tiktokDisconnect())}
              className={`${button} border-white/20 bg-white/5 text-dim`}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-dim text-[11px]">
              Sign in with TikTok and allow the station to read your basic profile and upload
              drafts. It never posts publicly.
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void connect()}
              className={`${button} w-full`}
              style={{ borderColor: `${ACCENT}99`, background: `${ACCENT}22`, color: ACCENT }}
            >
              {busy ? "Opening TikTok…" : "Connect TikTok"}
            </button>
          </div>
        )}
      </Section>

      {info?.connected && (
        <Section title="Send a video as a draft">
          <div className="space-y-2">
            <div className="text-[12px] text-ink">
              Will upload to:{" "}
              <span className="font-bold">{account?.displayName || "your TikTok account"}</span>
            </div>
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
              disabled={busy || running || !file || info.killed}
              onClick={() => void upload()}
              className={`${button} w-full`}
              style={{ borderColor: `${ACCENT}99`, background: `${ACCENT}22`, color: ACCENT }}
            >
              {busy ? "Sending…" : "Upload to my TikTok inbox"}
            </button>
            <div className="text-dim text-[10px]">
              {info.killed
                ? "The station kill switch is on, so nothing can be sent."
                : "TikTok puts it in your inbox as a draft. Open TikTok to review, edit and post it."}
            </div>
          </div>
        </Section>
      )}

      {info && info.uploads.length > 0 && (
        <Section title="Recent uploads">
          <ul className="space-y-1.5">
            {info.uploads.map((u) => (
              <li key={u.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <div className="flex justify-between gap-2">
                  <span className="truncate text-ink">{u.file}</span>
                  <span
                    className="shrink-0 font-bold"
                    style={{
                      color:
                        u.status === "failed"
                          ? "#ff5f6d"
                          : u.status === "in_inbox"
                            ? "#5dd39e"
                            : ACCENT,
                    }}
                  >
                    {STATUS_LABEL[u.status]}
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
    </Panel>
  );
}
