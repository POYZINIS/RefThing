import { type ComponentType, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSession,
  fetchHealth,
  type HealthStatus,
  type Item,
  type ItemPatch,
  searchBoard,
  submitBatch,
} from '@/api/client';
import { BoardSync } from '@/api/ws';
import { BoardCanvas, type ViewportState } from '@/canvas/BoardCanvas';
import BoardViewManager from '@/components/BoardViewManager';
import { DrawingOverlay } from '@/components/DrawingOverlay';
import { NoteOverlay } from '@/components/NoteOverlay';
import SearchBar, { emptyFilter, type FilterState, filterIsEmpty } from '@/components/SearchBar';
import { type SelectableChange, SelectionOverlay } from '@/components/SelectionOverlay';
import TagManager from '@/components/TagManager';
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
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // The note currently in text-edit mode (§4 RULE 2 — double-click only).
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);
  const [previewPatch, setPreviewPatch] = useState<ItemPatch>({});
  // Live multi-select preview: itemId → patch (used with onPreviewItems).
  const [previewPatches, setPreviewPatches] = useState<Record<string, ItemPatch>>({});
  // Live preview for a selected note's transform (resize/rotate/move).
  const [previewNote, setPreviewNote] = useState<ItemPatch>({});
  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [grayscale, setGrayscale] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  const socket = useRef<BoardSync | null>(null);
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by the canvas pan handler via onViewportChange so we know the
  // viewport is being driven by user panning.  The snapshot sync effect
  // must NOT overwrite it, or DOM overlays (notes) will snap back on
  // every WebSocket heartbeat during a pan.
  const panViewportRef = useRef(false);
  const clientId = useRef(crypto.randomUUID());
  const commitItemChange = useRef<(itemId: string, patch: ItemPatch) => void>(() => undefined);
  const commitItemChanges = useRef<(changes: SelectableChange[]) => void>(() => undefined);
  const commitNoteChange = useRef<(noteId: string, patch: ItemPatch) => void>(() => undefined);
  // Set on each render; the canvas callback can call it to raise a clicked
  // item to the top of the paint order.
  const bringToFrontRef = useRef<(itemId: string) => void>(() => undefined);
  // Raise a clicked note above every other note (notes have their own z
  // order in the notes table; items and notes are separate layers).
  const bringNoteToFrontRef = useRef<(noteId: string) => void>(() => undefined);
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
  const updateNoteGeo = useBoardStore((state) => state.updateNoteGeo);
  const groupItems = useBoardStore((state) => state.groupItems);
  const ungroupItems = useBoardStore((state) => state.ungroupItems);
  const createTag = useBoardStore((state) => state.createTag);
  const renameTag = useBoardStore((state) => state.renameTag);
  const deleteTag = useBoardStore((state) => state.deleteTag);
  const applyOps = useBoardStore((state) => state.applyOps);

  const snapshotItems = snapshot?.items;
  const selectedItem = snapshotItems?.find((item) => item.id === selectedItemId) ?? null;
  const selectedItems = useMemo(
    () =>
      selectedItemIds
        .map((id) => snapshotItems?.find((it) => it.id === id))
        .filter((it): it is Item => !!it),
    [selectedItemIds, snapshotItems],
  );
  const selectedItemTags = useMemo(
    () => new Set(selectedItemId ? (snapshot?.item_tags[selectedItemId] ?? []) : []),
    [snapshot?.item_tags, selectedItemId],
  );
  // Notes keep a live preview while the transform shell drags them.
  const renderedNotes = useMemo(
    () =>
      snapshot?.notes.map((note) =>
        note.id === selectedNoteId && Object.keys(previewNote).length > 0
          ? { ...note, ...previewNote }
          : note,
      ) ?? [],
    [snapshot?.notes, selectedNoteId, previewNote],
  );
  // The selected note reads from the LIVE (previewed) list so the transform
  // shell and the note body always match what the user is dragging.
  const selectedNote = renderedNotes.find((note) => note.id === selectedNoteId) ?? null;
  const [filter, setFilter] = useState<FilterState>(emptyFilter);

  // Phase 6: FTS5 server-side search. When the text query is non-empty,
  // the server decides which items match (searches note content + tags).
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [serverHits, setServerHits] = useState<Set<string>>(new Set());
  useEffect(() => {
    const text = filter.text.trim();
    if (text === '' || !activeBoardId) {
      setServerHits(new Set());
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      searchBoard(activeBoardId, text)
        .then((results) => {
          setServerHits(new Set(results.map((r) => r.item_id)));
        })
        .catch(() => setServerHits(new Set()));
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [filter.text, activeBoardId]);

  // Phase 6: text + tag filtering. The canvas renders the *filtered* list so
  // non-matching items disappear; tags and an item's original filename
  // participate in the text match. Note content is skipped for now (FTS5
  // server-side search is a later Phase 6 item).
  const renderedItems = useMemo(() => {
    const items =
      snapshotItems?.map((item) => {
        // Multi-select previews live in previewPatches (ALL items, primary
        // included — the primary must not stay frozen while its siblings
        // move). Single-select falls back to previewPatch on the primary.
        const preview =
          previewPatches[item.id] ?? (item.id === selectedItemId ? previewPatch : undefined);
        return preview ? { ...item, ...preview } : item;
      }) ?? [];
    if (filterIsEmpty(filter)) return items;
    const text = filter.text.trim().toLowerCase();
    const itemTagsById = snapshot?.item_tags;
    const blobsByName = new Map<string, string>();
    for (const blob of snapshot?.blobs ?? []) {
      const name = blob.original_filename?.toLowerCase() ?? '';
      if (name !== '') blobsByName.set(blob.hash, name);
    }
    const tagNameById = new Map(
      snapshot?.tags.map((tag) => [tag.id, tag.name.toLowerCase()]) ?? [],
    );
    return items.filter((item) => {
      if (
        filter.tagIds.size > 0 &&
        !(itemTagsById?.[item.id]?.some((tagId) => filter.tagIds.has(tagId)) ?? false)
      )
        return false;
      if (text !== '') {
        if (serverHits.size > 0) return serverHits.has(item.id);
        if (item.blob_hash && blobsByName.get(item.blob_hash)?.includes(text)) return true;
        const names = (itemTagsById?.[item.id] ?? [])
          .map((tagId) => tagNameById.get(tagId))
          .filter((name): name is string => name !== undefined);
        return names.some((name) => name.includes(text));
      }
      return true;
    });
  }, [
    snapshotItems,
    snapshot?.blobs,
    snapshot?.tags,
    snapshot?.item_tags,
    selectedItemId,
    previewPatch,
    previewPatches,
    filter,
    serverHits,
  ]);

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
      onViewportChange: (viewport, source) => {
        setViewport(viewport);
        // Flag snapshot sync to skip during pan — the canvas is driving
        // the viewport and we must not overwrite it mid-gesture.
        if (source === 'pan') panViewportRef.current = true;
        if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
        viewportSaveTimer.current = setTimeout(() => {
          void saveViewport(viewport);
        }, 250);
      },
      onSelectionChange: (itemId) => {
        setSelectedItemId(itemId);
        setSelectedItemIds(itemId ? [itemId] : []);
        setSelectedNoteId(null);
        setNoteEditingId(null);
        setPreviewPatch({});
        setPreviewPatches({});
        setPreviewNote({});
        if (itemId) bringToFrontRef.current(itemId);
      },
      onMultiSelectChange: (ids) => {
        setSelectedItemIds(ids);
        setSelectedItemId(ids[0] ?? null);
        setSelectedNoteId(null);
        setNoteEditingId(null);
        setPreviewPatch({});
        setPreviewPatches({});
        setPreviewNote({});
      },
      onClearSelection: () => {
        setSelectedItemId(null);
        setSelectedItemIds([]);
        setSelectedNoteId(null);
        setNoteEditingId(null);
        setPreviewPatch({});
        setPreviewPatches({});
        setPreviewNote({});
      },
      onHoverChange: (itemId) => setHoveredItemId(itemId),
      onItemChange: (itemId, patch) => {
        commitItemChange.current(itemId, patch);
      },
      onItemsChange: (changes) =>
        commitItemChanges.current(
          changes.map(({ itemId, patch }) => ({ id: itemId, kind: 'item' as const, patch })),
        ),
      snapToGrid: false,
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
    boardCanvas.current?.setViewport(asViewport(snapshot?.board.viewport_state));
    // Keep the React viewport in sync so DOM overlays (notes) position
    // correctly from the very first paint after a board opens.
    // Skip when the viewport is being driven by panning — the pan handler
    // already calls setViewport and we must not clobber it.
    if (snapshot?.board.viewport_state && !panViewportRef.current) {
      setViewport(asViewport(snapshot.board.viewport_state));
    }
    panViewportRef.current = false;
  }, [snapshot?.board.viewport_state]);

  // Phase 5: animated GIF playback. The pyramid pipeline only makes a
  // first-frame poster, so the canvas animates GIF blobs from the original
  // bytes. Only blobs whose mime type is `image/gif` participate.
  const gifHashes = useMemo(
    () =>
      new Set(
        snapshot?.blobs.filter((blob) => blob.mime_type === 'image/gif').map((blob) => blob.hash) ??
          [],
      ),
    [snapshot?.blobs],
  );

  useEffect(() => {
    boardCanvas.current?.update(renderedItems, gifHashes);
  }, [renderedItems, gifHashes]);

  commitItemChange.current = (itemId, patch) => {
    commitItemChanges.current([{ id: itemId, kind: 'item', patch }]);
  };

  // Raise an item to the front of the paint order via a `set_z` op. The order
  // array is index-mapped by the store (index 0 = backmost), so the clicked
  // item goes last; everything else keeps its relative order.
  bringToFrontRef.current = (itemId) => {
    if (!activeBoardId || !snapshot) return;
    const ids = snapshot.items.map((it) => it.id);
    if (!ids.includes(itemId) || ids[ids.length - 1] === itemId) return;
    const order = [...ids.filter((id) => id !== itemId), itemId];
    const op = { kind: 'set_z' as const, op_id: crypto.randomUUID(), order };
    const request = { base_seq: snapshot.seq, client_id: clientId.current, ops: [op] };
    if (socket.current?.send(request)) {
      applyOps([op]);
      return;
    }
    void submitBatch(activeBoardId, request)
      .then((result) => applyOps([op], result.seq))
      .catch(() => openBoard(activeBoardId));
  };

  // Notes: same geometry commit path as items (updateNoteGeo is store-side,
  // already optimistic). The overlay emits BoxPatch; route to updateNoteGeo.
  commitNoteChange.current = (noteId, patch) => {
    const geo = { ...patch };
    void updateNoteGeo(noteId, geo);
  };

  // Bring a note to the top of the note layer. Note z_index is notes-relative
  // (items and notes are separate tables/layers), so "front" = max note
  // z_index + 1.
  bringNoteToFrontRef.current = (noteId) => {
    if (!snapshot) return;
    const maxZ = snapshot.notes.reduce((max, note) => Math.max(max, note.z_index), 0);
    const note = snapshot.notes.find((n) => n.id === noteId);
    // Skip if the note is already strictly ahead of every other note.
    if (!note || note.z_index > maxZ) return;
    void updateNoteGeo(noteId, { z_index: maxZ + 1 });
  };

  const toggleTagOnSelection = (tagId: string) => {
    if (!selectedItemId) return;
    const hasTag = selectedItemTags.has(tagId);
    commitItemChange.current(selectedItemId, {
      ...(hasTag ? { remove_tag_ids: [tagId] } : { add_tag_ids: [tagId] }),
    });
  };

  commitItemChanges.current = (changes) => {
    if (!activeBoardId || !snapshot) return;
    const ops = changes.map(({ id, patch }) => ({
      kind: 'update' as const,
      op_id: crypto.randomUUID(),
      item_id: id,
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
        {snapshot && (
          <TagManager
            tags={snapshot.tags}
            selectedItemTags={selectedItemTags}
            onCreate={(name) => createTag(name).then(() => undefined)}
            onRename={(tagId, name) => renameTag(tagId, name).then(() => undefined)}
            onDelete={(tagId) => deleteTag(tagId)}
            onToggle={toggleTagOnSelection}
          />
        )}
        {activeBoardId && (
          <BoardViewManager
            boardId={activeBoardId}
            currentViewport={viewport}
            onApply={(applied) => {
              // Jump the canvas immediately, then persist right away so no
              // pending debounced save or later snapshot clobbers the applied
              // view.
              setViewport(applied);
              boardCanvas.current?.setViewport(applied);
              if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
              void saveViewport(applied);
            }}
          />
        )}
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
        {snapshot && <SearchBar tags={snapshot.tags} filter={filter} onChange={setFilter} />}
        <DrawingOverlay enabled={drawing} viewport={viewport} />
        {/* Notes render with their live transform preview; z_index pulls
            front notes above back ones. A selected note is inert here — the
            SelectionOverlay shell covers it and owns the pointer (matching
            how a selected image sprite is inert behind the shell). */}
        {renderedNotes.map((note) => (
          <NoteOverlay
            key={note.id}
            note={note}
            viewport={viewport}
            selected={note.id === selectedNoteId}
            editing={note.id === selectedNoteId && noteEditingId === note.id}
            onSelect={() => {
              setSelectedNoteId(note.id);
              setSelectedItemId(null);
              setSelectedItemIds([]);
              setPreviewPatch({});
              setPreviewPatches({});
              setPreviewNote({});
              bringNoteToFrontRef.current(note.id);
            }}
            onHover={(hovering) => setHoveredNoteId(hovering ? note.id : null)}
            onEditingChange={(editing) => setNoteEditingId(editing ? note.id : null)}
            onSave={(content) => void saveNote(note.id, content)}
            onMove={(noteId, x, y) => void updateNoteGeo(noteId, { x, y })}
          />
        ))}
        {/* §1 HOVERED — 1px 40% outline on an unselected item. Replaced by the
            selection outline the moment that item is selected; never drawn
            while a selection overlay is up for the same item. */}
        {hoveredItemId &&
          snapshotItems &&
          hoveredItemId !== selectedItemId &&
          (() => {
            const h = snapshotItems.find((item) => item.id === hoveredItemId);
            if (!h) return null;
            return (
              <div
                className="hover-outline"
                style={{
                  position: 'absolute',
                  left: viewport.x + h.x * viewport.zoom - 0.5,
                  top: viewport.y + h.y * viewport.zoom - 0.5,
                  width: h.width * viewport.zoom,
                  height: h.height * viewport.zoom,
                }}
              />
            );
          })()}
        {selectedItems.length > 0 && (
          <SelectionOverlay
            items={selectedItems.map((it) => {
              const preview =
                previewPatches[it.id] ?? (it.id === selectedItemId ? previewPatch : undefined);
              const merged = preview ? { ...it, ...preview } : it;
              return {
                kind: 'item' as const,
                id: merged.id,
                x: merged.x,
                y: merged.y,
                width: merged.width,
                height: merged.height,
                rotation: merged.rotation,
              };
            })}
            viewport={viewport}
            onPreview={setPreviewPatch}
            onCommit={(patch) => {
              setPreviewPatch({});
              const primary = selectedItems[0];
              if (primary) commitItemChange.current(primary.id, patch);
            }}
            onPreviewItems={(changes) => {
              const map: Record<string, ItemPatch> = {};
              for (const { id, patch } of changes) map[id] = patch;
              setPreviewPatches(map);
            }}
            onCommitItems={(changes) => {
              setPreviewPatches({});
              commitItemChanges.current(changes);
            }}
          />
        )}
        {/* §1 HOVERED — same rule as items: 1px 40% outline on an unselected
            note, replaced by the selection shell the moment it's selected. */}
        {hoveredNoteId &&
          hoveredNoteId !== selectedNoteId &&
          (() => {
            const n = renderedNotes.find((note) => note.id === hoveredNoteId);
            if (!n) return null;
            return (
              <div
                className="hover-outline"
                style={{
                  position: 'absolute',
                  left: viewport.x + n.x * viewport.zoom - 0.5,
                  top: viewport.y + n.y * viewport.zoom - 0.5,
                  width: n.width * viewport.zoom,
                  height: n.height * viewport.zoom,
                }}
              />
            );
          })()}
        {/* §4 RULE 5 — a selected note gets the EXACT same 8-zone transform
            shell as an image. The note article is inert while selected;
            double-click (forwarded from the shell) enters text editing. */}
        {selectedNote && (
          <SelectionOverlay
            items={[
              {
                kind: 'note',
                id: selectedNote.id,
                x: Number(selectedNote.x),
                y: Number(selectedNote.y),
                width: Number(selectedNote.width),
                height: Number(selectedNote.height),
                rotation: Number(selectedNote.rotation ?? 0),
              },
            ]}
            viewport={viewport}
            editing={noteEditingId === selectedNote.id}
            freeTransform
            onDoubleClick={() => setNoteEditingId(selectedNote.id)}
            onPreview={(patch) => {
              setPreviewNote((prev) => ({ ...prev, ...patch }));
            }}
            onCommit={(patch) => {
              setPreviewNote({});
              if (selectedNote) commitNoteChange.current(selectedNote.id, patch);
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
