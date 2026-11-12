import type { ReactNode } from "react";

const inline = (p: string, j: number) =>
  p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
    <b key={j}>{p.slice(2, -2)}</b>
  ) : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? (
    <i key={j}>{p.slice(1, -1)}</i>
  ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
    <code key={j} className="rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[0.85em]">{p.slice(1, -1)}</code>
  ) : (
    p
  );

const spans = (text: string) => text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g).map(inline);

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const cells = (line: string) => line.trim().slice(1, -1).split("|").map((c) => c.trim());

function Table({ rows, k }: { rows: string[]; k: number }) {
  const [head, ...body] = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)); // drop the |---| separator row
  return (
    <div key={k} className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-sm [&_td]:border-t [&_td]:border-black/10 [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold">
        <thead><tr>{cells(head).map((c, i) => <th key={i}>{spans(c)}</th>)}</tr></thead>
        <tbody>{body.map((r, i) => <tr key={i}>{cells(r).map((c, j) => <td key={j}>{spans(c)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Tiny renderer for what the assistant writes: paragraphs, "- " bullets, | tables |, **bold**, *italic* and `code`. Text only, no HTML or images. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i])) {
      const start = i;
      while (i + 1 < lines.length && isTableRow(lines[i + 1])) i++;
      out.push(<Table key={start} k={start} rows={lines.slice(start, i + 1)} />);
      continue;
    }
    const line = lines[i];
    const bullet = /^\s*[-*•]\s+/.test(line);
    out.push(
      <div key={i} className={bullet ? "pl-1.5" : undefined}>
        {bullet && "• "}
        {line.trim() ? spans(line.replace(/^\s*[-*•]\s+/, "")) : " "}
      </div>
    );
  }
  return <>{out}</>;
}
