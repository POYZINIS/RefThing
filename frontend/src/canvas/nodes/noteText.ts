import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';

/**
 * Note text layout — the ONE text path (interaction conventions §4 RULE 7).
 * Pretext does the line breaking for the Pixi-painted note AND for sizing the
 * editor, and every metric below is shared with the editing textarea's CSS,
 * so text never shifts when a note enters or leaves Editing.
 *
 * All values are WORLD px: text reflows to the note's width (§4 RULE 5) and
 * scales with the camera like the rest of the note — it never scales with the
 * note's own height.
 */
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
export const NOTE_TEXT_COLOR = '#332e1f';
export const NOTE_BORDER_COLOR = '#a99657';
export const NOTE_DEFAULT_BG = '#f5e7ad';

export const noteFont = (sizePx = NOTE_FONT_PX) => `${sizePx}px ${NOTE_FONT_FAMILY}`;

export type NoteLayout = { lines: string[]; contentHeight: number };

const cache = new Map<string, NoteLayout>();

/** Lines + the height the text needs (padding included) at a note width. */
export function layoutNoteText(text: string, width: number): NoteLayout {
  const innerWidth = Math.max(1, width - NOTE_TEXT_INSET_PX * 2);
  const key = `${innerWidth}\u0000${text}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const prepared = prepareWithSegments(text, noteFont(), { whiteSpace: 'pre-wrap' });
  const result = layoutWithLines(prepared, innerWidth, NOTE_LINE_HEIGHT_PX);
  const lines = result.lines.map((line) => line.text);
  // Browsers size an empty block to one line (pretext README).
  const lineCount = Math.max(1, result.lineCount);
  const layout = {
    lines,
    contentHeight: lineCount * NOTE_LINE_HEIGHT_PX + NOTE_TEXT_INSET_PX * 2,
  };
  if (cache.size > 500) cache.clear();
  cache.set(key, layout);
  return layout;
}

/** §4 RULE 6 auto-grow: the height a note should have after an edit. Never
 *  shrinks below the user's own height; grows to fit, capped. */
export function grownNoteHeight(text: string, width: number, height: number): number {
  const { contentHeight } = layoutNoteText(text, width);
  return Math.max(height, Math.min(contentHeight, NOTE_MAX_HEIGHT_PX));
}

/** Plain-text content of a note's `content_json`. */
export function noteText(content: unknown): string {
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}
