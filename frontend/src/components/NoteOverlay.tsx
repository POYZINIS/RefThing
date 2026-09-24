import { useEffect, useRef, useState } from 'react';
import type { Note } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';

type NoteOverlayProps = {
  note: Note;
  viewport: ViewportState;
  selected: boolean;
  /** Text-edit mode (§4 RULE 2 — double-click only). While editing, the 8
   *  transform zones are hidden AND non-interactive (§4 RULE 3). */
  editing: boolean;
  /** Press on the note body, forwarded (with the native event) so the
   *  canvas interaction controller runs select/move — the same path a
   *  sprite press takes (§4 RULE 1). Never called while editing. */
  onPress: (event: React.PointerEvent) => void;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
  onSave: (content: string) => void;
  onEditingChange: (editing: boolean) => void;
};

function noteText(content: unknown): string {
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * PureRef note overlay (§4). Single click, or click-and-drag, anywhere on a
 * note ALWAYS means select/move (§4 RULE 1) — identical to an image, and
 * literally the same code path: presses forward to the canvas interaction
 * controller. It is only editable on double-click (§4 RULE 2).
 *
 * When selected, the article is inert for gestures (the SelectionOverlay
 * shell owns move, resize, rotate). Only hover + double-click-to-edit
 * remain meaningful, and the shell forwards double-clicks.
 */
export function NoteOverlay({
  note,
  viewport,
  selected,
  editing,
  onPress,
  onSelect,
  onHover,
  onSave,
  onEditingChange,
}: NoteOverlayProps) {
  const [value, setValue] = useState(noteText(note.content_json));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => setValue(noteText(note.content_json)), [note.content_json]);

  // §4 RULE 2 — double-click is the ONLY way to enter editing. When the App
  // flips us into editing (from the shell's forwarded double-click), focus
  // the textarea AND select all text so typing immediately replaces it.
  useEffect(() => {
    if (editing) {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [editing]);

  // Font size scales with note height.  The base design is ~12px at h=145.
  const fontSize = Math.max(8, note.height * 0.083);

  return (
    <article
      data-node-id={note.id}
      className={`note-overlay${editing ? ' note-overlay-editing' : ''}${
        selected ? ' note-overlay-selected' : ''
      }`}
      style={{
        left: viewport.x + note.x * viewport.zoom,
        top: viewport.y + note.y * viewport.zoom,
        width: note.width * viewport.zoom,
        height: note.height * viewport.zoom,
        opacity: note.opacity,
        backgroundColor: note.bg_color ?? '#f5e7ad',
        zIndex: note.z_index,
        transform: `rotate(${note.rotation}deg)`,
        // Selected notes are inert for gestures — the SelectionOverlay shell
        // sits above and owns move/resize/rotate (§0.7 uniform shell). While
        // EDITING the note must stay interactive (textarea), so only the
        // non-editing selected state goes inert.
        pointerEvents: selected && !editing ? 'none' : 'auto',
      }}
      onPointerDown={(event) => {
        // §4 RULE 3 — while editing, presses are text-cursor placements,
        // never the start of a move; the controller stays out of it.
        if (!editing) onPress(event);
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onDoubleClick={(event) => {
        // Enter edit mode on double-click (PureRef / §4 RULE 2). Selecting
        // first keeps the `selected` prop true so the shell renders above as
        // editing (zones hidden) the instant editing starts.
        if (!selected) onSelect();
        event.preventDefault();
        onEditingChange(true);
        // Focus the textarea itself, not the article wrapper.
        const textarea = event.currentTarget.querySelector('textarea');
        if (textarea) textarea.focus();
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Board note"
        value={value}
        readOnly={!editing}
        style={{
          overflow: 'hidden',
          userSelect: editing ? 'auto' : 'none',
          fontSize: `${fontSize}px`,
          lineHeight: 1.4,
          resize: 'none',
        }}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (editing) {
            onEditingChange(false);
            onSave(value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.blur();
          }
        }}
      />
    </article>
  );
}
