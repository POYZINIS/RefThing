import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/ui/Icon';
import { enter } from '@/ui/motion';

export type { Entry as MenuEntry };

type Choice = {
  label: string;
  active?: boolean;
  action: () => void;
  /** Render as a colour swatch (the label becomes its accessible name);
   *  null = "none", 'auto' = the automatic colour. */
  swatch?: string | null;
  /** An independent on/off (Bold, Italic) rather than one-of-several. */
  toggle?: boolean;
  /** Render this glyph-like label in a font (e.g. font previews). */
  font?: string;
};
type Entry =
  | { separator: true; label: string }
  | {
      separator?: false;
      label: string;
      /** A checkable entry (e.g. Grayscale): renders a check when on. */
      checked?: boolean;
      shortcut?: string;
      disabled?: boolean;
      action: () => void;
      /** Renders the entry as a labelled row of inline choices (e.g. opacity
       *  presets) instead of a single command. */
      choices?: Choice[];
      /** Picking a choice leaves the menu open (styling several things). */
      keepOpen?: boolean;
      /** Renders an inline text field; Enter submits (e.g. "New tag…"). */
      input?: { placeholder: string; onSubmit: (value: string) => void };
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
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    enter(menu.current, 'pop');
  }, []);
  // Keep the whole menu on screen, re-measured whenever it changes size
  // (fonts arriving, rows re-rendering as a note is styled).
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const place = () => {
      // Layout size, not the bounding box: the pop-in animation scales it.
      const { offsetWidth: width, offsetHeight: height } = element;
      const next = {
        x: Math.max(8, Math.min(position.x, window.innerWidth - width - 8)),
        y: Math.max(8, Math.min(position.y, window.innerHeight - height - 8)),
      };
      setLocation((current) => (current.x === next.x && current.y === next.y ? current : next));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
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
      // A text field keeps its own keys (the tag name being typed).
      if (event.target instanceof HTMLInputElement) return;
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
        entry.separator ? (
          <hr key={entry.label} className="menu-separator" />
        ) : entry.input ? (
          <form
            key={entry.label}
            className="menu-input"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get('value')?.toString().trim();
              if (!value) return;
              onClose();
              entry.input?.onSubmit(value);
            }}
          >
            <input name="value" aria-label={entry.label} placeholder={entry.input.placeholder} />
          </form>
        ) : entry.choices ? (
          <fieldset key={entry.label} className="menu-choices">
            <legend>{entry.label}</legend>
            {entry.choices.map((choice) => {
              const pick = () => {
                if (!entry.keepOpen) onClose();
                choice.action();
              };
              const swatch = choice.swatch !== undefined;
              const checked = choice.active ?? false;
              const common = {
                'aria-label': swatch ? choice.label : undefined,
                className: swatch
                  ? `menu-swatch ${choice.swatch === null ? 'none' : ''} ${choice.swatch === 'auto' ? 'auto' : ''}`
                  : undefined,
                style: swatch
                  ? {
                      background:
                        choice.swatch && choice.swatch !== 'auto' ? choice.swatch : undefined,
                    }
                  : choice.font
                    ? { fontFamily: choice.font }
                    : undefined,
                onClick: pick,
              };
              const content = swatch ? null : choice.label;
              return choice.toggle ? (
                <button
                  key={choice.label}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  {...common}
                >
                  {content}
                </button>
              ) : (
                <button
                  key={choice.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  {...common}
                >
                  {content}
                </button>
              );
            })}
          </fieldset>
        ) : entry.checked !== undefined ? (
          <button
            key={entry.label}
            type="button"
            role="menuitemcheckbox"
            aria-checked={entry.checked}
            disabled={entry.disabled}
            onClick={() => {
              if (!entry.keepOpen) onClose();
              entry.action();
            }}
          >
            <span>{entry.label}</span>
            <span className="menu-check">{entry.checked && <Icon name="check" size={15} />}</span>
          </button>
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
