import { type ReactNode, useSyncExternalStore } from 'react';
import type { ViewportState } from './BoardCanvas';

/**
 * The camera Pixi actually painted this frame, as a tiny external store.
 *
 * It changes every frame while the camera eases, so it must NOT live in App
 * state: that re-rendered the whole shell (toolbars, search bar, …) per frame.
 * Only the DOM chrome that sits on the canvas subscribes (via CameraBound);
 * non-render code reads `renderedCamera.get()`.
 */
let camera: ViewportState = { x: 0, y: 0, zoom: 1 };
const listeners = new Set<() => void>();

export const renderedCamera = {
  get: (): ViewportState => camera,
  set(next: ViewportState): void {
    camera = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useRenderedCamera(): ViewportState {
  return useSyncExternalStore(renderedCamera.subscribe, renderedCamera.get);
}

/** Re-renders only its children when the rendered camera moves. */
export function CameraBound({ children }: { children: (camera: ViewportState) => ReactNode }) {
  return children(useRenderedCamera());
}
