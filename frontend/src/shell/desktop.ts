/**
 * The desktop shell bridge (src-tauri): a frameless window whose controls,
 * pin and backdrop the chrome draws itself. Reached through the global Tauri
 * API (app.withGlobalTauri), so the browser build carries no Tauri code and
 * every export here is inert when `desktopWindow` is null.
 */
type Position = { x: number; y: number };
type TauriWindow = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  setAlwaysOnTop(onTop: boolean): Promise<void>;
  outerPosition(): Promise<Position>;
  setPosition(position: unknown): Promise<void>;
  scaleFactor(): Promise<number>;
  setEffects(effects: {
    effects: string[];
    color?: [number, number, number, number];
  }): Promise<void>;
  clearEffects(): Promise<void>;
  onResized(handler: () => void): Promise<() => void>;
};
type FileFilter = { name: string; extensions: string[] };
type TauriGlobal = {
  window?: { getCurrentWindow?: () => TauriWindow };
  dpi?: { PhysicalPosition: new (x: number, y: number) => unknown };
  dialog?: {
    save(options: { defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
    open(options: {
      multiple?: boolean;
      directory?: boolean;
      defaultPath?: string;
      title?: string;
      filters?: FileFilter[];
    }): Promise<string | string[] | null>;
  };
  event?: {
    listen(name: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
  };
};

const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;

export const desktopWindow: TauriWindow | null = tauri?.window?.getCurrentWindow?.() ?? null;
export const isDesktop = desktopWindow !== null;

if (isDesktop && typeof document !== 'undefined') {
  document.documentElement.dataset.shell = 'desktop';
}

/** Native backdrop behind the transparent workspace: Acrylic, a real blur
 *  of what's behind the window (the src-tauri window starts with it; the
 *  tint matches ACRYLIC_TINT there). */
export function setNativeGlass(enabled: boolean): void {
  if (!desktopWindow) return;
  const done = enabled
    ? desktopWindow.setEffects({ effects: ['acrylic'], color: [30, 34, 32, 24] })
    : desktopWindow.clearEffects();
  done.catch(() => undefined); // older Windows: no material, the solid workspace stands
}

/** Window state the controls reflect (maximized/fullscreen square the corners). */
export function watchWindowState(onChange: (state: { maximized: boolean }) => void): () => void {
  const window = desktopWindow;
  if (!window) return () => undefined;
  let alive = true;
  const read = () => {
    void Promise.all([window.isMaximized(), window.isFullscreen()]).then(([max, full]) => {
      if (!alive) return;
      document.documentElement.dataset.windowEdge = max || full ? 'square' : 'round';
      onChange({ maximized: max });
    });
  };
  read();
  const unlisten = window.onResized(read);
  return () => {
    alive = false;
    void unlisten.then((stop) => stop());
  };
}

/**
 * Right-drag moves the window (plan: MOUSE table, `move_window`). Starts on
 * press, moves once the pointer passes `threshold` px — below that the press
 * is a click and the context menu owns it. Returns false when there is no
 * desktop window to move.
 */
export function beginWindowMove(event: PointerEvent, threshold: number): boolean {
  const window = desktopWindow;
  const Position = tauri?.dpi?.PhysicalPosition;
  if (!window || !Position) return false;
  const start = { x: event.screenX, y: event.screenY };
  const origin = Promise.all([window.outerPosition(), window.scaleFactor()]);
  const target = event.target instanceof Element ? event.target : null;
  target?.setPointerCapture?.(event.pointerId);
  let moving = false;
  let frame = 0;
  let latest = start;
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    latest = { x: next.screenX, y: next.screenY };
    if (!moving && Math.hypot(latest.x - start.x, latest.y - start.y) < threshold) return;
    moving = true;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const { x, y } = latest;
      void origin.then(([position, scale]) =>
        window.setPosition(
          new Position(
            Math.round(position.x + (x - start.x) * scale),
            Math.round(position.y + (y - start.y) * scale),
          ),
        ),
      );
    });
  };
  const end = (last: PointerEvent) => {
    if (last.pointerId !== event.pointerId) return;
    globalThis.removeEventListener('pointermove', move);
    globalThis.removeEventListener('pointerup', end);
    globalThis.removeEventListener('pointercancel', end);
    if (frame) cancelAnimationFrame(frame);
  };
  globalThis.addEventListener('pointermove', move);
  globalThis.addEventListener('pointerup', end);
  globalThis.addEventListener('pointercancel', end);
  return true;
}

// ------------------------------------------------------------ board files

const BOARD_FILTER: FileFilter[] = [{ name: 'RefThing board', extensions: ['ref'] }];

/** Where to keep a board's `.ref` file (the native save dialog); null when
 *  cancelled or not on the desktop. */
export async function chooseBoardFileToSave(defaultName: string): Promise<string | null> {
  const dialog = tauri?.dialog;
  if (!dialog) return null;
  return dialog.save({ defaultPath: defaultName, filters: BOARD_FILTER });
}

/** A `.ref` file to open (the native open dialog). */
export async function chooseBoardFileToOpen(): Promise<string | null> {
  const dialog = tauri?.dialog;
  if (!dialog) return null;
  const picked = await dialog.open({ multiple: false, filters: BOARD_FILTER });
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

/** A folder (the native folder dialog), starting at `defaultPath`; null
 *  when cancelled or not on the desktop. */
export async function chooseFolder(title: string, defaultPath?: string): Promise<string | null> {
  const dialog = tauri?.dialog;
  if (!dialog) return null;
  const picked = await dialog.open({ directory: true, multiple: false, defaultPath, title });
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

/** `.ref` files opened from Explorer while the app runs (a second launch
 *  hands its file to this window — src-tauri). */
export function onBoardFileOpened(handler: (path: string) => void): () => void {
  const listen = tauri?.event?.listen;
  if (!listen) return () => undefined;
  let stop: (() => void) | null = null;
  let alive = true;
  void listen('open-board-file', (event) => {
    if (typeof event.payload === 'string') handler(event.payload);
  }).then((unlisten) => {
    if (alive) stop = unlisten;
    else unlisten();
  });
  return () => {
    alive = false;
    stop?.();
  };
}

/** The `.ref` file the app was launched to open (`?open=`), taken off the
 *  URL so a reload doesn't open it again. */
export function takeLaunchBoardFile(): string | null {
  if (typeof location === 'undefined') return null;
  const url = new URL(location.href);
  const path = url.searchParams.get('open');
  if (!path) return null;
  url.searchParams.delete('open');
  history.replaceState(history.state, '', url);
  return path;
}
