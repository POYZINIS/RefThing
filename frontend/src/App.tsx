import { type ComponentType, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BatchQueue } from '@/api/batchQueue';
import {
  type BatchRequestOp,
  createSession,
  fetchHealth,
  type HealthStatus,
  type Item,
  type ItemPatch,
  type Note,
  searchBoard,
} from '@/api/client';
import { BoardSync } from '@/api/ws';
import { BoardCanvas, type ViewportState } from '@/canvas/BoardCanvas';
import { keyboardAction } from '@/canvas/controls';
import { itemToNode, noteToNode } from '@/canvas/nodes/adapters';
import { noteText } from '@/canvas/nodes/noteText';
import type { CanvasNode, NodeChange, NodePatch } from '@/canvas/nodes/types';
import BoardViewManager from '@/components/BoardViewManager';
import { DrawingOverlay } from '@/components/DrawingOverlay';
import { NoteEditor } from '@/components/NoteEditor';
import SearchBar, { emptyFilter, type FilterState, filterIsEmpty } from '@/components/SearchBar';
import { SelectionOverlay } from '@/components/SelectionOverlay';
import TagManager from '@/components/TagManager';
import { useBoardStore } from '@/state/boardStore';
import { type HistoryEntry, prepareCommand } from '@/state/history';

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
  // Unified selection: items and notes share one id list (mixed multi-select
  // works); the noteIds set below routes persistence per kind.
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  // The note currently in text-edit mode (§4 RULE 2 — double-click only).
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // Live transform-shell preview (nodeId → patch). Feeds the canvas too: the
  // shell never mutates canvas nodes itself.
  const [previewPatches, setPreviewPatches] = useState<Record<string, NodePatch>>({});
  // Live canvas-controller drag positions. The canvas already paints these
  // (it mutates its nodes in place), so they feed DOM chrome only.
  const [dragPreview, setDragPreview] = useState<Record<string, NodePatch>>({});
  // Target camera (saves, view manager) vs the eased camera Pixi painted this
  // frame — every DOM overlay positions from the latter so it never runs
  // ahead of the canvas.
  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [overlayViewport, setOverlayViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [grayscale, setGrayscale] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  const socket = useRef<BoardSync | null>(null);
  const batchQueue = useRef<BatchQueue | null>(null);
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by the canvas pan handler via onViewportChange so we know the
  // viewport is being driven by user panning.  The snapshot sync effect
  // must NOT overwrite it, or DOM overlays (notes) will snap back on
  // every WebSocket heartbeat during a pan.
  const panViewportRef = useRef(false);
  const clientId = useRef(crypto.randomUUID());
  const commitItemChange = useRef<(itemId: string, patch: ItemPatch) => void>(() => undefined);
  const commitItemChanges = useRef<(changes: NodeChange[]) => void>(() => undefined);
  // Kind-routing commit: items go through batch update ops, notes through
  // put_note upserts — one command, one undo entry (history.ts).
  const commitNodeChanges = useRef<(changes: NodeChange[]) => void>(() => undefined);
  // The ONE command pipeline: every board mutation (both kinds) goes through
  // prepareCommand → WS/REST batch + optimistic apply → undo stack.
  const commitBoardOps = useRef<(ops: BatchRequestOp[], label: string) => void>(() => undefined);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const undoRef = useRef<() => void>(() => undefined);
  const redoRef = useRef<() => void>(() => undefined);
  // Set on each render; the canvas callback can call it to raise a clicked
  // node to the top of its layer's paint order (items via set_z, notes via
  // z_index — persistence stays per-kind until the protocol unifies).
  const bringNodeToFrontRef = useRef<(nodeId: string) => void>(() => undefined);
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
  const addNote = () => {
    if (!activeBoardId || !snapshot) return;
    const maxZ = topZ(snapshot);
    const now = Date.now();
    const note: Note = {
      id: crypto.randomUUID(),
      board_id: activeBoardId,
      x: 96,
      y: 96,
      width: 280,
      height: 180,
      rotation: 0,
      z_index: maxZ + 1,
      content_json: { text: 'New note' },
      bg_color: null,
      opacity: 1,
      created_at: now,
      updated_at: now,
    };
    commitBoardOps.current([{ kind: 'put_note', op_id: crypto.randomUUID(), note }], 'Add note');
  };
  // §4 RULE 4 — text edits commit ONCE on editing exit, as a single undo
  // entry (text and any §4 RULE 6 auto-grow together). No change → no op.
  const saveNote = (noteId: string, content: string, height: number) => {
    const note = snapshot?.notes.find((candidate) => candidate.id === noteId);
    if (!note) return;
    const current = (note.content_json as { text?: unknown })?.text;
    if (current === content && note.height === height) return;
    commitBoardOps.current(
      [
        {
          kind: 'put_note',
          op_id: crypto.randomUUID(),
          note: { ...note, content_json: { text: content }, height, updated_at: Date.now() },
        },
      ],
      'Edit note',
    );
  };
  const groupItems = useBoardStore((state) => state.groupItems);
  const ungroupItems = useBoardStore((state) => state.ungroupItems);
  const createTag = useBoardStore((state) => state.createTag);
  const renameTag = useBoardStore((state) => state.renameTag);
  const deleteTag = useBoardStore((state) => state.deleteTag);
  const applyOps = useBoardStore((state) => state.applyOps);

  const snapshotItems = snapshot?.items;
  const noteIds = useMemo(
    () => new Set(snapshot?.notes.map((note) => note.id) ?? []),
    [snapshot?.notes],
  );
  const noteIdsRef = useRef(noteIds);
  noteIdsRef.current = noteIds;
  const primaryNodeId = selectedNodeIds[0] ?? null;
  const primaryItemId = primaryNodeId && !noteIds.has(primaryNodeId) ? primaryNodeId : null;
  const selectedNoteId =
    selectedNodeIds.length === 1 && primaryNodeId && noteIds.has(primaryNodeId)
      ? primaryNodeId
      : null;
  const selectedItem = snapshotItems?.find((item) => item.id === primaryItemId) ?? null;
  const selectedItemTags = useMemo(
    () => new Set(primaryItemId ? (snapshot?.item_tags[primaryItemId] ?? []) : []),
    [snapshot?.item_tags, primaryItemId],
  );
  // Notes keep a live preview while either the shell or the controller drags.
  const renderedNotes = useMemo(
    () =>
      snapshot?.notes.map((note) => {
        const preview = previewPatches[note.id] ?? dragPreview[note.id];
        return preview ? { ...note, ...preview } : note;
      }) ?? [],
    [snapshot?.notes, previewPatches, dragPreview],
  );
  // The selected note reads from the LIVE (previewed) list so the transform
  // shell and the note body always match what the user is dragging.
  const selectedNote = selectedNoteId
    ? (renderedNotes.find((note) => note.id === selectedNoteId) ?? null)
    : null;
  const noteEditing = selectedNote !== null && noteEditingId === selectedNote.id;
  const editingNote = noteEditing ? selectedNote : null;
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
        const preview = previewPatches[item.id];
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
    const queue = new BatchQueue(activeBoardId, clientId.current);
    batchQueue.current = queue;
    return () => {
      sync.close();
      if (socket.current === sync) socket.current = null;
      if (batchQueue.current === queue) batchQueue.current = null;
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
      // Commit synchronously inside the canvas tick: Pixi paints this frame
      // with this camera, so the DOM chrome must commit before the same paint
      // — a normally-scheduled update lands a frame late and the outline
      // trails the canvas while easing.
      onRenderedViewportChange: (rendered) => flushSync(() => setOverlayViewport(rendered)),
      onSelectionChange: (nodeId) => {
        setSelectedNodeIds(nodeId ? [nodeId] : []);
        setNoteEditingId(null);
        setPreviewPatches({});
        setDragPreview({});
        if (nodeId) bringNodeToFrontRef.current(nodeId);
      },
      onSelectionToggle: (nodeId) => {
        setNoteEditingId(null);
        setSelectedNodeIds((previous) =>
          previous.includes(nodeId)
            ? previous.filter((id) => id !== nodeId)
            : [...previous, nodeId],
        );
      },
      onMultiSelectChange: (ids) => {
        setSelectedNodeIds(ids);
        setNoteEditingId(null);
        setPreviewPatches({});
        setDragPreview({});
      },
      onClearSelection: () => {
        setSelectedNodeIds([]);
        setNoteEditingId(null);
        setPreviewPatches({});
        setDragPreview({});
      },
      onHoverChange: (nodeId) => setHoveredNodeId(nodeId),
      // §4 RULE 2: double-click is the only way into note Editing.
      onDoubleClick: (nodeId) => {
        if (nodeId && noteIdsRef.current.has(nodeId)) {
          setSelectedNodeIds([nodeId]);
          setNoteEditingId(nodeId);
        }
      },
      // The controller mutates canvas-side node objects during a drag; DOM
      // chrome (selection outline, notes) needs the live positions relayed.
      onDragPreview: (changes) => {
        setDragPreview(Object.fromEntries(changes.map((change) => [change.id, change.patch])));
      },
      onNodesChange: (changes) => {
        commitNodeChanges.current(changes);
        setDragPreview({});
      },
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

  // The note being edited is drawn by its DOM editor, not the canvas.
  useEffect(() => {
    boardCanvas.current?.setHiddenNode(noteEditing ? noteEditingId : null);
  }, [noteEditing, noteEditingId]);

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
    // Notes go in as geometry-only nodes (hit-testing, box select); they
    // keep rendering through the DOM NoteOverlay.
    boardCanvas.current?.update(renderedItems, gifHashes, renderedNotes);
  }, [renderedItems, gifHashes, renderedNotes]);

  commitItemChange.current = (itemId, patch) => {
    commitItemChanges.current([{ id: itemId, kind: 'item', patch }]);
  };

  // Unified node view of the board for selection chrome, hover outlines, and
  // group-mate lookup. Unfiltered — the shell tracks selected nodes even
  // when a search filter hides them — with live preview patches merged.
  const boardNodes = useMemo(() => {
    const itemNodes = (snapshotItems ?? [])
      .filter(
        (item): item is Item & { blob_hash: string } => item.type === 'image' && !!item.blob_hash,
      )
      .map((item) => {
        const preview = previewPatches[item.id] ?? dragPreview[item.id];
        const merged = preview ? { ...item, ...preview } : item;
        return itemToNode(merged, gifHashes.has(item.blob_hash));
      });
    return [...itemNodes, ...renderedNotes.map(noteToNode)];
  }, [snapshotItems, renderedNotes, previewPatches, dragPreview, gifHashes]);
  const boardNodesById = useMemo(
    () => new Map(boardNodes.map((node) => [node.id, node])),
    [boardNodes],
  );
  const selectedNodes = useMemo(
    () =>
      selectedNodeIds
        .map((id) => boardNodesById.get(id))
        .filter((node): node is CanvasNode => !!node),
    [selectedNodeIds, boardNodesById],
  );
  // §6 RULE 1: a grouped node selects its group as one unit — the shell
  // frames and transforms the selection plus every group-mate.
  const shellNodes = useMemo(() => {
    const groupIds = new Set(
      selectedNodes.map((node) => node.groupId).filter((id): id is string => id !== null),
    );
    if (groupIds.size === 0) return selectedNodes;
    const selectedIdSet = new Set(selectedNodeIds);
    const mates = boardNodes.filter(
      (node) => node.groupId && groupIds.has(node.groupId) && !selectedIdSet.has(node.id),
    );
    return [...selectedNodes, ...mates];
  }, [selectedNodes, selectedNodeIds, boardNodes]);

  // Send a batch (WS first, REST fallback) + optimistic local apply. Shared
  // by fresh commands and undo/redo replays.
  const sendOps = (ops: BatchRequestOp[]) => {
    if (!activeBoardId || !snapshot || ops.length === 0) return;
    // Optimistic apply now; the queue delivers in order, one batch at a time.
    applyOps(ops);
    batchQueue.current?.submit(ops);
  };

  commitBoardOps.current = (ops, label) => {
    if (!snapshot) return;
    // prepareCommand computes inverse ops against the CURRENT snapshot and
    // drops no-op ops from the forward set. If a referenced row vanished
    // mid-gesture (raced remote delete), commit without a history entry.
    let entry: HistoryEntry | null = null;
    try {
      entry = prepareCommand(snapshot, ops, label);
    } catch {
      entry = null;
    }
    const forward = entry ? entry.forward : ops;
    sendOps(forward);
    if (entry && entry.forward.length > 0) {
      undoStack.current.push(entry);
      redoStack.current = [];
    }
  };

  undoRef.current = () => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    redoStack.current.push(entry);
    sendOps(entry.inverse);
  };
  redoRef.current = () => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    undoStack.current.push(entry);
    sendOps(entry.forward);
  };

  // Selecting a node raises it above EVERYTHING — items and notes share one
  // z space, so an image can come up over a note and vice versa. This is a
  // side effect of selecting, not a user command: it syncs to the server
  // but never becomes an undo entry of its own.
  bringNodeToFrontRef.current = (nodeId) => {
    if (!activeBoardId || !snapshot) return;
    const maxZ = topZ(snapshot);
    const item = snapshot.items.find((candidate) => candidate.id === nodeId);
    const note = snapshot.notes.find((candidate) => candidate.id === nodeId);
    const current = item?.z_index ?? note?.z_index;
    if (current === undefined) return;
    const sharesTop =
      snapshot.items.filter((candidate) => candidate.z_index === maxZ).length +
        snapshot.notes.filter((candidate) => candidate.z_index === maxZ).length >
      1;
    if (current === maxZ && !sharesTop) return;
    if (item) {
      sendOps([
        {
          kind: 'update',
          op_id: crypto.randomUUID(),
          item_id: nodeId,
          fields: { z_index: maxZ + 1 },
        },
      ]);
    } else if (note) {
      sendOps([
        {
          kind: 'put_note',
          op_id: crypto.randomUUID(),
          note: { ...note, z_index: maxZ + 1, updated_at: Date.now() },
        },
      ]);
    }
  };

  // One command for a mixed item+note change set (e.g. a group drag ending
  // with notes in the move set): items update in place, notes upsert whole.
  commitNodeChanges.current = (changes) => {
    if (!snapshot) return;
    const ops: BatchRequestOp[] = [];
    for (const change of changes) {
      if (change.kind === 'item') {
        ops.push({
          kind: 'update',
          op_id: crypto.randomUUID(),
          item_id: change.id,
          fields: change.patch,
        });
      } else {
        const note = snapshot.notes.find((candidate) => candidate.id === change.id);
        if (!note) continue;
        ops.push({
          kind: 'put_note',
          op_id: crypto.randomUUID(),
          note: { ...note, ...change.patch, updated_at: Date.now() },
        });
      }
    }
    commitBoardOps.current(ops, 'Transform selection');
  };

  const toggleTagOnSelection = (tagId: string) => {
    if (!primaryItemId) return;
    const hasTag = selectedItemTags.has(tagId);
    commitItemChange.current(primaryItemId, {
      ...(hasTag ? { remove_tag_ids: [tagId] } : { add_tag_ids: [tagId] }),
    });
  };

  commitItemChanges.current = (changes) => {
    const ops: BatchRequestOp[] = changes.map(({ id, patch }) => ({
      kind: 'update' as const,
      op_id: crypto.randomUUID(),
      item_id: id,
      fields: patch,
    }));
    commitBoardOps.current(ops, 'Transform items');
  };

  const clearSelectionRef = useRef<() => void>(() => undefined);
  clearSelectionRef.current = () => {
    setSelectedNodeIds([]);
    setNoteEditingId(null);
    setPreviewPatches({});
    setDragPreview({});
  };
  const deleteSelectionRef = useRef<() => void>(() => undefined);
  deleteSelectionRef.current = () => {
    if (!activeBoardId || !snapshot || selectedNodeIds.length === 0) return;
    const itemIds = selectedNodeIds.filter((id) => !noteIds.has(id));
    const deadNoteIds = selectedNodeIds.filter((id) => noteIds.has(id));
    // One batch (and one undo entry): items via the delete op, notes via
    // delete_notes.
    const ops: BatchRequestOp[] = [];
    if (itemIds.length > 0)
      ops.push({ kind: 'delete', op_id: crypto.randomUUID(), item_ids: itemIds });
    if (deadNoteIds.length > 0)
      ops.push({ kind: 'delete_notes', op_id: crypto.randomUUID(), note_ids: deadNoteIds });
    if (ops.length === 0) return;
    clearSelectionRef.current();
    commitBoardOps.current(ops, 'Delete selection');
  };

  // Board keyboard map (canvas/controls.ts). Typing targets keep their keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const action = keyboardAction(event);
      if (action === 'escape') clearSelectionRef.current();
      else if (action === 'delete') deleteSelectionRef.current();
      else if (action === 'undo') undoRef.current();
      else if (action === 'redo') redoRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Dev-only test hook for the browser gesture suite (frontend/e2e). Exposes
  // the live model next to what Pixi actually painted, so tests assert the
  // DOM chrome against the real render. Stripped from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __refthing?: unknown }).__refthing = {
      boardId: activeBoardId,
      selection: selectedNodeIds,
      editing: noteEditingId,
      viewport: overlayViewport,
      targetViewport: viewport,
      nodes: boardNodes.map(({ id, kind, x, y, width, height, rotation, zIndex }) => ({
        id,
        kind,
        x,
        y,
        width,
        height,
        rotation,
        zIndex,
      })),
      notes: snapshot?.notes.map((note) => ({ id: note.id, text: noteText(note.content_json) })),
      undoDepth: undoStack.current.length,
      painted: (id: string) => boardCanvas.current?.paintedClientRect(id) ?? null,
    };
  });

  // Undo history is per-board: switching boards drops both stacks. The dep
  // is the point — the body only touches refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on board switch
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
  }, [activeBoardId]);

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
            onClick={addNote}
            disabled={!activeBoardId}
          >
            Add note
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => primaryItemId && void groupItems([primaryItemId])}
            disabled={!primaryItemId}
          >
            Group
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => primaryItemId && void ungroupItems([primaryItemId])}
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
        <DrawingOverlay enabled={drawing} viewport={overlayViewport} />
        {/* §4 Editing: the one note being edited swaps its canvas sprite for
            a DOM editor laid out with the same pretext metrics. */}
        {editingNote && (
          <NoteEditor
            key={editingNote.id}
            note={editingNote}
            viewport={overlayViewport}
            onGrow={(height) =>
              setPreviewPatches((previous) => ({ ...previous, [editingNote.id]: { height } }))
            }
            onCommit={(text, height) => {
              setPreviewPatches({});
              saveNote(editingNote.id, text, height);
            }}
            onExit={() => setNoteEditingId(null)}
          />
        )}
        {/* §1 HOVERED — 1px 40% outline on an unselected node (any kind).
            Replaced by the selection outline the moment that node is
            selected. rotatedBounds() keeps the outline tight on rotated
            nodes. */}
        {hoveredNodeId &&
          !selectedNodeIds.includes(hoveredNodeId) &&
          (() => {
            const node = boardNodesById.get(hoveredNodeId);
            if (!node) return null;
            const bounds = node.rotatedBounds();
            return (
              <div
                className="hover-outline"
                style={{
                  position: 'absolute',
                  left: overlayViewport.x + bounds.left * overlayViewport.zoom - 0.5,
                  top: overlayViewport.y + bounds.top * overlayViewport.zoom - 0.5,
                  width: (bounds.right - bounds.left) * overlayViewport.zoom,
                  height: (bounds.bottom - bounds.top) * overlayViewport.zoom,
                }}
              />
            );
          })()}
        {/* §0.7 / §1 MULTI-SELECTED — ONE kind-agnostic shell around the
            whole selection (items and notes). Notes get the exact same 8
            zones (§4 RULE 5); double-click on a lone note enters editing. */}
        {shellNodes.length > 0 && (
          <SelectionOverlay
            nodes={shellNodes}
            viewport={overlayViewport}
            editing={noteEditing}
            onDoubleClick={selectedNote ? () => setNoteEditingId(selectedNote.id) : undefined}
            onOutsidePress={(event) => boardCanvas.current?.overlayPointerDown(event)}
            onChromePress={(event) => boardCanvas.current?.chromePointerDown(event)}
            onBodyClick={(event) => {
              // A click (no drag) inside the box behaves like a click on
              // bare canvas: Shift toggles the node under the pointer, a
              // plain click narrows a multi-selection to it.
              const nodeId = boardCanvas.current?.nodeIdAt(event.clientX, event.clientY);
              if (!nodeId) return;
              if (event.shiftKey) {
                setSelectedNodeIds((previous) =>
                  previous.includes(nodeId)
                    ? previous.filter((id) => id !== nodeId)
                    : [...previous, nodeId],
                );
              } else if (selectedNodeIds.length > 1) {
                setSelectedNodeIds([nodeId]);
                bringNodeToFrontRef.current(nodeId);
              }
            }}
            onPreview={(changes) =>
              setPreviewPatches(Object.fromEntries(changes.map(({ id, patch }) => [id, patch])))
            }
            onCommit={(changes) => {
              setPreviewPatches({});
              commitNodeChanges.current(changes);
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

/** Highest z across items AND notes — they share one paint order. */
function topZ(snapshot: { items: { z_index: number }[]; notes: { z_index: number }[] }): number {
  let max = 0;
  for (const item of snapshot.items) max = Math.max(max, item.z_index);
  for (const note of snapshot.notes) max = Math.max(max, note.z_index);
  return max;
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
