import { createElement, Fragment, type ReactNode } from 'react';
import { resolveHelpLink } from './helpLibrary.js';

export interface HelpMarkdownProps {
  readonly source: string;
  readonly onTopic: (id: string, anchor: string) => void;
  readonly onAnchor: (anchor: string) => void;
  readonly images?: Readonly<Record<string, string>>;
}

export function helpHeadingId(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[`*_]/gu, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/gu, '-');
}

/** 同梱本文で使用するMarkdownをReactへ変換する。生HTMLをDOMへ挿入しない。 */
export function HelpMarkdown({ source, onTopic, onAnchor, images = {} }: HelpMarkdownProps): React.JSX.Element {
  const inline = (text: string, depth = 0): ReactNode => {
    if (depth > 12) return text;
    const pieces: ReactNode[] = []; let offset = 0;
    const tokens = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<!!)\[([^\]]+)\]\(([^\s)]+)\)|\*([^*]+)\*|\\([\\`*_[\]{}()#+.!|>-])|!\[([^\]]*)\]\(([^\s)]+)\)/gu;
    for (const match of text.matchAll(tokens)) {
      pieces.push(text.slice(offset, match.index));
      let node: ReactNode;
      if (match[1] !== undefined) node = <code>{match[2]}</code>;
      else if (match[3] !== undefined || match[4] !== undefined) node = <strong>{inline(match[3] ?? match[4] ?? '', depth + 1)}</strong>;
      else if (match[5] !== undefined) {
        const link = resolveHelpLink(match[6] ?? ''); const label = inline(match[5], depth + 1);
        if (link === null) node = label;
        else if (link.kind === 'external') node = <a href={link.href} target="_blank" rel="noopener noreferrer">{label}</a>;
        else node = <button className="pcad-help__link" type="button" onClick={() => link.kind === 'topic' ? onTopic(link.id, link.anchor) : onAnchor(link.anchor)}>{label}</button>;
      } else if (match[7] !== undefined) node = <em>{inline(match[7], depth + 1)}</em>;
      else if (match[9] !== undefined) {
        const href = match[10] ?? '', src = Object.hasOwn(images, href) ? images[href] : undefined;
        node = src === undefined ? match[9] : <img className="pcad-help__image" src={src} alt={match[9]} loading="lazy" />;
      } else node = match[8];
      pieces.push(<Fragment key={match.index}>{node}</Fragment>); offset = match.index + match[0].length;
    }
    pieces.push(text.slice(offset)); return pieces;
  };
  const cells = (line: string): readonly string[] => {
    const values: string[] = []; let value = ''; let code = false; let escaped = false;
    for (const char of line.trim().replace(/^\||\|$/gu, '')) {
      if (char === '|' && !code && !escaped) { values.push(value.trim()); value = ''; }
      else { value += char; if (char === '`' && !escaped) code = !code; }
      escaped = char === '\\' && !escaped;
    }
    values.push(value.trim()); return values;
  };
  const tableRule = (line: string): boolean => line.includes('|') && cells(line).every((cell) => /^:?-{3,}:?$/u.test(cell));
  const listMatch = (line: string): RegExpExecArray | null => /^(\s*)([-+*]|\d+[.)])\s+(.*)$/u.exec(line);
  const startsBlock = (line: string): boolean => /^\s*(?:#{1,6}\s|`{3,}|~{3,}|>|(?:[-*_]\s*){3,}$)/u.test(line) || listMatch(line) !== null;
  const headings = new Map<string, number>();
  const blocks = (lines: readonly string[], depth = 0): ReactNode[] => {
    if (depth > 12) return [<pre key="nested">{lines.join('\n')}</pre>];
    const nodes: ReactNode[] = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i] ?? ''; const key = i;
      if (line.trim() === '') { i += 1; continue; }
      const fence = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
      if (fence !== null) {
        const marker = fence[1] ?? '```'; const body: string[] = []; i += 1;
        while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) body.push(lines[i++] ?? '');
        i += 1; nodes.push(<pre key={key}><code>{body.join('\n')}</code></pre>); continue;
      }
      const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
      if (heading !== null) {
        const text = heading[2] ?? ''; const base = helpHeadingId(text); const count = headings.get(base) ?? 0; headings.set(base, count + 1);
        nodes.push(createElement(`h${heading[1]?.length ?? 1}`, { key, id: `help-${base}${count === 0 ? '' : `-${count}`}` }, inline(text)));
        i += 1; continue;
      }
      if (/^\s*(?:[-*_]\s*){3,}$/u.test(line)) { nodes.push(<hr key={key} />); i += 1; continue; }
      if (/^\s*>/u.test(line)) {
        const quote: string[] = [];
        while (i < lines.length && /^\s*>/u.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s*> ?/u, ''));
        nodes.push(<blockquote key={key}>{blocks(quote, depth + 1)}</blockquote>); continue;
      }
      if (i + 1 < lines.length && tableRule(lines[i + 1] ?? '')) {
        const header = cells(line); const rows: ReactNode[] = []; i += 2;
        while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
          rows.push(<tr key={i}>{cells(lines[i++] ?? '').map((cell, index) => <td key={index}>{inline(cell)}</td>)}</tr>);
        }
        nodes.push(<div className="pcad-help__table" key={key}><table><thead><tr>{header.map((cell, index) => <th key={index} scope="col">{inline(cell)}</th>)}</tr></thead><tbody>{rows}</tbody></table></div>); continue;
      }
      const list = listMatch(line);
      if (list !== null) {
        const indent = list[1]?.length ?? 0; const ordered = /^\d/u.test(list[2] ?? ''); const items: ReactNode[] = [];
        while (i < lines.length) {
          const entry = listMatch(lines[i] ?? '');
          if (entry === null || (entry[1]?.length ?? 0) !== indent || /^\d/u.test(entry[2] ?? '') !== ordered) break;
          const itemKey = i; const body = [entry[3] ?? '']; const contentIndent = (entry[0]?.length ?? 0) - (entry[3]?.length ?? 0); i += 1;
          while (i < lines.length) {
            const next = lines[i] ?? '';
            if (next.trim() === '') {
              const following = lines[i + 1] ?? '';
              if (following.trim() === '' || (following.match(/^\s*/u)?.[0].length ?? 0) <= indent) break;
            } else if ((next.match(/^\s*/u)?.[0].length ?? 0) <= indent) break;
            body.push(next.slice(Math.min(contentIndent, next.match(/^\s*/u)?.[0].length ?? 0))); i += 1;
          }
          items.push(<li key={itemKey}>{blocks(body, depth + 1)}</li>);
        }
        nodes.push(ordered ? <ol key={key} start={Number.parseInt(list[2] ?? '1', 10)}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
      }
      const paragraph = [line]; i += 1;
      while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines[i] ?? '') && !tableRule(lines[i + 1] ?? '')) paragraph.push(lines[i++] ?? '');
      nodes.push(<p key={key}>{paragraph.map((part, index) => <Fragment key={index}>{index > 0 ? (paragraph[index - 1]?.endsWith('  ') === true ? <br /> : '\n') : null}{inline(part.trimEnd())}</Fragment>)}</p>);
    }
    return nodes;
  };
  return <>{blocks(source.replace(/\r\n?/gu, '\n').split('\n'))}</>;
}
