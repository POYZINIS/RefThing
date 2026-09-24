import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Choice = { label: string; active?: boolean; action: () => void };
type Entry = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
  /** Renders the entry as a labelled row of inline choices (e.g. opacity
   *  presets) instead of a single command. */
  choices?: Choice[];
};

export function BoardContextMenu({
  position,
  entries,
  onClose,
}: {
  position: { x: number; y: number };
  entries: Entry[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState(position);
  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect();
    if (!rect) return;
    setLocation({
      x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8)),
    });
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [position]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = [
        ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
      ]?.focus();
    };
    window.addEventListener('pointerdown', closeOutside);
    menu.current?.addEventListener('keydown', onKeyDown);
    const element = menu.current;
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      element?.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
  return (
    <div
      ref={menu}
      className="board-context-menu"
      role="menu"
      aria-label="Board actions"
      style={{ left: location.x, top: location.y }}
    >
      {entries.map((entry) =>
        entry.choices ? (
          <fieldset key={entry.label} className="menu-choices">
            <legend>{entry.label}</legend>
            {entry.choices.map((choice) => (
              <button
                key={choice.label}
                type="button"
                role="menuitemradio"
                aria-checked={choice.active ?? false}
                onClick={() => {
                  onClose();
                  choice.action();
                }}
              >
                {choice.label}
              </button>
            ))}
          </fieldset>
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.action();
            }}
          >
            <span>{entry.label}</span>
            {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
