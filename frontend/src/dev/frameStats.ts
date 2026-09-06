export type FrameSummary = {
  frames: number;
  avgFps: number;
  avgMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
};

type FrameListener = (deltaMs: number) => void;

const WINDOW_SIZE = 240;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarizeFrameTimes(samples: number[]): FrameSummary {
  if (samples.length === 0) {
    return { frames: 0, avgFps: 0, avgMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  const avgMs = total / samples.length;
  return {
    frames: samples.length,
    avgFps: avgMs > 0 ? 1000 / avgMs : 0,
    avgMs,
    p50Ms: percentile(sorted, 50),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Process-wide frame-time singleton for dev tooling. FpsHud feeds it from its
 * own requestAnimationFrame loop; anything else (the DevBoard tour, playwright
 * drivers) can subscribe or read the rolling 240-frame window. BoardCanvas
 * does not know this exists.
 */
class FrameStatsEmitter {
  private readonly window: number[] = [];
  private readonly listeners = new Set<FrameListener>();

  record(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return;
    this.window.push(deltaMs);
    if (this.window.length > WINDOW_SIZE) this.window.shift();
    for (const listener of this.listeners) listener(deltaMs);
  }

  reset(): void {
    this.window.length = 0;
  }

  /** Summary over the rolling 240-frame window. */
  summary(): FrameSummary {
    return summarizeFrameTimes(this.window);
  }

  /** Observe every recorded frame delta; returns an unsubscribe function. */
  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const frameStats = new FrameStatsEmitter();
