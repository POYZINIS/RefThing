/**
 * Canonical motion primitives — RefThing_Testing_Conventions.txt §1/§2.
 * Every gesture test (unit or browser) samples its pointer path from HERE so
 * results stay comparable across the suite. Do not invent ad hoc paths;
 * extend the conventions document first.
 *
 * Each primitive returns samples `{ index, timeMs, x, y }`: one synthetic
 * pointermove each, 16ms apart, padded to at least 30 samples (§2 rules 1–2).
 */

export const SAMPLE_INTERVAL_MS = 16;
export const MIN_SAMPLES = 30;

/** §2: 16ms cadence, never fewer than 30 samples (short gestures sample faster). */
export function sampleCount(durationMs) {
  return Math.max(MIN_SAMPLES, Math.ceil(durationMs / SAMPLE_INTERVAL_MS));
}

function sampleTimes(durationMs) {
  const count = sampleCount(durationMs);
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    // i = 1..count so the last sample lands exactly on the end of the path.
    u: (i + 1) / count,
    timeMs: ((i + 1) / count) * durationMs,
  }));
}

/**
 * FIGURE-8 (item drag, camera pan):
 *   x(t) = cx + ax·sin(t),  y(t) = cy + ay·sin(t)·cos(t),  t: 0 → 2π per loop.
 * Variants: slow ≈ 2000ms, fast ≈ 200ms, and 3 consecutive loops.
 */
export function figureEight({ centerX, centerY, amplitudeX, amplitudeY, durationMs, loops = 1 }) {
  return sampleTimes(durationMs).map(({ index, u, timeMs }) => {
    const t = u * loops * 2 * Math.PI;
    return {
      index,
      timeMs,
      x: centerX + amplitudeX * Math.sin(t),
      y: centerY + amplitudeY * Math.sin(t) * Math.cos(t),
    };
  });
}

/**
 * SINE-WAVE HANDLE PATH (resize, all 8 zones).
 *   primary(t) = lerp(0, delta, t/T)
 *   offAxis(t) = amplitude · sin(2π · frequency · t/T)   (frequency = full
 *                oscillations over the whole gesture)
 * Corner: both axes ramp toward `delta`; the wobble is perpendicular to that
 * diagonal. Edge: the controlling axis ramps; the wobble runs ALONG the edge
 * (the axis the zone must ignore).
 */
export function sineWaveHandle({
  startX,
  startY,
  deltaX,
  deltaY,
  zoneKind,
  amplitude,
  frequency,
  durationMs,
}) {
  const length = Math.hypot(deltaX, deltaY) || 1;
  const perpendicular =
    zoneKind === 'corner'
      ? { x: -deltaY / length, y: deltaX / length }
      : deltaX !== 0
        ? { x: 0, y: 1 } // left/right edge: wobble vertically, along the edge
        : { x: 1, y: 0 }; // top/bottom edge: wobble horizontally
  return sampleTimes(durationMs).map(({ index, u, timeMs }) => {
    const wobble = amplitude * Math.sin(2 * Math.PI * frequency * u);
    return {
      index,
      timeMs,
      x: startX + deltaX * u + perpendicular.x * wobble,
      y: startY + deltaY * u + perpendicular.y * wobble,
    };
  });
}

/**
 * ROTATION SWEEP: angle(t) = startAngle + (t/T)·totalSweep (degrees), sampled
 * on a circle of `radius` around the pivot. Pass `segments` to chain sweeps in
 * one held gesture (the mid-drag reversal variant).
 */
export function rotationSweep({ centerX, centerY, radius, startAngle = 0, segments, durationMs }) {
  const samples = [];
  let angle = startAngle;
  let index = 0;
  let elapsed = 0;
  for (const sweep of segments) {
    const segmentMs = durationMs / segments.length;
    for (const { u, timeMs } of sampleTimes(segmentMs)) {
      const current = angle + sweep * u;
      const radians = (current * Math.PI) / 180;
      samples.push({
        index: index++,
        timeMs: elapsed + timeMs,
        angle: current,
        x: centerX + radius * Math.cos(radians),
        y: centerY + radius * Math.sin(radians),
      });
    }
    angle += sweep;
    elapsed += segmentMs;
  }
  return samples;
}

/** §4 rule 4: every failure names the sample index and time in the gesture. */
export function at(sample, message) {
  return `sample #${sample.index} @ ${sample.timeMs.toFixed(1)}ms: ${message}`;
}
