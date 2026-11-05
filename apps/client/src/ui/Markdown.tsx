import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer for deliverables: headings, lists, tables, code blocks, bold
 * and inline code. Everything is rendered as React text (no raw HTML), so agent output cannot
 * inject markup.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  const next = () => `md-${key++}`;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) body.push(lines[i++] ?? "");
      i += 1;
      blocks.push(
        <pre key={next()} className="bg-black/40 rounded p-2 overflow-x-auto text-[11px]">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const size = level === 1 ? "text-[15px]" : level === 2 ? "text-[13px]" : "text-[12px]";
      blocks.push(
        <div key={next()} className={`${size} font-bold text-gold mt-2`}>
          {inline(heading[2] ?? "")}
        </div>,
      );
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) {
        const cells = (lines[i] ?? "")
          .trim()
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i += 1;
      }
      blocks.push(
        <div key={next()} className="overflow-x-auto">
          <table className="text-[11px] border-collapse">
            <tbody>
              {rows
                .map((r) => ({ key: next(), cells: r.map((c) => ({ key: next(), c })) }))
                .map((row, ri) => (
                  <tr key={row.key} className={ri === 0 ? "font-bold" : ""}>
                    {row.cells.map((cell) => (
                      <td key={cell.key} className="border border-white/15 px-1.5 py-0.5 align-top">
                        {inline(cell.c)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const listRe = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && listRe.test(lines[i] ?? ""))
        items.push(listRe.exec(lines[i++] ?? "")?.[1] ?? "");
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={next()} className={`${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-0.5`}>
          {items
            .map((it) => ({ key: next(), it }))
            .map((item) => (
              <li key={item.key}>{inline(item.it)}</li>
            ))}
        </List>,
      );
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#|```|\s*\||\s*(?:[-*]|\d+[.)])\s)/.test(lines[i] ?? "")
    ) {
      para.push(lines[i++] ?? "");
    }
    blocks.push(<p key={next()}>{inline(para.join(" "))}</p>);
  }
  return <div className="space-y-1.5 leading-relaxed">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    out.push(
      token.startsWith("**") ? (
        <strong key={`b${n++}`}>{token.slice(2, -2)}</strong>
      ) : (
        <code key={`c${n++}`} className="bg-black/40 rounded px-1">
          {token.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
