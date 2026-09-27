import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
      /** A nested menu, opened beside this row by hover, click or →. */
      submenu?: Entry[];
    };

/** Every enabled button of the menu (or submenu) holding `element`. */
function siblingsOf(element: Element | null): HTMLButtonElement[] {
  const menu = element?.closest('[role="menu"]');
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(
    (button) => button.closest('[role="menu"]') === menu,
  );
}

export function BoardContextMenu({
  position,
  entries,
  onClose,
}: {
  position: { x: number; y: number };
  entries: Entry[];
  onClose: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState(position);
  /** The open submenu: its row's label and where the row is on screen. */
  const [open, setOpen] = useState<{ label: string; row: DOMRect; focus: boolean } | null>(null);
  const [subAt, setSubAt] = useState<{ x: number; y: number } | null>(null);
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
  // A submenu sits beside its row — to the right, or to the left when the
  // right would leave the window — and never below the bottom edge.
  useLayoutEffect(() => {
    const element = sub.current;
    if (!open || !element) {
      setSubAt(null);
      return;
    }
    const { offsetWidth: width, offsetHeight: height } = element;
    const right = open.row.right + 2;
    const x = right + width + 8 <= window.innerWidth ? right : open.row.left - width - 2;
    const y = Math.max(8, Math.min(open.row.top - 5, window.innerHeight - height - 8));
    setSubAt({ x: Math.max(8, x), y });
    enter(element, 'pop');
  }, [open]);
  // Opened from the keyboard: focus its first entry once it's placed (a
  // hidden element — while it's measured — can't take focus).
  useEffect(() => {
    if (subAt && open?.focus) {
      sub.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  }, [subAt, open]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!layer.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        onClose();
        return;
      }
      // A text field keeps its own keys (the tag name being typed).
      if (event.target instanceof HTMLInputElement) return;
      const focused = document.activeElement;
      if (event.key === 'ArrowLeft' && sub.current?.contains(focused)) {
        // Back out of the submenu onto its row.
        event.preventDefault();
        const label = open?.label;
        setOpen(null);
        menu.current
          ?.querySelector<HTMLButtonElement>(`button[data-submenu="${CSS.escape(label ?? '')}"]`)
          ?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = siblingsOf(focused);
      const index = buttons.indexOf(focused as HTMLButtonElement);
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
      ]?.focus();
    };
    window.addEventListener('pointerdown', closeOutside);
    const element = layer.current;
    element?.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      element?.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  const renderEntries = (list: Entry[], nested: boolean): ReactNode =>
    list.map((entry) =>
      entry.separator ? (
        <hr key={entry.label} className="menu-separator" />
      ) : entry.submenu ? (
        <button
          key={entry.label}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open?.label === entry.label}
          data-submenu={entry.label}
          className={open?.label === entry.label ? 'open' : undefined}
          disabled={entry.disabled}
          onPointerEnter={(event) =>
            setOpen({
              label: entry.label,
              row: event.currentTarget.getBoundingClientRect(),
              focus: false,
            })
          }
          onClick={(event) =>
            setOpen({
              label: entry.label,
              row: event.currentTarget.getBoundingClientRect(),
              focus: event.detail === 0,
            })
          }
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight') return;
            event.preventDefault();
            setOpen({
              label: entry.label,
              row: event.currentTarget.getBoundingClientRect(),
              focus: true,
            });
          }}
        >
          <span>{entry.label}</span>
          <Icon name="chevronRight" size={15} />
        </button>
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
        <fieldset
          key={entry.label}
          className="menu-choices"
          onPointerEnter={nested ? undefined : () => setOpen(null)}
        >
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
          onPointerEnter={nested ? undefined : () => setOpen(null)}
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
          onPointerEnter={nested ? undefined : () => setOpen(null)}
          onClick={() => {
            onClose();
            entry.action();
          }}
        >
          <span>{entry.label}</span>
          {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
        </button>
      ),
    );

  const openEntry = open
    ? entries.find((entry) => !entry.separator && entry.label === open.label)
    : undefined;
  const submenu = openEntry && !openEntry.separator ? openEntry.submenu : undefined;
  return (
    <div ref={layer} className="board-context-menu-layer">
      <div
        ref={menu}
        className="board-context-menu"
        role="menu"
        aria-label="Board actions"
        style={{ left: location.x, top: location.y }}
      >
        {renderEntries(entries, false)}
      </div>
      {open && submenu && (
        <div
          ref={sub}
          className="board-context-menu submenu"
          role="menu"
          aria-label={open.label}
          // Measured first (hidden), then placed beside its row.
          style={
            subAt
              ? { left: subAt.x, top: subAt.y }
              : { left: open.row.right, top: open.row.top, visibility: 'hidden' }
          }
        >
          {renderEntries(submenu, true)}
        </div>
      )}
    </div>
  );
}
