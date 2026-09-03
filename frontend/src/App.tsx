import { useEffect, useState } from 'react';
import { fetchHealth, type HealthStatus } from '@/api/client';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; health: HealthStatus }
  | { kind: 'error'; message: string };

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((result) => {
        if (!cancelled) {
          setHealth({ kind: 'ok', health: result });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          setHealth({ kind: 'error', message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-board-bg font-sans text-neutral-200">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-chrome-border bg-chrome-bg px-4">
        <h1 className="text-sm font-semibold tracking-wide">RefThing</h1>
        <HealthPill state={health} />
      </header>

      <main className="relative flex-1 overflow-hidden">
        {/* PixiJS mount point (Phase 4). React must never render children into
            this div — the canvas engine owns its DOM subtree. */}
        <div id="canvas-host" className="absolute inset-0" />
      </main>
    </div>
  );
}

function HealthPill({ state }: { state: HealthState }) {
  if (state.kind === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-chrome-border bg-board-bg px-2.5 py-0.5 text-xs text-neutral-400">
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
        checking…
      </span>
    );
  }
  if (state.kind === 'ok') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-800 bg-emerald-950 px-2.5 py-0.5 text-xs text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        ok · v{state.health.version}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-red-800 bg-red-950 px-2.5 py-0.5 text-xs text-red-300"
      title={state.message}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      backend unreachable
    </span>
  );
}
