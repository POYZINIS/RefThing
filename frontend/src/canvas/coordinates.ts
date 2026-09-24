import type { ViewportState } from './BoardCanvas';

type ClientPoint = Pick<PointerEvent, 'clientX' | 'clientY'>;

/**
 * The canonical coordinate conversion for canvas input and DOM overlays.
 * Keeping it here ensures hit-testing, drag deltas, and overlay placement
 * all agree while a board is panned or zoomed.
 */
export function screenToWorld(
  point: ClientPoint,
  viewport: ViewportState,
  bounds: Pick<DOMRect, 'left' | 'top'>,
): { x: number; y: number } {
  return {
    x: (point.clientX - bounds.left - viewport.x) / viewport.zoom,
    y: (point.clientY - bounds.top - viewport.y) / viewport.zoom,
  };
}

export function worldToScreen(
  point: { x: number; y: number },
  viewport: ViewportState,
  bounds: Pick<DOMRect, 'left' | 'top'>,
): { x: number; y: number } {
  return {
    x: bounds.left + viewport.x + point.x * viewport.zoom,
    y: bounds.top + viewport.y + point.y * viewport.zoom,
  };
}
