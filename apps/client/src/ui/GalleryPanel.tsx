import type { ArtifactMeta, ArtifactReview } from "@orbital/shared";
import { useEffect, useState } from "react";
import type { PipelineRequest, StyleInfo } from "../sim/link";
import type { Ctx } from "./App";
import { ago } from "./format";
import { useUi } from "./store";

const ROOMS: { id: string; label: string }[] = [
  { id: "", label: "All" },
  { id: "factory-1", label: "Etsy POD" },
  { id: "factory-2", label: "Thumbnails" },
  { id: "factory-3", label: "Asset Forge" },
];

const REVIEW_COLOR: Record<ArtifactReview, string> = {
  pending: "#ffd166",
  approved: "#69e08a",
  rejected: "#ff5f6d",
};

interface QaInfo {
  score: number | null;
  pass: boolean;
  defects?: string[];
  notes?: string;
}

const CHECKER = "repeating-conic-gradient(#2a2f45 0% 25%, #1c2033 0% 50%) 50% / 16px 16px";

function qaOf(meta: ArtifactMeta): QaInfo | null {
  const qa = meta.info?.qa;
  return qa && typeof qa === "object" ? (qa as QaInfo) : null;
}

/**
 * The studio gallery (ROADMAP Stage 5): every image the crew or the owner made, per room, with
 * the one-click pipeline (prompt → image → cutout → upscale → QA), side-by-side comparison, and
 * approve or reject. Approving here never publishes anything.
 */
export function GalleryPanel({ ctx }: { ctx: Ctx }) {
  const { world, ui, link } = ctx;
  const room = useUi(ui, (s) => s.galleryRoom);
  const live = link.kind === "server";
  const [fetched, setFetched] = useState<ArtifactMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  useEffect(() => {
    if (!live) return;
    let alive = true;
    link.commands
      .listArtifacts({ kind: "image", limit: 300 })
      .then((list) => alive && setFetched(list))
      .catch((err: unknown) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [link, live]);

  // Live events override what was fetched (new images, reviews, QA scores).
  const merged = new Map<string, ArtifactMeta>();
  for (const a of fetched) merged.set(a.id, a);
  for (const a of world.artifacts.values()) if (a.kind === "image") merged.set(a.id, a);
  const images = [...merged.values()].sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
  const shown = images.filter(
    (a) => (!room || a.room === room) && (!pendingOnly || (a.review ?? "pending") === "pending"),
  );
  const byId = new Map(images.map((a) => [a.id, a]));
  const toggleCompare = (id: string) =>
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-2)));

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-auto">
      <div className="panel rounded-xl w-[min(1100px,calc(100%-24px))] h-[calc(100%-110px)] flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-white/10 flex-wrap">
          <div className="text-[16px] font-bold text-[#69e08a] mr-2">Gallery</div>
          {ROOMS.map((r) => (
            <button
              key={r.id || "all"}
              type="button"
              onClick={() => ui.set({ galleryRoom: r.id })}
              className={`h-6 px-2 rounded-md border text-[11px] cursor-pointer ${
                room === r.id
                  ? "border-cyan/70 bg-cyan/15 text-cyan"
                  : "border-white/15 hover:bg-white/10"
              }`}
            >
              {r.label}
            </button>
          ))}
          <label className="flex items-center gap-1 text-[11px] text-dim ml-1 cursor-pointer">
            <input
              type="checkbox"
              checked={pendingOnly}
              onChange={(e) => setPendingOnly(e.target.checked)}
            />
            Pending only
          </label>
          <span className="flex-1" />
          {compare.length === 2 && (
            <button
              type="button"
              onClick={() => setOpen("compare")}
              className="h-6 px-2 rounded-md border border-cyan/60 text-cyan text-[11px] cursor-pointer"
            >
              Compare {compare.join(" / ")}
            </button>
          )}
          <button
            type="button"
            onClick={() => ui.set({ panel: null })}
            aria-label="Close"
            className="w-7 h-7 rounded-md text-dim hover:text-ink hover:bg-white/10 cursor-pointer"
          >
            ×
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <PipelineForm ctx={ctx} room={room} />
          <div className="flex-1 min-w-0 overflow-y-auto p-3">
            {!live ? (
              <div className="text-dim">The gallery needs the station server (npm run dev).</div>
            ) : error ? (
              <div className="text-[#ff5f6d]">{error}</div>
            ) : open === "compare" ? (
              <Compare ctx={ctx} ids={compare} byId={byId} onBack={() => setOpen(null)} />
            ) : open && byId.get(open) ? (
              <Detail
                ctx={ctx}
                meta={byId.get(open) as ArtifactMeta}
                parent={byId.get(byId.get(open)?.parentId ?? "") ?? null}
                onOpen={setOpen}
                onBack={() => setOpen(null)}
              />
            ) : shown.length === 0 ? (
              <div className="text-dim">
                No images here yet. Run the pipeline on the left, or give the crew an image
                objective.
              </div>
            ) : (
              <ul className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
                {shown.map((a) => (
                  <Card
                    key={a.id}
                    ctx={ctx}
                    meta={a}
                    selected={compare.includes(a.id)}
                    onOpen={() => setOpen(a.id)}
                    onCompare={() => toggleCompare(a.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Thumb({ ctx, meta, className }: { ctx: Ctx; meta: ArtifactMeta; className: string }) {
  return (
    <div
      className={`${className} flex items-center justify-center`}
      style={{ background: CHECKER }}
    >
      <img
        src={ctx.link.commands.fileUrl(meta.id)}
        alt={meta.title}
        loading="lazy"
        className="max-w-full max-h-full object-contain"
        style={{ imageRendering: meta.info?.pixelArt ? "pixelated" : "auto" }}
      />
    </div>
  );
}

function Chips({ meta }: { meta: ArtifactMeta }) {
  const qa = qaOf(meta);
  const review = meta.review ?? "pending";
  return (
    <span className="flex gap-1 flex-wrap">
      <span className="px-1 rounded text-[9px] border border-white/15 text-dim">
        {String(meta.info?.op ?? "image")}
      </span>
      {qa && (
        <span
          className="px-1 rounded text-[9px] font-bold border"
          style={{
            color: qa.pass ? "#69e08a" : "#ff9f43",
            borderColor: qa.pass ? "#69e08a66" : "#ff9f4366",
          }}
          title={qa.notes ?? ""}
        >
          QA {qa.score ?? "–"}
        </span>
      )}
      <span
        className="px-1 rounded text-[9px] border"
        style={{ color: REVIEW_COLOR[review], borderColor: `${REVIEW_COLOR[review]}66` }}
      >
        {review}
      </span>
    </span>
  );
}

function Card({
  ctx,
  meta,
  selected,
  onOpen,
  onCompare,
}: {
  ctx: Ctx;
  meta: ArtifactMeta;
  selected: boolean;
  onOpen: () => void;
  onCompare: () => void;
}) {
  return (
    <li
      className={`rounded-lg border bg-white/5 overflow-hidden ${
        selected ? "border-cyan/80" : "border-white/10"
      }`}
    >
      <button type="button" onClick={onOpen} className="block w-full cursor-pointer">
        <Thumb ctx={ctx} meta={meta} className="h-32" />
      </button>
      <div className="px-1.5 py-1 space-y-0.5">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-[11px]" title={meta.title}>
            {meta.title}
          </span>
          <input
            type="checkbox"
            checked={selected}
            onChange={onCompare}
            title="Compare"
            aria-label={`Compare ${meta.id}`}
          />
        </div>
        <div className="text-dim text-[10px]">
          {meta.id} · {String(meta.info?.width ?? "?")}×{String(meta.info?.height ?? "?")}
        </div>
        <Chips meta={meta} />
      </div>
    </li>
  );
}

function Detail({
  ctx,
  meta,
  parent,
  onOpen,
  onBack,
}: {
  ctx: Ctx;
  meta: ArtifactMeta;
  parent: ArtifactMeta | null;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const { link, ui, world, now } = ctx;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const qa = qaOf(meta);
  const ip = meta.info?.ip as { verdict?: string } | undefined;
  const act = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      ui.toast(done);
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const facts: [string, string][] = [
    ["Made by", `${world.name(meta.createdBy)} · ${ago(now - meta.createdAt)} ago`],
    [
      "Size",
      `${String(meta.info?.width)}×${String(meta.info?.height)} · ${Math.round(meta.size / 1024)} KB`,
    ],
    [
      "Step",
      `${String(meta.info?.op ?? "?")}${meta.info?.method ? ` (${String(meta.info.method)})` : ""}`,
    ],
  ];
  if (meta.info?.prompt) facts.push(["Prompt", String(meta.info.prompt)]);
  if (meta.info?.style) facts.push(["Style", String(meta.info.style)]);
  if (meta.info?.endpoint)
    facts.push(["Endpoint", `${String(meta.info.endpoint)} (${String(meta.info.lane)})`]);
  if (meta.info?.seed !== undefined && meta.info?.seed !== null)
    facts.push(["Seed", String(meta.info.seed)]);
  if (meta.taskId) facts.push(["Task", meta.taskId]);
  if (ip?.verdict) facts.push(["IP screen", ip.verdict]);
  return (
    <div className="flex gap-3 h-full min-h-0">
      <Thumb ctx={ctx} meta={meta} className="flex-1 min-w-0 rounded-lg" />
      <div className="w-[260px] shrink-0 overflow-y-auto space-y-2">
        <button
          type="button"
          onClick={onBack}
          className="text-cyan hover:underline cursor-pointer text-[11px]"
        >
          ← All images
        </button>
        <div className="font-bold text-gold">{meta.title}</div>
        <Chips meta={meta} />
        <dl className="text-[11px] space-y-0.5">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt className="inline text-dim">{k}: </dt>
              <dd className="inline break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {parent && (
          <button
            type="button"
            onClick={() => onOpen(parent.id)}
            className="text-cyan hover:underline cursor-pointer text-[11px]"
          >
            Made from {parent.id}: {parent.title}
          </button>
        )}
        {qa && (
          <div className="rounded-md bg-white/5 border border-white/10 p-1.5 text-[11px]">
            <div className="font-bold" style={{ color: qa.pass ? "#69e08a" : "#ff9f43" }}>
              QA {qa.pass ? "pass" : "fail"} {qa.score !== null ? `· ${qa.score}/10` : ""}
            </div>
            {qa.defects && qa.defects.length > 0 && (
              <ul className="list-disc pl-4">
                {qa.defects.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
            {qa.notes && <div className="text-dim">{qa.notes}</div>}
          </div>
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          aria-label="Review note"
          className="w-full bg-black/30 border border-white/15 rounded px-2 py-1 text-ink text-[11px] outline-none"
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                () => link.commands.reviewArtifact(meta.id, "approved", note || undefined),
                "Approved.",
              )
            }
            className="flex-1 h-7 rounded-md border border-[#69e08a]/60 bg-[#69e08a]/15 text-[#69e08a] font-bold cursor-pointer disabled:opacity-40"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                () => link.commands.reviewArtifact(meta.id, "rejected", note || undefined),
                "Rejected.",
              )
            }
            className="flex-1 h-7 rounded-md border border-[#ff5f6d]/50 text-[#ff5f6d] cursor-pointer disabled:opacity-40"
          >
            Reject
          </button>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => link.commands.qaArtifact(meta.id), "QA done.")}
          className="w-full h-7 rounded-md border border-white/15 hover:bg-white/10 cursor-pointer disabled:opacity-40"
        >
          {busy ? "Working…" : "Run QA again"}
        </button>
        <a
          href={link.commands.fileUrl(meta.id)}
          target="_blank"
          rel="noreferrer"
          className="block text-cyan hover:underline text-[11px]"
        >
          Open the full-size PNG
        </a>
        <div className="text-dim text-[10px]">
          Approving keeps it for listings; nothing is published.
        </div>
      </div>
    </div>
  );
}

function Compare({
  ctx,
  ids,
  byId,
  onBack,
}: {
  ctx: Ctx;
  ids: string[];
  byId: Map<string, ArtifactMeta>;
  onBack: () => void;
}) {
  return (
    <div className="h-full flex flex-col gap-2">
      <button
        type="button"
        onClick={onBack}
        className="text-cyan hover:underline cursor-pointer text-[11px] self-start"
      >
        ← All images
      </button>
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-2">
        {ids.map((id) => {
          const meta = byId.get(id);
          if (!meta) return null;
          return (
            <div key={id} className="flex flex-col min-h-0 gap-1">
              <Thumb ctx={ctx} meta={meta} className="flex-1 min-h-0 rounded-lg" />
              <div className="text-[11px] truncate">
                {id} · {meta.title}
              </div>
              <Chips meta={meta} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PipelineForm({ ctx, room }: { ctx: Ctx; room: string }) {
  const { link, ui } = ctx;
  const live = link.kind === "server";
  const [styles, setStyles] = useState<StyleInfo[]>([]);
  const [aspects, setAspects] = useState<string[]>([]);
  const [form, setForm] = useState<PipelineRequest>({
    prompt: "",
    style: "pod-design",
    upscale: 4,
    cutout: "auto",
    qa: true,
  });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    link.commands
      .creativeStyles()
      .then((r) => {
        setStyles(r.styles);
        setAspects(r.aspects);
      })
      .catch(() => {});
  }, [link, live]);
  const style = styles.find((s) => s.id === form.style);
  const run = async () => {
    if (form.prompt.trim().length < 3 || busy) return;
    setBusy(true);
    setLast(null);
    try {
      const res = await link.commands.runPipeline({
        ...form,
        prompt: form.prompt.trim(),
        ...(room ? { room } : { room: "factory-1" }),
      });
      const qa = qaOf(res.final);
      setLast(
        `${res.steps.map((s) => s.id).join(" → ")}${qa ? ` · QA ${qa.score ?? "–"} ${qa.pass ? "pass" : "fail"}` : ""}`,
      );
      ui.toast("Pipeline done.");
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const field = "w-full bg-black/30 border border-white/15 rounded px-2 py-1 text-ink outline-none";
  return (
    <div className="w-[250px] shrink-0 border-r border-white/10 p-3 space-y-2 overflow-y-auto">
      <div className="text-[10px] font-bold tracking-[0.18em] text-dim">ONE-CLICK PIPELINE</div>
      <textarea
        value={form.prompt}
        onChange={(e) => setForm({ ...form, prompt: e.target.value })}
        rows={4}
        disabled={!live || busy}
        placeholder="Subject, e.g. a fox curled up in the snow"
        aria-label="Prompt"
        className={`${field} resize-y`}
      />
      <label className="block text-[11px] text-dim">
        Style
        <select
          value={form.style ?? ""}
          onChange={(e) => {
            const { aspect: _drop, ...rest } = form;
            setForm({ ...rest, style: e.target.value || undefined });
          }}
          disabled={!live || busy}
          className={field}
        >
          <option value="">(none: the prompt as written)</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
      </label>
      {style && <div className="text-dim text-[10px]">{style.description}</div>}
      <div className="grid grid-cols-2 gap-1.5">
        <label className="block text-[11px] text-dim">
          Aspect
          <select
            value={form.aspect ?? ""}
            onChange={(e) => {
              const { aspect: _drop, ...rest } = form;
              setForm(e.target.value ? { ...rest, aspect: e.target.value } : rest);
            }}
            disabled={!live || busy}
            className={field}
          >
            <option value="">{style ? `style (${style.aspect})` : "1:1"}</option>
            {aspects.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[11px] text-dim">
          Upscale
          <select
            value={form.upscale}
            onChange={(e) => setForm({ ...form, upscale: Number(e.target.value) as 0 | 2 | 4 })}
            disabled={!live || busy}
            className={field}
          >
            <option value={4}>4×</option>
            <option value={2}>2×</option>
            <option value={0}>none</option>
          </select>
        </label>
      </div>
      <label className="block text-[11px] text-dim">
        Cutout
        <select
          value={form.cutout}
          onChange={(e) =>
            setForm({ ...form, cutout: e.target.value as PipelineRequest["cutout"] })
          }
          disabled={!live || busy}
          className={field}
        >
          <option value="auto">{style ? `style (${style.cutout})` : "auto"}</option>
          <option value="none">none</option>
          <option value="edges">edges (plain backgrounds)</option>
          <option value="chroma">chroma key</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-dim cursor-pointer">
        <input
          type="checkbox"
          checked={form.qa}
          onChange={(e) => setForm({ ...form, qa: e.target.checked })}
          disabled={!live || busy}
        />
        Vision QA score
      </label>
      <button
        type="button"
        disabled={!live || busy || form.prompt.trim().length < 3}
        onClick={() => void run()}
        className="w-full h-8 rounded-md border border-[#69e08a]/60 bg-[#69e08a]/15 text-[#69e08a] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default"
      >
        {busy ? "Running (about a minute)…" : "Run pipeline"}
      </button>
      {last && <div className="text-[10px] text-dim break-words">{last}</div>}
      <div className="text-dim text-[10px]">
        Sandbox lane: images are for review and testing, never sold. Upscales use the built-in
        resampler until Real-ESRGAN is installed.
      </div>
    </div>
  );
}
