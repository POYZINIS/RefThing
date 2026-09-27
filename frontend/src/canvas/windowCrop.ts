/**
 * Resizing the window crops the board, it doesn't drag it: when a resize
 * moves the window's top-left corner (the left or top edge, or any corner but
 * bottom-right), the camera shifts by the opposite amount so everything stays
 * where it is on screen. A plain window move (no size change) still carries
 * the board with it, and maximizing or restoring keeps the old anchoring (the
 * window jumps across the screen; cropping would push content out of view).
 */

/** The window's client area on screen, CSS px (window.screenX… / inner…). */
export type WindowFrame = { x: number; y: number; width: number; height: number };

/** How close to the available screen counts as maximized (frame slack). */
const MAXIMIZED_SLACK_PX = 4;

export function readWindowFrame(): WindowFrame {
  return {
    x: window.screenX,
    y: window.screenY,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * The camera shift (screen px, subtract from the viewport origin) for a
 * resize from `last` to `next`, or null when the board should stay anchored
 * to the window (a move, a bottom/right resize, maximize / restore).
 */
export function cropShift(
  last: WindowFrame,
  next: WindowFrame,
  screen: { availWidth: number; availHeight: number },
): { dx: number; dy: number } | null {
  const resized = next.width !== last.width || next.height !== last.height;
  const dx = next.x - last.x;
  const dy = next.y - last.y;
  if (!resized || (dx === 0 && dy === 0)) return null;
  const maximized = (frame: WindowFrame) =>
    frame.width >= screen.availWidth - MAXIMIZED_SLACK_PX &&
    frame.height >= screen.availHeight - MAXIMIZED_SLACK_PX;
  if (maximized(last) || maximized(next)) return null;
  return { dx, dy };
}

/** One sampled step of a smooth edge drag: the total crop owed at `time`. */
export type CropSample = { time: number; x: number; y: number };

/**
 * The owed crop at `time`, on a smooth curve through the sampled steps:
 * each segment is a cubic Bézier whose control points come from
 * Catmull-Rom tangents (finite differences over the samples' own timing,
 * kept monotone), so uneven, bursty resize steps become one continuous
 * motion that never overshoots. Before the
 * first sample it holds the first; after the last, the last.
 */
export function sampleCropCurve(
  samples: readonly CropSample[],
  time: number,
): { x: number; y: number } {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return { x: 0, y: 0 };
  if (time <= first.time) return { x: first.x, y: first.y };
  if (time >= last.time) return { x: last.x, y: last.y };
  let index = 0;
  while (index < samples.length - 2 && (samples[index + 1]?.time ?? Infinity) < time) index += 1;
  const p1 = samples[index] as CropSample;
  const p2 = samples[index + 1] as CropSample;
  const p0 = samples[index - 1] ?? p1;
  const p3 = samples[index + 2] ?? p2;
  const span = Math.max(1e-6, p2.time - p1.time);
  const u = (time - p1.time) / span;
  // Tangents per unit of this segment: the slope across the neighbouring
  // samples' time, scaled to this segment's span (one-sided at the ends).
  const tangent = (before: CropSample, after: CropSample, key: 'x' | 'y') =>
    after.time > before.time ? ((after[key] - before[key]) / (after.time - before.time)) * span : 0;
  // Monotone (Fritsch–Carlson): a tangent never points against its segment
  // or exceeds three times its rise, so the camera never overshoots a step
  // and backs up — smooth, but always heading where the window went.
  const limit = (slope: number, rise: number) =>
    rise === 0 || Math.sign(slope) !== Math.sign(rise)
      ? 0
      : Math.sign(rise) * Math.min(Math.abs(slope), 3 * Math.abs(rise));
  const axis = (key: 'x' | 'y') => {
    const a = p1[key];
    const d = p2[key];
    const b = a + limit(tangent(p0, p2, key), d - a) / 3;
    const c = d - limit(tangent(p1, p3, key), d - a) / 3;
    const v = 1 - u;
    return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
  };
  return { x: axis('x'), y: axis('y') };
}
