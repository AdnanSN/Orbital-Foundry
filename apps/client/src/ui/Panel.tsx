import type { ReactNode } from "react";

/** The right-hand panel frame shared by the inspector and the room panel. */
export function Panel({
  title,
  accent,
  header,
  onClose,
  children,
}: {
  title: string;
  accent: string;
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={title}
      className="panel absolute right-3 top-[76px] w-[320px] max-h-[calc(100%-200px)] overflow-y-auto overflow-x-hidden rounded-xl"
      style={{ borderTopColor: accent, borderTopWidth: 3 }}
    >
      <div className="sticky top-0 bg-panel/95 px-3 pt-3 pb-2 border-b border-white/10 flex items-start justify-between gap-2">
        {header}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          className="w-6 h-6 shrink-0 rounded-md text-dim hover:text-ink hover:bg-white/10 cursor-pointer"
        >
          ×
        </button>
      </div>
      <div className="px-3 py-2 space-y-3">{children}</div>
    </aside>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[10px] font-bold tracking-[0.18em] text-dim mb-1">
        {title.toUpperCase()}
      </h3>
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md bg-white/5 border border-white/10 px-1.5 py-1 text-center">
      <div className="text-[14px] font-bold tabular-nums">{value}</div>
      <div className="text-[10px] text-dim">{label}</div>
    </div>
  );
}
