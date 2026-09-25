/**
 * Note markdown → blocks of styled spans, for the painted note (the editor
 * shows the raw text). A deliberately small dialect, tuned for notes:
 *
 * - every newline is a line break (notes are typed line by line);
 * - blocks: `#`–`###` headings, `-`/`*`/`+` bullets and `1.` numbers (two
 *   spaces of indent per level), `- [ ]` / `- [x]` tasks, `>` quotes,
 *   ``` fenced code, `---` rules, blank lines;
 * - inline: `**bold**` / `__bold__`, `*italic*` / `_italic_`, `~~strike~~`,
 *   `` `code` ``, `[label](url)`; a backslash escapes a marker.
 *
 * Pure: no DOM, no fonts — layout happens in noteText.ts.
 */

export type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
};

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { kind: 'bullet'; depth: number; spans: Span[] }
  | { kind: 'ordered'; depth: number; marker: string; spans: Span[] }
  | { kind: 'task'; depth: number; checked: boolean; spans: Span[] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'blank' };

type Flags = Omit<Span, 'text'>;

const ESCAPABLE = new Set('\\`*_~[]()#>-+.!'.split(''));
const WORD = /[\p{L}\p{N}]/u;

/** Where the run opened at `from` by `marker` closes, or -1. */
function closing(text: string, marker: string, from: number): number {
  let at = from;
  while (at < text.length) {
    let found = text.indexOf(marker, at);
    if (found < 0) return -1;
    // `***x***`: a double marker closes at the END of a run of its char, so
    // the inner `*x*` keeps its own closer.
    if (marker.length === 2) {
      while (text[found + 2] === marker[0]) found += 1;
    }
    const before = text[found - 1] ?? '';
    const after = text[found + marker.length] ?? '';
    const escaped = before === '\\';
    // Not a closer: escaped, right after whitespace, part of a longer run
    // (`*` inside `**`), or — for `_` — inside a word (snake_case).
    const flanked = before.trim() !== '' && !escaped;
    const longer = marker.length === 1 && after === marker[0];
    const intraword = marker[0] === '_' && WORD.test(after);
    if (found > from && flanked && !longer && !intraword) return found;
    at = found + (longer ? 2 : 1);
  }
  return -1;
}

/** Inline markdown → spans (adjacent spans with equal flags merged). */
export function parseInline(text: string, flags: Flags = {}): Span[] {
  const spans: Span[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) spans.push({ ...flags, text: buffer });
    buffer = '';
  };
  let i = 0;
  outer: while (i < text.length) {
    const char = text[i] as string;
    const next = text[i + 1] ?? '';
    if (char === '\\' && ESCAPABLE.has(next)) {
      buffer += next;
      i += 2;
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        spans.push({ ...flags, code: true, text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (char === '[') {
      const match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (match) {
        flush();
        spans.push(...parseInline(match[1] as string, { ...flags, link: true }));
        i += match[0].length;
        continue;
      }
    }
    for (const [marker, flag] of [
      ['**', 'bold'],
      ['__', 'bold'],
      ['~~', 'strike'],
      ['*', 'italic'],
      ['_', 'italic'],
    ] as const) {
      if (!text.startsWith(marker, i)) continue;
      const opensAfter = text[i + marker.length] ?? '';
      // An opener needs text right after it; `_` also can't open mid-word.
      if (opensAfter.trim() === '') continue;
      if (marker[0] === '_' && WORD.test(text[i - 1] ?? '')) continue;
      const end = closing(text, marker, i + marker.length);
      if (end < 0) continue;
      flush();
      spans.push(...parseInline(text.slice(i + marker.length, end), { ...flags, [flag]: true }));
      i = end + marker.length;
      continue outer;
    }
    buffer += char;
    i += 1;
  }
  flush();
  return merge(spans);
}

const sameFlags = (a: Span, b: Span) =>
  !!a.bold === !!b.bold &&
  !!a.italic === !!b.italic &&
  !!a.strike === !!b.strike &&
  !!a.code === !!b.code &&
  !!a.link === !!b.link;

function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last && !span.code && !last.code && sameFlags(last, span)) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}

/** A whole note → blocks, one per source line (fenced code grouped). */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fence: string[] | null = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        blocks.push({ kind: 'code', text: fence.join('\n') });
        fence = null;
      } else {
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    if (line.trim() === '') {
      blocks.push({ kind: 'blank' });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      continue;
    }
    const heading = /^\s{0,3}(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length as 1 | 2 | 3,
        spans: parseInline(heading[2] as string),
      });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push({ kind: 'quote', spans: parseInline(quote[1] as string) });
      continue;
    }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      blocks.push({
        kind: 'task',
        depth: depthOf(task[1] as string),
        checked: task[2] !== ' ',
        spans: parseInline(task[3] as string),
      });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({
        kind: 'bullet',
        depth: depthOf(bullet[1] as string),
        spans: parseInline(bullet[2] as string),
      });
      continue;
    }
    const ordered = /^(\s*)(\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (ordered) {
      blocks.push({
        kind: 'ordered',
        depth: depthOf(ordered[1] as string),
        marker: ordered[2] as string,
        spans: parseInline(ordered[3] as string),
      });
      continue;
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(line) });
  }
  // An unclosed fence still shows its lines.
  if (fence) blocks.push({ kind: 'code', text: fence.join('\n') });
  return blocks;
}

const depthOf = (indent: string) => Math.min(4, Math.floor(indent.replace(/\t/g, '  ').length / 2));
