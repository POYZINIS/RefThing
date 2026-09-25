import { useEffect, useRef, useState } from 'react';
import type { Note } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';
import {
  fontString,
  grownNoteHeight,
  layoutNoteText,
  lineHeightFor,
  NOTE_BORDER_PX,
  NOTE_FONTS,
  NOTE_MAX_HEIGHT_PX,
  NOTE_PADDING_PX,
  noteColors,
  noteScale,
  noteStyle,
  noteText,
} from '@/canvas/nodes/noteText';
import { useAppearance } from '@/ui/appearance';

type NoteEditorProps = {
  note: Note;
  /** The rendered (eased) camera, same as every other overlay. */
  viewport: ViewportState;
  /** Live auto-grow height while typing (§4 RULE 6), so the dashed shell
   *  tracks the editor. */
  onGrow: (height: number) => void;
  /** Called exactly ONCE per editing session with the final text and height
   *  (§4 RULE 4: one undo entry per session, never per keystroke). */
  onCommit: (text: string, height: number) => void;
  /** The editor asks to leave Editing (Escape / focus left). */
  onExit: () => void;
};

/** Ctrl/Cmd+B and +I: wrap the selection in a markdown marker, or take the
 *  marker off when it's already wrapped. */
function toggleMarker(element: HTMLTextAreaElement, marker: string): string {
  const { selectionStart: start, selectionEnd: end, value } = element;
  const selected = value.slice(start, end);
  const outside =
    value.slice(start - marker.length, start) === marker &&
    value.slice(end, end + marker.length) === marker;
  if (outside) {
    element.setRangeText(selected, start - marker.length, end + marker.length, 'select');
  } else if (
    selected.length > marker.length * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    element.setRangeText(selected.slice(marker.length, -marker.length), start, end, 'select');
  } else {
    element.setRangeText(`${marker}${selected}${marker}`, start, end, 'select');
    element.setSelectionRange(start + marker.length, end + marker.length);
  }
  return element.value;
}

/**
 * The note text editor (§4). Mounted only while a note is in Editing — at all
 * other times the note is a canvas sprite painted from its pretext layout.
 * It shows the RAW text (markdown source) in the note's own font, size and
 * alignment, laid out at note units and scaled by camera × text scale as a
 * whole, so it sits exactly on the note's frame.
 */
export function NoteEditor({ note, viewport, onGrow, onCommit, onExit }: NoteEditorProps) {
  const [value, setValue] = useState(() => noteText(note.content_json));
  // A scaled note (imported label) edits at its own text size: the
  // textarea lays out at scale 1 in width/scale and is scaled as a whole.
  const textScale = noteScale(note.content_json);
  const style = noteStyle(note.content_json);
  const theme = useAppearance((state) => state.resolved);
  const colors = noteColors(note.bg_color, style.color, theme);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Height when Editing began: auto-grow never shrinks below it.
  const baseHeight = useRef(note.height);
  const committed = useRef(false);
  const latest = useRef({ value, width: note.width, textScale, style, onCommit });
  latest.current = { value, width: note.width, textScale, style, onCommit };

  /** While typing: grow to fit the raw text as the editor lays it out. */
  const editingHeight = (text: string) =>
    Math.max(
      baseHeight.current,
      Math.min(
        layoutNoteText(text, note.width, textScale, style).contentHeight,
        NOTE_MAX_HEIGHT_PX * textScale,
      ),
    );

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.select();
  }, []);

  // Commit once, whichever way Editing ends — blur, Escape, or the editor
  // being unmounted because another node got selected. The committed height
  // fits the note as PAINTED (rendered markdown).
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const { value: text, width, textScale: scale, style: s, onCommit: commitNote } = latest.current;
    commitNote(text, grownNoteHeight(text, width, baseHeight.current, scale, s));
  };
  // Unmount flush. The latch re-arms on every mount: StrictMode's dev-only
  // mount → cleanup → mount would otherwise spend the session's single
  // commit on the untouched text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only flush through refs
  useEffect(() => {
    committed.current = false;
    return () => commit();
  }, []);

  const height = Math.max(note.height, editingHeight(value));
  const centerX = viewport.x + (note.x + note.width / 2) * viewport.zoom;
  const centerY = viewport.y + (note.y + height / 2) * viewport.zoom;
  // Laid out unscaled, then scaled by camera × text scale about its centre.
  const boxWidth = note.width / textScale;
  const boxHeight = height / textScale;

  return (
    <textarea
      ref={textarea}
      className="note-editor"
      aria-label="Note text"
      value={value}
      spellCheck={false}
      style={{
        left: centerX - boxWidth / 2,
        top: centerY - boxHeight / 2,
        width: boxWidth,
        height: boxHeight,
        maxHeight: NOTE_MAX_HEIGHT_PX,
        transform: `rotate(${note.rotation}deg) scale(${viewport.zoom * textScale})`,
        // The frame stays 1 world px at any text scale, as the painted note
        // draws it; the padding makes up the difference so the text inset
        // (border + padding) is exactly the painted one.
        padding: NOTE_PADDING_PX + NOTE_BORDER_PX - NOTE_BORDER_PX / textScale,
        borderRadius: 4 / textScale,
        font: `${fontString(NOTE_FONTS[style.font].family, style.size, style)}`,
        lineHeight: `${lineHeightFor(style.size)}px`,
        textAlign: style.align,
        color: colors.text,
        caretColor: colors.text,
        // An unfilled note edits over the board, as it paints.
        background: colors.fill ?? 'transparent',
        border: `${NOTE_BORDER_PX / textScale}px solid ${colors.border ?? 'transparent'}`,
        opacity: note.opacity,
        // Scrolls only once auto-grow hits the cap (§4 RULE 6); a scrollbar
        // any earlier would steal width and reflow the text.
        overflowY: boxHeight >= NOTE_MAX_HEIGHT_PX ? 'auto' : 'hidden',
      }}
      onChange={(event) => {
        setValue(event.target.value);
        onGrow(editingHeight(event.target.value));
      }}
      onBlur={() => {
        commit();
        onExit();
      }}
      onKeyDown={(event) => {
        // §4 RULE 4: Escape exits Editing (committing), back to Selected.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.blur();
          return;
        }
        // Markdown shortcuts on the selection.
        const primary = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (primary && !event.altKey && (key === 'b' || key === 'i')) {
          event.preventDefault();
          const next = toggleMarker(event.currentTarget, key === 'b' ? '**' : '*');
          setValue(next);
          onGrow(editingHeight(next));
        }
      }}
      onPointerDown={(event) => {
        // §4 RULE 3: presses inside the editor are caret placement, never a
        // move or resize — keep them away from the canvas and the shell.
        event.stopPropagation();
      }}
    />
  );
}
