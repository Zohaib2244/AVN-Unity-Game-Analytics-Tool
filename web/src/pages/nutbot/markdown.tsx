// The small markdown the assistant answers in (the old nbMarkdown), rendered as React nodes: code,
// bold, italics, headings, lists, fenced code, pipe tables and links. Text is never put in as HTML.
import { Fragment, type ReactElement, type ReactNode } from 'react';

export type MarkdownOptions = { /** Opens an internal link ("/games/…"); without it the link is a plain anchor. */ onOpen?: (path: string) => void };

const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|((?:^|[^*\w])\*[^*\s][^*]*?\*(?!\w))/g;
const SPECIAL = /^(```|#{1,4}\s|\s*[-*]\s+|\s*\d+[.)]\s+|\|)/;
const isInternal = (url: string): boolean => url.startsWith('/') && !url.startsWith('//');
const isExternal = (url: string): boolean => /^https?:\/\//i.test(url);

/** Inline markdown → nodes. */
export function inline(text: string, options: MarkdownOptions = {}, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0; let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const key = `${keyPrefix}${n++}`;
    if (match[1]) nodes.push(<code key={key}>{match[1].slice(1, -1)}</code>);
    else if (match[2]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(match[2])!;
      const label = link[1]!; const url = link[2]!;
      if (isInternal(url)) nodes.push(<a key={key} href={url} onClick={options.onOpen ? (event) => { event.preventDefault(); options.onOpen?.(url); } : undefined}>{inline(label, options, `${key}-`)}</a>);
      else if (isExternal(url)) nodes.push(<a key={key} href={url} target="_blank" rel="noreferrer">{inline(label, options, `${key}-`)}</a>);
      else nodes.push(...inline(label, options, `${key}-`));
    } else if (match[3]) nodes.push(<strong key={key}>{inline(match[3].slice(2, -2), options, `${key}-`)}</strong>);
    else if (match[4]) {
      const lead = match[4].startsWith('*') ? '' : match[4].slice(0, 1);
      if (lead) nodes.push(lead);
      nodes.push(<em key={key}>{inline(match[4].slice(lead.length + 1, -1), options, `${key}-`)}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Block markdown → nodes (paragraphs, h4, ul/ol, pre, tables). */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): ReactNode[] {
  const lines = String(source).replace(/\r/g, '').split('\n');
  const out: ReactNode[] = []; let i = 0;
  const key = () => `b${out.length}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++; out.push(<pre key={key()}><code>{body.join('\n')}</code></pre>); continue;
    }
    if (/^\|.*\|\s*$/.test(line) && lines[i + 1] && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const head = cells(line); i += 2; const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key()} className="nb-table"><table>
          <thead><tr>{head.map((cell, c) => <th key={c}>{inline(cell, options)}</th>)}</tr></thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell, options)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) { out.push(<h4 key={key()}>{inline(heading[1]!, options)}</h4>); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ''));
      out.push(<ul key={key()}>{items.map((item, n) => <li key={n}>{inline(item, options)}</li>)}</ul>); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ''));
      out.push(<ol key={key()}>{items.map((item, n) => <li key={n}>{inline(item, options)}</li>)}</ol>); continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(paragraph.length && SPECIAL.test(lines[i]!))) paragraph.push(lines[i++]!);
    out.push(<p key={key()}>{inline(paragraph.join(' '), options)}</p>);
  }
  return out;
}

export function Markdown({ source, onOpen }: { source: string } & MarkdownOptions): ReactElement {
  return <Fragment>{renderMarkdown(source, { onOpen })}</Fragment>;
}
