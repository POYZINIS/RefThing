import type { ViewportState } from './BoardCanvas';

type ClientPoint = Pick<PointerEvent, 'clientX' | 'clientY'>;

/** The camera's zoom range, for every path that sets it (wheel, Z-drag,
 *  fit, saved views). 1% lets a huge board (imported PureRef boards span
 *  tens of thousands of px) be seen whole; images draw from their 64px
 *  pyramid level out there, so it stays cheap. */
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 4;
export const clampZoom = (zoom: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

/** One mouse-wheel notch (100 px of deltaY) zooms by this much at speed 1. */
export const WHEEL_ZOOM_PER_NOTCH = 1.25;

/**
 * Zoom multiplier for one wheel event. Deltas are normalised (line and page
 * modes → px) and mapped exponentially, so a notched wheel, a free-spinning
 * one and a trackpad all zoom in proportion to how far they scrolled.
 * `speed` is the user's setting (1 = default).
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, speed: number): number {
  const px = deltaY * (deltaMode === 1 ? 40 : deltaMode === 2 ? 800 : 1);
  // One event never jumps more than three notches (a flung wheel).
  const clamped = Math.max(-300, Math.min(300, px));
  return Math.exp((-clamped * speed * Math.log(WHEEL_ZOOM_PER_NOTCH)) / 100);
}

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
