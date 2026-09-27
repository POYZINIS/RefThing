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
type TauriGlobal = {
  window?: { getCurrentWindow?: () => TauriWindow };
  dpi?: { PhysicalPosition: new (x: number, y: number) => unknown };
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
