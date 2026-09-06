import { useEffect, useState } from 'react';
import type { Note } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';

type NoteOverlayProps = {
  note: Note;
  viewport: ViewportState;
  onSave: (content: string) => void;
};

function noteText(content: unknown): string {
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

export function NoteOverlay({ note, viewport, onSave }: NoteOverlayProps) {
  const [value, setValue] = useState(noteText(note.content_json));
  useEffect(() => setValue(noteText(note.content_json)), [note.content_json]);

  return (
    <article
      className="note-overlay"
      style={{
        left: viewport.x + note.x * viewport.zoom,
        top: viewport.y + note.y * viewport.zoom,
        width: note.width * viewport.zoom,
        height: note.height * viewport.zoom,
        opacity: note.opacity,
        backgroundColor: note.bg_color ?? '#f5e7ad',
      }}
    >
      <textarea
        aria-label="Board note"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => onSave(value)}
      />
    </article>
  );
}
