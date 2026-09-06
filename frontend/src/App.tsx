import { type ComponentType, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSession,
  fetchHealth,
  type HealthStatus,
  type ItemPatch,
  submitBatch,
} from '@/api/client';
import { BoardSync } from '@/api/ws';
import { BoardCanvas, type ViewportState } from '@/canvas/BoardCanvas';
import { DrawingOverlay } from '@/components/DrawingOverlay';
import { NoteOverlay } from '@/components/NoteOverlay';
import { SelectionOverlay } from '@/components/SelectionOverlay';
import { useBoardStore } from '@/state/boardStore';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; health: HealthStatus }
  | { kind: 'error'; message: string };

// Dev-only components live in src/dev/ and may land after this file; resolve
// them via glob so the build works whether or not they exist yet.
type DevComponentProps = { count?: number };
type DevComponent = ComponentType<DevComponentProps>;
type DevModule = Record<string, DevComponent | undefined>;

function lazyDevComponent(
  loader: (() => Promise<DevModule>) | undefined,
  exportName: string,
): ComponentType<DevComponentProps> | null {
  if (!loader) return null;
  return lazy(async () => {
    const module = await loader();
    const component = module.default ?? module[exportName];
    if (!component) throw new Error(`dev module loaded but has no ${exportName} export`);
    return { default: component };
  });
}

const LazyDevBoard = lazyDevComponent(
  import.meta.glob<DevModule>('/src/dev/DevBoard.tsx')['/src/dev/DevBoard.tsx'],
  'DevBoard',
);
const LazyFpsHud = lazyDevComponent(
  import.meta.glob<DevModule>('/src/dev/FpsHud.tsx')['/src/dev/FpsHud.tsx'],
  'FpsHud',
);

export default function App() {
  const devBoardCount = import.meta.env.DEV ? parseDevBoardCount(window.location.pathname) : null;
  if (devBoardCount !== null) {
    return (
      <Suspense fallback={<div className="canvas-status">Loading dev board…</div>}>
        {LazyDevBoard ? (
          <LazyDevBoard count={devBoardCount} />
        ) : (
          <div className="canvas-status">Dev board component not available in this build.</div>
        )}
      </Suspense>
    );
  }
  return <BoardApp />;
}

function parseDevBoardCount(pathname: string): number | null {
  const match = /^\/dev\/board\/(\d+)/.exec(pathname);
  const count = Number.parseInt(match?.[1] ?? '', 10);
  return Number.isFinite(count) ? count : null;
}

function BoardApp() {
  const canvasHost = useRef<HTMLDivElement>(null);
  const boardCanvas = useRef<BoardCanvas | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [newBoardName, setNewBoardName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [previewPatch, setPreviewPatch] = useState<ItemPatch>({});
  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [grayscale, setGrayscale] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  const socket = useRef<BoardSync | null>(null);
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const commitItemChange = useRef<(itemId: string, patch: ItemPatch) => void>(() => undefined);
  const commitItemChanges = useRef<(changes: Array<{ itemId: string; patch: ItemPatch }>) => void>(
    () => undefined,
  );
  const boards = useBoardStore((state) => state.boards);
  const snapshot = useBoardStore((state) => state.snapshot);
  const activeBoardId = useBoardStore((state) => state.activeBoardId);
  const loading = useBoardStore((state) => state.loading);
  const error = useBoardStore((state) => state.error);
  const loadBoards = useBoardStore((state) => state.loadBoards);
  const openBoard = useBoardStore((state) => state.openBoard);
  const createAndOpenBoard = useBoardStore((state) => state.createAndOpenBoard);
  const ingest = useBoardStore((state) => state.ingest);
  const saveViewport = useBoardStore((state) => state.saveViewport);
  const addNote = useBoardStore((state) => state.addNote);
  const saveNote = useBoardStore((state) => state.saveNote);
  const groupItems = useBoardStore((state) => state.groupItems);
  const ungroupItems = useBoardStore((state) => state.ungroupItems);
  const applyOps = useBoardStore((state) => state.applyOps);

  const snapshotItems = snapshot?.items;
  const selectedItem = snapshotItems?.find((item) => item.id === selectedItemId) ?? null;
  const renderedItems = useMemo(
    () =>
      snapshotItems?.map((item) =>
        item.id === selectedItemId ? { ...item, ...previewPatch } : item,
      ) ?? [],
    [snapshotItems, selectedItemId, previewPatch],
  );

  useEffect(() => {
    void createSession().then(() => loadBoards());
    fetchHealth()
      .then((result) => setHealth({ kind: 'ok', health: result }))
      .catch((caught: unknown) => {
        setHealth({
          kind: 'error',
          message: caught instanceof Error ? caught.message : 'Backend unreachable',
        });
      });
  }, [loadBoards]);

  useEffect(() => {
    if (!activeBoardId) return;
    const sync = new BoardSync({
      boardId: activeBoardId,
      clientId: clientId.current,
      onPosterReady: () => boardCanvas.current?.clearTextureFailures(),
    });
    socket.current = sync;
    return () => {
      sync.close();
      if (socket.current === sync) socket.current = null;
    };
  }, [activeBoardId]);

  useEffect(() => {
    if (!canvasHost.current) return;
    const canvas = new BoardCanvas({
      onViewportChange: (viewport) => {
        setViewport(viewport);
        if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
        viewportSaveTimer.current = setTimeout(() => {
          void saveViewport(viewport);
        }, 250);
      },
      onSelectionChange: (itemId) => {
        setSelectedItemId(itemId);
        setPreviewPatch({});
      },
      onItemChange: (itemId, patch) => {
        commitItemChange.current(itemId, patch);
      },
      onItemsChange: (changes) => commitItemChanges.current(changes),
      snapToGrid: true,
    });
    boardCanvas.current = canvas;
    void canvas.mount(canvasHost.current);
    return () => {
      if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
      canvas.destroy();
      boardCanvas.current = null;
    };
  }, [saveViewport]);

  useEffect(() => {
    boardCanvas.current?.setGrayscale(grayscale);
  }, [grayscale]);

  useEffect(() => {
    const onSample = (event: Event) => setSampledColor((event as CustomEvent<string>).detail);
    window.addEventListener('refthing-color-sampled', onSample);
    return () => window.removeEventListener('refthing-color-sampled', onSample);
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length > 0) {
        event.preventDefault();
        void ingest(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [ingest]);

  useEffect(() => {
    const nextViewport = asViewport(snapshot?.board.viewport_state);
    setViewport(nextViewport);
    boardCanvas.current?.setViewport(nextViewport);
  }, [snapshot?.board.viewport_state]);

  useEffect(() => {
    boardCanvas.current?.update(renderedItems);
  }, [renderedItems]);

  commitItemChange.current = (itemId, patch) => {
    commitItemChanges.current([{ itemId, patch }]);
  };

  commitItemChanges.current = (changes) => {
    if (!activeBoardId || !snapshot) return;
    const ops = changes.map(({ itemId, patch }) => ({
      kind: 'update' as const,
      op_id: crypto.randomUUID(),
      item_id: itemId,
      fields: patch,
    }));
    const request = {
      base_seq: snapshot.seq,
      client_id: clientId.current,
      ops,
    };
    if (socket.current?.send(request)) {
      // Optimistic apply; the echo diff only advances our seq cursor.
      applyOps(ops);
      return;
    }
    void submitBatch(activeBoardId, request)
      .then((result) => applyOps(ops, result.seq))
      .catch(() => openBoard(activeBoardId));
  };

  async function submitBoard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreating(true);
    try {
      await createAndOpenBoard(newBoardName);
      setNewBoardName('');
    } finally {
      setIsCreating(false);
    }
  }

  function acceptFiles(files: FileList | File[]) {
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (images.length > 0) void ingest(images);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">R</span>
          <div>
            <h1>RefThing</h1>
            <span className="workspace-label">reference workspace</span>
          </div>
        </div>
        <div className="topbar-actions">
          <HealthPill state={health} />
          <button
            className="ghost-button"
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={!activeBoardId}
          >
            Add images
          </button>
          <button
            className={`ghost-button ${grayscale ? 'active' : ''}`}
            type="button"
            onClick={() => setGrayscale((enabled) => !enabled)}
            disabled={!activeBoardId}
            aria-pressed={grayscale}
          >
            Grayscale
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => void addNote()}
            disabled={!activeBoardId}
          >
            Add note
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => selectedItemId && void groupItems([selectedItemId])}
            disabled={!selectedItemId}
          >
            Group
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => selectedItemId && void ungroupItems([selectedItemId])}
            disabled={!selectedItem?.group_id}
          >
            Ungroup
          </button>
          <button
            className={`ghost-button ${drawing ? 'active' : ''}`}
            type="button"
            onClick={() => setDrawing((enabled) => !enabled)}
            disabled={!activeBoardId}
            aria-pressed={drawing}
          >
            Draw
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => void sampleColor()}
            disabled={!activeBoardId}
          >
            {sampledColor ? `Color ${sampledColor}` : 'Sample color'}
          </button>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              if (event.target.files) acceptFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-heading">
          <span>Boards</span>
          <span className="count-badge">{boards.length}</span>
        </div>
        <div className="board-list">
          {boards.map((board) => (
            <button
              className={`board-row ${board.id === activeBoardId ? 'selected' : ''}`}
              key={board.id}
              type="button"
              onClick={() => void openBoard(board.id)}
            >
              <span className="board-dot" />
              <span className="board-name">{board.name}</span>
              <span className="board-count">{board.item_count}</span>
            </button>
          ))}
        </div>
        <form className="new-board-form" onSubmit={(event) => void submitBoard(event)}>
          <input
            aria-label="New board name"
            value={newBoardName}
            onChange={(event) => setNewBoardName(event.target.value)}
            placeholder="New board name"
          />
          <button type="submit" disabled={isCreating} aria-label="Create board">
            +
          </button>
        </form>
        <div className="sidebar-footer">Local library · {snapshot?.items.length ?? 0} items</div>
      </aside>

      <main
        className="canvas-frame"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <div id="canvas-host" ref={canvasHost} />
        <DrawingOverlay enabled={drawing} viewport={viewport} />
        {snapshot?.notes.map((note) => (
          <NoteOverlay
            key={note.id}
            note={note}
            viewport={viewport}
            onSave={(content) => void saveNote(note.id, content)}
          />
        ))}
        {selectedItem && (
          <SelectionOverlay
            item={selectedItem}
            viewport={viewport}
            onPreview={setPreviewPatch}
            onCommit={(patch) => {
              setPreviewPatch({});
              commitItemChange.current(selectedItem.id, patch);
            }}
          />
        )}
        {!activeBoardId && !loading && (
          <div className="empty-state">
            <div className="empty-glyph">+</div>
            <h2>Start a reference board</h2>
            <p>Create a board, then drop images anywhere on the canvas.</p>
          </div>
        )}
        {activeBoardId && snapshot?.items.length === 0 && !loading && (
          <div className="empty-state empty-state-board">
            <div className="empty-glyph">↗</div>
            <h2>{snapshot.board.name} is ready</h2>
            <p>Drop images here or use Add images to build your board.</p>
          </div>
        )}
        {loading && <div className="canvas-status">Syncing board…</div>}
        {error && <div className="error-banner">{error}</div>}
        {snapshot && (
          <div className="canvas-meta">
            {snapshot.items.length} items · seq {snapshot.seq}
          </div>
        )}
      </main>
      {import.meta.env.DEV && LazyFpsHud && (
        <Suspense fallback={null}>
          <LazyFpsHud />
        </Suspense>
      )}
    </div>
  );
}

async function sampleColor(): Promise<void> {
  const picker = (
    window as Window & {
      EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
    }
  ).EyeDropper;
  if (!picker) return;
  const result = await new picker().open();
  window.dispatchEvent(new CustomEvent('refthing-color-sampled', { detail: result.sRGBHex }));
}

function asViewport(value: unknown): ViewportState {
  if (typeof value !== 'object' || value === null) return { x: 0, y: 0, zoom: 1 };
  const candidate = value as Record<string, unknown>;
  return {
    x: typeof candidate.x === 'number' ? candidate.x : 0,
    y: typeof candidate.y === 'number' ? candidate.y : 0,
    zoom: typeof candidate.zoom === 'number' ? candidate.zoom : 1,
  };
}

function HealthPill({ state }: { state: HealthState }) {
  const label =
    state.kind === 'ok'
      ? `API ${state.health.version}`
      : state.kind === 'loading'
        ? 'Connecting'
        : 'Offline';
  return (
    <span
      className={`health-pill ${state.kind}`}
      title={state.kind === 'error' ? state.message : undefined}
    >
      <span />
      {label}
    </span>
  );
}
