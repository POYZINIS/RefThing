import { useEffect, useRef, useState } from 'react';
import type { Item } from '@/api/client';
import { BoardCanvas } from '@/canvas/BoardCanvas';
import { useBoardStore } from '@/state/boardStore';
import { FpsHud } from './FpsHud';
import { frameStats, summarizeFrameTimes } from './frameStats';
import {
  generateSynthBoard,
  installSynthImageInterception,
  registerSynthImages,
  SYNTH_BOARD_ID,
} from './synthBoard';

export type DevBoardProps = {
  /** Item count; defaults to ?count= or the /dev/board/:count path segment, then 5000. */
  count?: number;
  /** PRNG seed; defaults to ?seed=, then 1. */
  seed?: number;
  /** Run the scripted 5s pan/zoom perf tour on load; defaults to ?tour=1. */
  tour?: boolean;
};

export type PerfSummary = {
  type: 'refthing-perf-summary';
  count: number;
  seed: number;
  frames: number;
  durationMs: number;
  avgFps: number;
  avgMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  glRenderer: string;
  gate: { target: string; thresholdMs: number; pass: boolean };
};

const TOUR_DURATION_MS = 5000;
const GATE_THRESHOLD_MS = 16.6;

function parseParams(props: DevBoardProps): Required<DevBoardProps> {
  const params = new URLSearchParams(window.location.search);
  const pathCount = /\/dev\/board\/(\d+)/.exec(window.location.pathname)?.[1];
  const queryCount = Number(params.get('count'));
  const querySeed = Number(params.get('seed'));
  return {
    count:
      props.count ??
      (Number.isFinite(queryCount) && queryCount > 0
        ? queryCount
        : pathCount
          ? Number(pathCount)
          : 5000),
    seed: props.seed ?? (Number.isFinite(querySeed) && querySeed > 0 ? querySeed : 1),
    tour: props.tour ?? params.get('tour') === '1',
  };
}

function probeGlRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && info) return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  } catch {
    // Fall through to 'unknown'.
  }
  return 'unknown';
}

type Waypoint = { cx: number; cy: number; zoom: number };

function buildWaypoints(items: Item[]): Waypoint[] {
  const fallback: Waypoint = { cx: 0, cy: 0, zoom: 1 };
  const first = items[0];
  if (!first) return [fallback];
  let minX = first.x;
  let maxX = first.x;
  let minY = first.y;
  let maxY = first.y;
  for (const item of items) {
    minX = Math.min(minX, item.x);
    maxX = Math.max(maxX, item.x + item.width);
    minY = Math.min(minY, item.y);
    maxY = Math.max(maxY, item.y + item.height);
  }
  const center: Waypoint = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom: 0.15 };
  const pick = (fraction: number, zoom: number): Waypoint => {
    const item = items[Math.min(items.length - 1, Math.floor(fraction * items.length))] ?? items[0];
    if (!item) return fallback;
    return { cx: item.x + item.width / 2, cy: item.y + item.height / 2, zoom };
  };
  return [pick(0.1, 1), pick(0.35, 1), center, pick(0.6, 0.15), pick(0.8, 2), pick(0.92, 1)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTour(
  canvas: BoardCanvas,
  items: Item[],
  meta: { count: number; seed: number },
): Promise<PerfSummary> {
  // Give initial textures a head start, then measure the tour exactly.
  await delay(2000);
  const waypoints = buildWaypoints(items);
  const samples: number[] = [];
  const unsubscribe = frameStats.subscribe((deltaMs) => samples.push(deltaMs));
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TOUR_DURATION_MS);
      const scaled = t * (waypoints.length - 1);
      const index = Math.min(waypoints.length - 2, Math.floor(scaled));
      const local = scaled - index;
      const from = waypoints[index] ?? waypoints[0] ?? { cx: 0, cy: 0, zoom: 1 };
      const to = waypoints[index + 1] ?? from;
      const zoom = from.zoom + (to.zoom - from.zoom) * local;
      const cx = from.cx + (to.cx - from.cx) * local;
      const cy = from.cy + (to.cy - from.cy) * local;
      canvas.setViewport({
        x: window.innerWidth / 2 - cx * zoom,
        y: window.innerHeight / 2 - cy * zoom,
        zoom,
      });
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  await delay(200);
  unsubscribe();
  const stats = summarizeFrameTimes(samples);
  const summary: PerfSummary = {
    type: 'refthing-perf-summary',
    count: meta.count,
    seed: meta.seed,
    frames: stats.frames,
    durationMs: Math.round(performance.now() - start),
    avgFps: Math.round(stats.avgFps * 100) / 100,
    avgMs: Math.round(stats.avgMs * 100) / 100,
    p50Ms: Math.round(stats.p50Ms * 100) / 100,
    p99Ms: Math.round(stats.p99Ms * 100) / 100,
    maxMs: Math.round(stats.maxMs * 100) / 100,
    glRenderer: probeGlRenderer(),
    gate: {
      target: 'p99 frame < 16.6ms @ 20000 items',
      thresholdMs: GATE_THRESHOLD_MS,
      pass: stats.p99Ms < GATE_THRESHOLD_MS,
    },
  };
  console.log(`[refthing-perf] ${JSON.stringify(summary)}`);
  document.title = `PERF ${JSON.stringify(summary)}`;
  (window as unknown as Record<string, unknown>).__refthingPerf = summary;
  return summary;
}

/**
 * Full-screen dev board: mounts BoardCanvas with deterministic synthetic
 * items injected through the same zustand snapshot path the real app uses
 * (useBoardStore.snapshot.items -> canvas.update), bypassing the backend.
 * With ?tour=1 it runs a scripted 5s pan/zoom tour and publishes a JSON perf
 * summary to the console and document.title for headless drivers.
 */
export function DevBoard(props: DevBoardProps) {
  if (!import.meta.env.DEV) {
    return <div style={{ color: '#ccc', padding: 24 }}>DevBoard is a dev-only build target.</div>;
  }
  return <DevBoardInner {...parseParams(props)} />;
}

function DevBoardInner({ count, seed, tour }: Required<DevBoardProps>) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<BoardCanvas | null>(null);
  const items = useBoardStore((state) => state.snapshot?.items);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void generateSynthBoard({ count, seed }).then((board) => {
      if (cancelled) return;
      installSynthImageInterception();
      registerSynthImages(board.imageUrls);
      useBoardStore.setState({
        boards: [
          {
            id: SYNTH_BOARD_ID,
            name: board.snapshot.board.name,
            item_count: count,
            updated_at: board.snapshot.board.updated_at,
          },
        ],
        activeBoardId: SYNTH_BOARD_ID,
        snapshot: board.snapshot,
        loading: false,
        error: null,
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [count, seed]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const canvas = new BoardCanvas({});
    canvasRef.current = canvas;
    void canvas.mount(element);
    return () => {
      canvas.destroy();
      canvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (items) canvasRef.current?.update(items);
  }, [items]);

  useEffect(() => {
    if (!ready || !tour) return;
    const canvas = canvasRef.current;
    const snapshotItems = useBoardStore.getState().snapshot?.items;
    if (!canvas || !snapshotItems) return;
    void runTour(canvas, snapshotItems, { count, seed });
  }, [ready, tour, count, seed]);

  return (
    <div data-dev-board="true" style={{ position: 'fixed', inset: 0, background: '#111318' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <FpsHud />
      <div
        style={{
          position: 'fixed',
          top: 8,
          left: 8,
          zIndex: 9999,
          padding: '6px 10px',
          borderRadius: 6,
          background: 'rgba(10, 12, 16, 0.8)',
          color: '#8ab4f8',
          font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
          pointerEvents: 'none',
        }}
      >
        {`dev board · ${count} items · seed ${seed}${tour ? ' · tour' : ''}`}
      </div>
    </div>
  );
}
