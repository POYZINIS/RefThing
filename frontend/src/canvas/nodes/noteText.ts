import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';
import {
  layoutNextRichInlineLineRange,
  materializeRichInlineLineRange,
  prepareRichInline,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline';
import { type Block, parseMarkdown, type Span } from './markdown';

/**
 * Note text — the ONE text path (interaction conventions §4 RULE 7): pretext
 * lays out every line the canvas paints (rich-inline for markdown runs) and
 * sizes the editor.
 *
 * A note's look is its STYLE (content_json.style: font, size, bold, italic,
 * alignment, text colour, markdown on/off) plus its fill (bg_color). The
 * painted note renders markdown; the editor shows the raw text in the same
 * font. Layout works in note units — world px ÷ the note's text `scale`
 * (imported PureRef labels are drawn several times larger); resizing reflows
 * the text and never changes its size.
 */

// ------------------------------------------------------------- metrics --

export const NOTE_FONT_PX = 15;
export const NOTE_LINE_HEIGHT_PX = 21;
export const NOTE_PADDING_PX = 12;
export const NOTE_BORDER_PX = 1;
/** Border + padding: where text starts inside the note (the editor is
 *  border-box, so its border eats into the same inset). */
export const NOTE_TEXT_INSET_PX = NOTE_PADDING_PX + NOTE_BORDER_PX;
/** §4 RULE 6: notes auto-grow to fit their text up to this height, then the
 *  editor scrolls internally. */
export const NOTE_MAX_HEIGHT_PX = 1200;
/** A named font stack (pretext caveat: never `system-ui`), shared with CSS. */
export const NOTE_FONT_FAMILY = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

export type NoteFontId = 'sans' | 'serif' | 'mono' | 'hand';
export const NOTE_FONTS: Record<NoteFontId, { label: string; family: string }> = {
  sans: { label: 'Sans', family: NOTE_FONT_FAMILY },
  serif: { label: 'Serif', family: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Mono', family: '"Cascadia Mono", Consolas, "Courier New", monospace' },
  hand: { label: 'Hand', family: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive' },
};
const MONO_FAMILY = NOTE_FONTS.mono.family;

export const NOTE_SIZES = [
  { label: 'S', px: 12 },
  { label: 'M', px: 15 },
  { label: 'L', px: 20 },
  { label: 'XL', px: 28 },
  { label: 'XXL', px: 40 },
] as const;

export type NoteAlign = 'left' | 'center' | 'right';

export type NoteStyle = {
  font: NoteFontId;
  /** Text size in note units (px at scale 1). */
  size: number;
  bold: boolean;
  italic: boolean;
  align: NoteAlign;
  /** Text colour; null = automatic (contrast with the fill, else the theme). */
  color: string | null;
  /** Render markdown (default) or show the text as typed. */
  markdown: boolean;
};

export const DEFAULT_NOTE_STYLE: NoteStyle = {
  font: 'sans',
  size: NOTE_FONT_PX,
  bold: false,
  italic: false,
  align: 'left',
  color: null,
  markdown: true,
};

export const lineHeightFor = (px: number) => px * (NOTE_LINE_HEIGHT_PX / NOTE_FONT_PX);

export function fontString(
  family: string,
  px: number,
  { bold = false, italic = false }: { bold?: boolean; italic?: boolean } = {},
): string {
  return `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${px}px ${family}`;
}

// --------------------------------------------------------------- content --

const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** A note's style from its content, every field validated. */
export function noteStyle(content: unknown): NoteStyle {
  const raw =
    typeof content === 'object' && content !== null && 'style' in content
      ? (content as { style?: unknown }).style
      : null;
  if (typeof raw !== 'object' || raw === null) return DEFAULT_NOTE_STYLE;
  const s = raw as Record<string, unknown>;
  return {
    font: typeof s.font === 'string' && s.font in NOTE_FONTS ? (s.font as NoteFontId) : 'sans',
    size:
      typeof s.size === 'number' && Number.isFinite(s.size) && s.size >= 6 && s.size <= 200
        ? s.size
        : NOTE_FONT_PX,
    bold: s.bold === true,
    italic: s.italic === true,
    align: s.align === 'center' || s.align === 'right' ? s.align : 'left',
    color: isHex(s.color) ? s.color : null,
    markdown: s.markdown !== false,
  };
}

/** A style as stored: only what differs from the defaults. */
export function storedStyle(style: NoteStyle): Partial<NoteStyle> {
  const out: Partial<NoteStyle> = {};
  for (const key of Object.keys(DEFAULT_NOTE_STYLE) as (keyof NoteStyle)[]) {
    if (style[key] !== DEFAULT_NOTE_STYLE[key]) (out as Record<string, unknown>)[key] = style[key];
  }
  return out;
}

/** A note's text scale (`content_json.scale`); 1 when absent or invalid. */
export function noteScale(content: unknown): number {
  if (typeof content === 'object' && content !== null && 'scale' in content) {
    const scale = (content as { scale?: unknown }).scale;
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) return scale;
  }
  return 1;
}

/** Plain-text content of a note's `content_json`. */
export function noteText(content: unknown): string {
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

// ---------------------------------------------------------------- colour --

export type NoteColors = {
  /** Fill, or null: the note blends into the board (text only). */
  fill: string | null;
  text: string;
  muted: string;
  border: string | null;
  codeFill: string;
  rule: string;
};

const INK = '#1f2622';
const PAPER = '#eef2ee';

function luminance(hex: string): number {
  const channel = (at: number) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const withAlpha = (hex: string, alpha: number) =>
  `rgba(${Number.parseInt(hex.slice(1, 3), 16)}, ${Number.parseInt(hex.slice(3, 5), 16)}, ${Number.parseInt(hex.slice(5, 7), 16)}, ${alpha})`;

/**
 * A note's colours. With no fill the note is text only, in the colour that
 * stands out from the board — the theme flipped: light text on the dark
 * theme, dark on the light. With a fill, automatic text contrasts with it.
 * A chosen text colour always wins.
 */
export function noteColors(
  fill: string | null,
  textColor: string | null,
  theme: 'light' | 'dark',
): NoteColors {
  const solidFill = isHex(fill) ? fill : null;
  const automatic = solidFill
    ? luminance(solidFill) > 0.35
      ? INK
      : PAPER
    : theme === 'dark'
      ? PAPER
      : INK;
  const text = isHex(textColor) ? textColor : automatic;
  return {
    fill: solidFill,
    text,
    muted: withAlpha(text, 0.66),
    border: solidFill ? withAlpha(luminance(solidFill) > 0.35 ? INK : PAPER, 0.14) : null,
    codeFill: withAlpha(text, 0.1),
    rule: withAlpha(text, 0.28),
  };
}

/** The theme notes are drawn for (the chrome's resolved theme). */
export function currentTheme(): 'light' | 'dark' {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : 'light';
}

// ------------------------------------------------------- editor (raw) --

export type NoteLayout = { lines: string[]; contentHeight: number };

const rawCache = new Map<string, NoteLayout>();

/** The raw text as the editor shows it (the note's font, pre-wrap): lines
 *  + the height it needs, in world px. */
export function layoutNoteText(
  text: string,
  width: number,
  scale = 1,
  style: NoteStyle = DEFAULT_NOTE_STYLE,
): NoteLayout {
  const innerWidth = Math.max(1, width / scale - NOTE_TEXT_INSET_PX * 2);
  const font = fontString(NOTE_FONTS[style.font].family, style.size, style);
  const lineHeight = lineHeightFor(style.size);
  const key = `${innerWidth}\u0000${scale}\u0000${font}\u0000${text}`;
  const cached = rawCache.get(key);
  if (cached) return cached;
  const prepared = prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' });
  const result = layoutWithLines(prepared, innerWidth, lineHeight);
  // Browsers size an empty block to one line (pretext README).
  const lineCount = Math.max(1, result.lineCount);
  const layout = {
    lines: result.lines.map((line) => line.text),
    contentHeight: (lineCount * lineHeight + NOTE_TEXT_INSET_PX * 2) * scale,
  };
  if (rawCache.size > 500) rawCache.clear();
  rawCache.set(key, layout);
  return layout;
}

// ---------------------------------------------------- painted (rich) --

/** One run of text on a painted line (note units). */
export type PaintRun = {
  x: number;
  text: string;
  font: string;
  width: number;
  muted?: boolean;
  strike?: boolean;
  underline?: boolean;
  /** Code: drawn on a tinted chip `pad` wide on each side. */
  code?: { pad: number };
};

export type PaintLine = {
  y: number;
  height: number;
  /** Font size of the line's body text (decorations scale with it). */
  px: number;
  runs: PaintRun[];
  marker?:
    | { kind: 'bullet'; x: number }
    | { kind: 'ordered'; x: number; text: string; font: string }
    | { kind: 'task'; x: number; checked: boolean };
  /** A quote's bar, at x. */
  quoteBar?: number;
  /** A fenced code line: tinted band across the text column. */
  codeBand?: boolean;
  /** A `---` rule across the text column. */
  rule?: boolean;
};

export type NoteDocument = {
  lines: PaintLine[];
  /** Text column in note units. */
  left: number;
  width: number;
  /** Height the note needs, world px (padding included). */
  contentHeight: number;
};

const docCache = new Map<string, NoteDocument>();

/** The note as painted: markdown (or the plain text) laid out in lines of
 *  styled runs, aligned, in note units. */
export function layoutNoteDocument(
  text: string,
  width: number,
  scale = 1,
  style: NoteStyle = DEFAULT_NOTE_STYLE,
): NoteDocument {
  const inner = Math.max(1, width / scale - NOTE_TEXT_INSET_PX * 2);
  const key = `${inner}\u0000${scale}\u0000${JSON.stringify(style)}\u0000${text}`;
  const cached = docCache.get(key);
  if (cached) return cached;
  const lines = style.markdown
    ? layoutBlocks(parseMarkdown(text), inner, style)
    : layoutPlain(text, inner, style);
  const bottom = lines.reduce((end, line) => Math.max(end, line.y + line.height), 0);
  const used = Math.max(bottom - NOTE_TEXT_INSET_PX, lineHeightFor(style.size));
  const document = {
    lines,
    left: NOTE_TEXT_INSET_PX,
    width: inner,
    contentHeight: (used + NOTE_TEXT_INSET_PX * 2) * scale,
  };
  if (docCache.size > 500) docCache.clear();
  docCache.set(key, document);
  return document;
}

const alignOffset = (align: NoteAlign, room: number) =>
  align === 'center' ? room / 2 : align === 'right' ? room : 0;

function layoutPlain(text: string, inner: number, style: NoteStyle): PaintLine[] {
  const font = fontString(NOTE_FONTS[style.font].family, style.size, style);
  const lineHeight = lineHeightFor(style.size);
  const prepared = prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' });
  const { lines } = layoutWithLines(prepared, inner, lineHeight);
  return lines.map((line, index) => ({
    y: NOTE_TEXT_INSET_PX + index * lineHeight,
    height: lineHeight,
    px: style.size,
    runs: [
      {
        x: NOTE_TEXT_INSET_PX + alignOffset(style.align, inner - line.width),
        text: line.text,
        font,
        width: line.width,
      },
    ],
  }));
}

const HEADING_SCALE = { 1: 1.6, 2: 1.3, 3: 1.12 } as const;

function layoutBlocks(blocks: Block[], inner: number, style: NoteStyle): PaintLine[] {
  const family = NOTE_FONTS[style.font].family;
  const base = style.size;
  const out: PaintLine[] = [];
  let y = NOTE_TEXT_INSET_PX;
  const indentStep = base * 1.3;

  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'blank') {
      y += lineHeightFor(base) * 0.6;
      continue;
    }
    if (block.kind === 'rule') {
      const height = base;
      out.push({ y, height, px: base, runs: [], rule: true });
      y += height;
      continue;
    }
    if (block.kind === 'code') {
      const px = base * 0.9;
      const lineHeight = px * 1.45;
      const pad = base * 0.5;
      const font = fontString(MONO_FAMILY, px);
      const prepared = prepareWithSegments(block.text, font, { whiteSpace: 'pre-wrap' });
      const { lines } = layoutWithLines(prepared, Math.max(1, inner - pad * 2), lineHeight);
      y += base * 0.2;
      for (const line of lines.length > 0 ? lines : [{ text: '', width: 0 }]) {
        out.push({
          y,
          height: lineHeight,
          px,
          codeBand: true,
          runs: [{ x: NOTE_TEXT_INSET_PX + pad, text: line.text, font, width: line.width }],
        });
        y += lineHeight;
      }
      y += base * 0.2;
      continue;
    }

    const heading = block.kind === 'heading';
    const px = heading ? base * HEADING_SCALE[block.level] : base;
    const lineHeight = heading ? px * 1.3 : lineHeightFor(px);
    if (heading && index > 0) y += base * 0.3;
    const quote = block.kind === 'quote';
    const listDepth =
      block.kind === 'bullet' || block.kind === 'ordered' || block.kind === 'task'
        ? block.depth
        : null;
    const markerX = NOTE_TEXT_INSET_PX + (listDepth ?? 0) * indentStep;
    const left =
      listDepth !== null
        ? markerX + indentStep
        : quote
          ? NOTE_TEXT_INSET_PX + base * 0.9
          : NOTE_TEXT_INSET_PX;
    const room = Math.max(1, inner - (left - NOTE_TEXT_INSET_PX));

    const spans: Span[] = block.spans.length > 0 ? block.spans : [{ text: '' }];
    const items: RichInlineItem[] = spans.map((span) =>
      span.code
        ? {
            text: span.text,
            font: fontString(MONO_FAMILY, px * 0.88),
            break: 'never',
            extraWidth: px * 0.5,
          }
        : {
            text: span.text,
            font: fontString(family, px, {
              bold: style.bold || heading || !!span.bold,
              italic: style.italic || quote || !!span.italic,
            }),
          },
    );
    const prepared = prepareRichInline(items);
    let cursor: Parameters<typeof layoutNextRichInlineLineRange>[2];
    let first = true;
    for (;;) {
      const range = layoutNextRichInlineLineRange(prepared, room, cursor);
      if (!range) break;
      const line = materializeRichInlineLineRange(prepared, range);
      let x = left + alignOffset(style.align, room - line.width);
      const runs: PaintRun[] = [];
      for (const fragment of line.fragments) {
        x += fragment.gapBefore;
        const span = spans[fragment.itemIndex] as Span;
        const item = items[fragment.itemIndex] as RichInlineItem;
        runs.push({
          x,
          text: fragment.text,
          font: item.font,
          width: fragment.occupiedWidth,
          muted: quote,
          strike: span.strike,
          underline: span.link,
          code: span.code ? { pad: (item.extraWidth ?? 0) / 2 } : undefined,
        });
        x += fragment.occupiedWidth;
      }
      out.push({
        y,
        height: lineHeight,
        px,
        runs,
        quoteBar: quote ? NOTE_TEXT_INSET_PX + base * 0.15 : undefined,
        marker:
          first && block.kind === 'bullet'
            ? { kind: 'bullet', x: markerX }
            : first && block.kind === 'ordered'
              ? { kind: 'ordered', x: markerX, text: block.marker, font: fontString(family, px) }
              : first && block.kind === 'task'
                ? { kind: 'task', x: markerX, checked: block.checked }
                : undefined,
      });
      y += lineHeight;
      first = false;
      cursor = range.end;
    }
    if (first) {
      // Nothing laid out (an empty item): still one line tall.
      out.push({ y, height: lineHeight, px, runs: [] });
      y += lineHeight;
    }
  }
  return out;
}

/** §4 RULE 6 auto-grow: the height a note should have after an edit (as
 *  painted). Never shrinks below the user's own height; grows to fit,
 *  capped. */
export function grownNoteHeight(
  text: string,
  width: number,
  height: number,
  scale = 1,
  style: NoteStyle = DEFAULT_NOTE_STYLE,
): number {
  const { contentHeight } = layoutNoteDocument(text, width, scale, style);
  return Math.max(height, Math.min(contentHeight, NOTE_MAX_HEIGHT_PX * scale));
}
