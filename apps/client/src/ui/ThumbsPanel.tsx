import { useCallback, useEffect, useState } from "react";
import type { ThumbJobInfo } from "../sim/link";
import type { Ctx } from "./App";
import { Panel, Section } from "./Panel";

/**
 * Factory 2, the Thumbnail Studio (ROADMAP Stage 8): a brief becomes three 1280×720 thumbnails
 * (curiosity, emotion, contrast) checked at phone size; a note sends them back for a revision.
 */
export function ThumbsPanel({ ctx }: { ctx: Ctx }) {
  const { link, ui } = ctx;
  const live = link.kind === "server";
  const [jobs, setJobs] = useState<ThumbJobInfo[] | null>(null);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [colors, setColors] = useState<string[]>(["#ffe14d", "#ff3d5a"]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    link.commands
      .thumbJobs()
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [link]);

  useEffect(() => {
    if (!live) return;
    load();
    const timer = window.setInterval(load, 3_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const submit = async () => {
    if (title.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      await link.commands.startThumbs({
        title: title.trim(),
        ...(topic.trim() ? { topic: topic.trim() } : {}),
        ...(style.trim() ? { channelStyle: style.trim() } : {}),
        brandColors: colors,
        ...(photo ? { facePhoto: photo } : {}),
      });
      ui.toast("Flash is on it: three thumbnails coming.");
      setTitle("");
      setTopic("");
      setPhoto(null);
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const readPhoto = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      ui.toast("That photo is over 8 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  };

  const field =
    "w-full bg-black/30 border border-white/15 rounded px-2 py-1 text-ink outline-none focus:border-cyan/70";
  return (
    <Panel
      title="Thumbnails"
      accent="#ff3d5a"
      onClose={() => ui.set({ panel: null })}
      header={
        <div>
          <div className="text-[16px] font-bold text-[#ff6b81]">Factory 2: Thumbnails</div>
          <div className="text-dim text-[11px]">
            A brief becomes three 1280×720 thumbnails, checked at phone size.
          </div>
        </div>
      }
    >
      <Section title="New brief">
        <div className="space-y-1.5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Video title"
            aria-label="Video title"
            disabled={!live || busy}
            className={field}
          />
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={2}
            placeholder="What happens in the video (optional)"
            aria-label="Topic"
            disabled={!live || busy}
            className={`${field} resize-y`}
          />
          <input
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="Channel style, e.g. bold tech reviews (optional)"
            aria-label="Channel style"
            disabled={!live || busy}
            className={field}
          />
          <div className="flex items-center gap-2 text-[11px] text-dim">
            Brand colours
            {colors.map((c, i) => (
              <input
                key={`colour-${i === 0 ? "main" : "accent"}`}
                type="color"
                value={c}
                onChange={(e) => setColors(colors.map((x, j) => (j === i ? e.target.value : x)))}
                aria-label={i === 0 ? "Main colour" : "Accent colour"}
                className="w-7 h-6 bg-transparent cursor-pointer"
              />
            ))}
          </div>
          <label className="block text-[11px] text-dim">
            Client photo (optional, cut out and placed on each)
            <input
              type="file"
              accept="image/png,image/jpeg"
              disabled={!live || busy}
              onChange={(e) => readPhoto(e.target.files?.[0])}
              className="block w-full text-[11px] mt-0.5"
            />
          </label>
          {photo && (
            <img src={photo} alt="Client" className="h-16 rounded border border-white/10" />
          )}
          <button
            type="button"
            disabled={!live || busy || title.trim().length < 3}
            onClick={() => void submit()}
            className="w-full h-8 rounded-md border border-[#ff6b81]/60 bg-[#ff6b81]/15 text-[#ff6b81] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {busy ? "Sending…" : "Make 3 thumbnails"}
          </button>
        </div>
      </Section>

      <Section title={`Jobs (${jobs?.length ?? 0})`}>
        {!live ? (
          <div className="text-dim">Needs the station server (npm run dev).</div>
        ) : jobs === null ? (
          <div className="text-dim">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="text-dim">No briefs yet.</div>
        ) : (
          <ul className="space-y-2">
            {jobs.slice(0, 6).map((j) => (
              <JobCard key={j.id} ctx={ctx} job={j} reload={load} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Gig kit">
        <button
          type="button"
          disabled={!live}
          onClick={() =>
            link.commands
              .gigKit()
              .then((meta) => ui.set({ viewing: meta.id }))
              .catch((err: unknown) => ui.toast(err instanceof Error ? err.message : String(err)))
          }
          className="w-full h-7 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer disabled:opacity-40"
          title="Fiverr gig title, description, FAQ, pricing tiers and a portfolio"
        >
          Write the Fiverr gig kit
        </button>
        <div className="text-dim text-[10px] mt-1">
          Fiverr has no seller API: you post the gig and deliver by hand.
        </div>
      </Section>
    </Panel>
  );
}

function JobCard({ ctx, job, reload }: { ctx: Ctx; job: ThumbJobInfo; reload: () => void }) {
  const { link, ui } = ctx;
  const [note, setNote] = useState("");
  const v = job.versions.at(-1);
  const revise = async () => {
    if (note.trim().length < 3) return;
    try {
      await link.commands.reviseThumbs(job.id, note.trim());
      ui.toast("Revising.");
      setNote("");
      reload();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <li className="rounded-lg bg-white/5 border border-white/10 p-2 space-y-1">
      <div className="flex justify-between gap-2 text-[11px]">
        <span className="truncate font-bold" title={job.brief.title}>
          {job.brief.title}
        </span>
        <span
          className={
            job.status === "failed"
              ? "text-[#ff5f6d]"
              : job.running
                ? "text-gold"
                : "text-[#69e08a]"
          }
        >
          {job.running ? "working…" : job.status}
          {v ? ` · v${v.version}` : ""}
          {job.seconds ? ` · ${job.seconds}s` : ""}
        </span>
      </div>
      {job.error && <div className="text-[10px] text-[#ff5f6d]">{job.error}</div>}
      {v && (
        <>
          <div className="grid grid-cols-3 gap-1">
            {v.images.map((img, i) => (
              <button
                key={img}
                type="button"
                onClick={() => ui.set({ viewing: v.deliveryId })}
                className="cursor-pointer"
                title={`${v.concepts[i]?.angle}: ${v.concepts[i]?.hook}`}
              >
                <img
                  src={link.commands.fileUrl(img)}
                  alt={v.concepts[i]?.hook ?? ""}
                  loading="lazy"
                  className="w-full rounded border border-white/10"
                />
                <span className="block text-[9px] text-dim truncate">
                  {v.concepts[i]?.angle} · QA {v.qa[i]?.score ?? "?"}
                </span>
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Revision note, e.g. bigger text on #2"
              aria-label="Revision note"
              className="flex-1 min-w-0 bg-black/30 border border-white/15 rounded px-2 py-1 text-ink text-[11px] outline-none"
            />
            <button
              type="button"
              disabled={job.running || note.trim().length < 3}
              onClick={() => void revise()}
              className="h-7 px-2 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer disabled:opacity-40"
            >
              Revise
            </button>
          </div>
          <a
            href={link.commands.zipUrl(v.deliveryId)}
            className="text-cyan hover:underline text-[10px]"
            download
          >
            Download v{v.version} (ZIP with sources)
          </a>
        </>
      )}
    </li>
  );
}
