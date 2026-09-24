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
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
  onSave: (content: string) => void;
  onMove: (noteId: string, x: number, y: number) => void;
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
 * note ALWAYS means select/move (§4 RULE 1) — identical to an image. It is
 * only editable on double-click (§4 RULE 2).
 *
 * Drag math mirrors images: snapshot pointer + note position at pointerdown,
 * on move set `note = start + delta`, commit on pointerup. The drag runs on
 * WINDOW listeners so it survives the SelectionOverlay shell appearing above
 * the article the moment the note becomes selected — the same reason the
 * shell itself listens on window.
 *
 * When selected, the article is inert for gestures (the shell owns move,
 * resize, rotate). Only hover + double-click-to-edit remain meaningful, and
 * the shell forwards double-clicks.
 */
export function NoteOverlay({
  note,
  viewport,
  selected,
  editing,
  onSelect,
  onHover,
  onSave,
  onMove,
  onEditingChange,
}: NoteOverlayProps) {
  const [value, setValue] = useState(noteText(note.content_json));
  const drag = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    // Frozen note position at drag start (world-space).
    startNoteX: number;
    startNoteY: number;
  } | null>(null);
  const moved = useRef(false);
  const lastPointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

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

  const moveDrag = (event: PointerEvent): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    // After onSelect() fires, the SelectionOverlay takes over all move/
    // resize/rotate.  Bail so the note's own drag system stops processing
    // — otherwise BOTH the note and the overlay move the item, doubling
    // the apparent movement on the first drag of an unselected note.
    if (selected) { drag.current = null; return; }
    if (Math.abs(event.clientX - d.startScreenX) + Math.abs(event.clientY - d.startScreenY) > 3) {
      moved.current = true;
    }
    if (!moved.current) return;
    // Store the latest pointer position — the actual offset is derived
    // during render so it always uses the CURRENT viewport (pan follows).
    lastPointer.current = { x: event.clientX, y: event.clientY };
    // Trigger a re-render so the inline style updates.
    setRenderTick((t) => t + 1);
  };

  const endDrag = (event: PointerEvent): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!moved.current || selected) return;
    // Compute final world position using the current viewport.
    const vp = viewportRef.current;
    const worldDx = (event.clientX - d.startScreenX) / vp.zoom;
    const worldDy = (event.clientY - d.startScreenY) / vp.zoom;
    const nextX = d.startNoteX + worldDx;
    const nextY = d.startNoteY + worldDy;
    onMove(noteRef.current.id, nextX, nextY);
  };

  // Drag runs on window listeners (matching SelectionOverlay) so it survives
  // the transform shell appearing above the article mid-gesture. The handlers
  // read through refs so the once-registered listeners never go stale.
  const onMoveRef = useRef<(event: PointerEvent) => void>(() => undefined);
  onMoveRef.current = moveDrag;
  const onUpRef = useRef<(event: PointerEvent) => void>(() => undefined);
  onUpRef.current = endDrag;
  useEffect(() => {
    const onMove = (event: PointerEvent) => onMoveRef.current(event);
    const onUp = (event: PointerEvent) => onUpRef.current(event);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const [_renderTick, setRenderTick] = useState(0);

  const beginDrag = (event: React.PointerEvent): void => {
    if (editing || selected) return;
    moved.current = false;
    const n = noteRef.current;
    drag.current = {
      pointerId: event.pointerId,
      startScreenX: event.clientX,
      startScreenY: event.clientY,
      startNoteX: n.x,
      startNoteY: n.y,
    };
    lastPointer.current = { x: event.clientX, y: event.clientY };
    // Selecting (and bringing to front) happens on press, not release —
    // exactly like clicking an image sprite.
    onSelect();
    // No setPointerCapture — the window listeners already handle the
    // gesture, and pointer capture would route events to the inert note
    // after the SelectionOverlay appears, causing double processing.
  };

  // Render-time offset: recomputed every render using the CURRENT viewport,
  // so panning mid-drag keeps the note glued to the cursor.
  const dragOffsetX = (() => {
    const d = drag.current;
    if (!d || !moved.current) return 0;
    return (lastPointer.current.x - d.startScreenX) / viewport.zoom;
  })();
  const dragOffsetY = (() => {
    const d = drag.current;
    if (!d || !moved.current) return 0;
    return (lastPointer.current.y - d.startScreenY) / viewport.zoom;
  })();

  // Font size scales with note height.  The base design is ~12px at h=145.
  const fontSize = Math.max(8, note.height * 0.083);

  return (
    <article
      className={`note-overlay${editing ? ' note-overlay-editing' : ''}${
        selected ? ' note-overlay-selected' : ''
      }`}
      style={{
        left: viewport.x + (note.x + dragOffsetX) * viewport.zoom,
        top: viewport.y + (note.y + dragOffsetY) * viewport.zoom,
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
      onPointerDown={beginDrag}
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
