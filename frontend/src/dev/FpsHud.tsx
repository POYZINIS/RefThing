import { useEffect, useState } from 'react';
import { type FrameSummary, frameStats } from './frameStats';

/**
 * Dev-only FPS HUD. Measures real frame cadence with its own
 * requestAnimationFrame loop (frame times, avg fps, p50/p99 over a rolling
 * 240-frame window) and feeds the shared frameStats singleton so other dev
 * tooling can read the same numbers. BoardCanvas exposes no internal
 * sprite/texture counters, so this HUD reports frame timing only.
 */
export function FpsHud() {
  const [summary, setSummary] = useState<FrameSummary>(() => frameStats.summary());

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      frameStats.record(now - last);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const timer = window.setInterval(() => setSummary(frameStats.summary()), 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, []);

  if (!import.meta.env.DEV) return null;

  return (
    <div
      data-fps-hud="true"
      style={{
        position: 'fixed',
        top: 8,
        right: 8,
        zIndex: 9999,
        padding: '6px 10px',
        borderRadius: 6,
        background: 'rgba(10, 12, 16, 0.8)',
        color: '#9fe870',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      {`fps  ${summary.avgFps.toFixed(1)}\n`}
      {`avg  ${summary.avgMs.toFixed(2)}ms\n`}
      {`p50  ${summary.p50Ms.toFixed(2)}ms\n`}
      {`p99  ${summary.p99Ms.toFixed(2)}ms`}
    </div>
  );
}
