import { useEffect, useState } from 'react';
import { desktopWindow, watchWindowState } from '@/shell/desktop';
import { Icon } from '@/ui/Icon';

const PIN_KEY = 'refthing.alwaysOnTop';

function loadPinned(): boolean {
  try {
    return globalThis.localStorage?.getItem(PIN_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * The frameless desktop window's own controls (upper right): always on top,
 * minimize, maximize/restore, close. Absent in the browser. Closing the
 * window sits here, apart from every board action, so the two X's never
 * share a scope.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [pinned, setPinned] = useState(loadPinned);

  useEffect(() => watchWindowState(({ maximized: next }) => setMaximized(next)), []);
  useEffect(() => {
    void desktopWindow?.setAlwaysOnTop(pinned).catch(() => undefined);
    try {
      globalThis.localStorage?.setItem(PIN_KEY, String(pinned));
    } catch {
      // The pin still holds for this session.
    }
  }, [pinned]);

  const window = desktopWindow;
  if (!window) return null;
  return (
    <div className="control-group window-controls" role="toolbar" aria-label="Window">
      <button
        className="icon-button"
        type="button"
        aria-pressed={pinned}
        aria-label="Always on top"
        title={pinned ? 'Stop keeping on top' : 'Keep on top of other windows'}
        onClick={() => setPinned((value) => !value)}
      >
        <Icon name="pin" />
      </button>
      <button
        className="icon-button"
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void window.minimize()}
      >
        <Icon name="minimize" />
      </button>
      <button
        className="icon-button"
        type="button"
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void window.toggleMaximize()}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={15} />
      </button>
      <button
        className="icon-button window-close"
        type="button"
        aria-label="Close window"
        title="Close"
        onClick={() => void window.close()}
      >
        <Icon name="windowClose" />
      </button>
    </div>
  );
}
