import { useEffect, useRef, useState } from 'react';
import type { Note } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';
import {
  grownNoteHeight,
  NOTE_BORDER_COLOR,
  NOTE_BORDER_PX,
  NOTE_DEFAULT_BG,
  NOTE_FONT_FAMILY,
  NOTE_FONT_PX,
  NOTE_LINE_HEIGHT_PX,
  NOTE_MAX_HEIGHT_PX,
  NOTE_PADDING_PX,
  NOTE_TEXT_COLOR,
  noteText,
} from '@/canvas/nodes/noteText';

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

/**
 * The note text editor (§4). Mounted only while a note is in Editing — at all
 * other times the note is a canvas sprite painted from the same pretext
 * layout. It lays out at WORLD size (15px text, world-px width) and is scaled
 * by the camera as a whole, so its line breaks are exactly the ones pretext
 * computed for the painted note: entering/leaving Editing never reflows.
 */
export function NoteEditor({ note, viewport, onGrow, onCommit, onExit }: NoteEditorProps) {
  const [value, setValue] = useState(() => noteText(note.content_json));
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Height when Editing began: auto-grow never shrinks below it.
  const baseHeight = useRef(note.height);
  const committed = useRef(false);
  const latest = useRef({ value, width: note.width, onCommit });
  latest.current = { value, width: note.width, onCommit };

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.select();
  }, []);

  // Commit once, whichever way Editing ends — blur, Escape, or the editor
  // being unmounted because another node got selected.
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const { value: text, width, onCommit: commitNote } = latest.current;
    commitNote(text, grownNoteHeight(text, width, baseHeight.current));
  };
  // Unmount flush. The latch re-arms on every mount: StrictMode's dev-only
  // mount → cleanup → mount would otherwise spend the session's single
  // commit on the untouched text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only flush through refs
  useEffect(() => {
    committed.current = false;
    return () => commit();
  }, []);

  const height = Math.max(note.height, grownNoteHeight(value, note.width, baseHeight.current));
  const centerX = viewport.x + (note.x + note.width / 2) * viewport.zoom;
  const centerY = viewport.y + (note.y + height / 2) * viewport.zoom;

  return (
    <textarea
      ref={textarea}
      className="note-editor"
      aria-label="Note text"
      value={value}
      spellCheck={false}
      style={{
        left: centerX - note.width / 2,
        top: centerY - height / 2,
        width: note.width,
        height,
        maxHeight: NOTE_MAX_HEIGHT_PX,
        transform: `rotate(${note.rotation}deg) scale(${viewport.zoom})`,
        padding: NOTE_PADDING_PX,
        font: `${NOTE_FONT_PX}px/${NOTE_LINE_HEIGHT_PX}px ${NOTE_FONT_FAMILY}`,
        color: NOTE_TEXT_COLOR,
        background: note.bg_color ?? NOTE_DEFAULT_BG,
        border: `${NOTE_BORDER_PX}px solid ${NOTE_BORDER_COLOR}`,
        opacity: note.opacity,
        // Scrolls only once auto-grow hits the cap (§4 RULE 6); a scrollbar
        // any earlier would steal width and reflow the text.
        overflowY: height >= NOTE_MAX_HEIGHT_PX ? 'auto' : 'hidden',
      }}
      onChange={(event) => {
        setValue(event.target.value);
        onGrow(grownNoteHeight(event.target.value, note.width, baseHeight.current));
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
