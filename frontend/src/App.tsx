import { type ComponentType, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BatchQueue } from '@/api/batchQueue';
import {
  type BatchRequestOp,
  createSession,
  fetchBindingsOverride,
  fetchHealth,
  type HealthStatus,
  type Item,
  type ItemPatch,
  type Note,
} from '@/api/client';
import { CLIENT_ID } from '@/api/clientId';
import { BoardSync } from '@/api/ws';
import { BoardCanvas, type ViewportState } from '@/canvas/BoardCanvas';
import { applyBindingsOverride, bindings, resolveKey } from '@/canvas/bindings';
import { screenToWorld } from '@/canvas/coordinates';
import {
  itemFields,
  itemToNode,
  itemWithPatch,
  noteToNode,
  noteWithPatch,
} from '@/canvas/nodes/adapters';
import { noteText } from '@/canvas/nodes/noteText';
import type { CanvasNode, NodeChange, NodePatch } from '@/canvas/nodes/types';
import { CameraBound, renderedCamera } from '@/canvas/renderedCamera';
import { type Guide, recrop } from '@/canvas/transform';
import { BoardContextMenu } from '@/components/BoardContextMenu';
import BoardViewManager from '@/components/BoardViewManager';
import { DrawingOverlay } from '@/components/DrawingOverlay';
import { NoteEditor } from '@/components/NoteEditor';
import SearchBar, { emptyFilter, type FilterState } from '@/components/SearchBar';
import { SelectionOverlay } from '@/components/SelectionOverlay';
import { SnapshotManager } from '@/components/SnapshotManager';
import TagManager from '@/components/TagManager';
import { useBoardStore } from '@/state/boardStore';
import {
  type Clipboard,
  copySelection,
  duplicateOps,
  fitViewport,
  groupOps,
  groupStyleOps,
  lockOps,
  pasteOps,
  restackOps,
  toggleTagOps,
  topZ,
  ungroupOps,
  unionRect,
} from '@/state/commands';
import { type HistoryEntry, prepareCommand } from '@/state/history';
import { useBoardFilter } from '@/state/useBoardFilter';
import { enter } from '@/ui/motion';

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
  // §6 RULE 2: the group drilled into by double-click — its members select
  // and transform individually until Escape or an empty-canvas click.
  const [drillGroupId, setDrillGroupId] = useState<string | null>(null);
  // §5B Crop mode: the image whose frame the 8 zones currently crop.
  const [cropNodeId, setCropNodeId] = useState<string | null>(null);
  const drillRef = useRef(drillGroupId);
  drillRef.current = drillGroupId;
  const groupOfRef = useRef<(nodeId: string) => string | null>(() => null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // Live transform-shell preview (nodeId → patch). Feeds the canvas too: the
  // shell never mutates canvas nodes itself.
  const [previewPatches, setPreviewPatches] = useState<Record<string, NodePatch>>({});
  // Live canvas-controller drag positions. The canvas already paints these
  // (it mutates its nodes in place), so they feed DOM chrome only.
  const [dragPreview, setDragPreview] = useState<Record<string, NodePatch>>({});
  // Alignment guides while a Shift+Space snap-move is in progress.
  const [guides, setGuides] = useState<Guide[]>([]);
  // Target camera (saves, view manager). DOM overlays never read this: they
  // follow the camera Pixi painted (canvas/renderedCamera.ts).
  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [grayscale, setGrayscale] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  // §5B context menu: what was right-clicked, and where.
  const [menu, setMenu] = useState<{
    kind: 'selection' | 'canvas';
    client: { x: number; y: number };
    world: { x: number; y: number };
  } | null>(null);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  // Board clipboard (Ctrl+C/X): whole records plus the marker we left on the
  // OS clipboard to recognise our own paste.
  const clipboardRef = useRef<{ clip: Clipboard; marker: string } | null>(null);
  // Last pointer position over the board (client px) — pastes land there.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  // Right-press origin: a right-drag past the click epsilon is not a click,
  // so it must not open the menu (testing §2B context menu vs move window).
  const rightPress = useRef<{ x: number; y: number } | null>(null);
  // Double-click zoom on an image toggles back to the camera it came from.
  const zoomReturn = useRef<{ nodeId: string; viewport: ViewportState } | null>(null);
  // Consecutive nudges of the same selection coalesce into one undo entry.
  const coalesce = useRef<{ key: string; at: number; entry: HistoryEntry } | null>(null);
  const socket = useRef<BoardSync | null>(null);
  const batchQueue = useRef<BatchQueue | null>(null);
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitItemChange = useRef<(itemId: string, patch: ItemPatch) => void>(() => undefined);
  const commitItemChanges = useRef<(changes: NodeChange[]) => void>(() => undefined);
  // Kind-routing commit: items go through batch update ops, notes through
  // put_note upserts — one command, one undo entry (history.ts).
  const commitNodeChanges = useRef<
    (changes: NodeChange[], label?: string, coalesceKey?: string) => void
  >(() => undefined);
  // The ONE command pipeline: every board mutation (both kinds) goes through
  // prepareCommand → WS/REST batch + optimistic apply → undo stack.
  const commitBoardOps = useRef<
    (ops: BatchRequestOp[], label: string, coalesceKey?: string) => void
  >(() => undefined);
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
  const addNote = (at: { x: number; y: number }) => {
    if (!activeBoardId || !snapshot) return;
    const maxZ = topZ(snapshot);
    const now = Date.now();
    const note: Note = {
      id: crypto.randomUUID(),
      board_id: activeBoardId,
      x: at.x,
      y: at.y,
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
    setSelectedNodeIds([note.id]);
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
  const createTag = useBoardStore((state) => state.createTag);
  const renameTag = useBoardStore((state) => state.renameTag);
  const deleteTag = useBoardStore((state) => state.deleteTag);
  const applyOps = useBoardStore((state) => state.applyOps);

  const snapshotItems = snapshot?.items;
  const noteIds = useMemo(
    () => new Set(snapshot?.notes.map((note) => note.id) ?? []),
    [snapshot?.notes],
  );
  const primaryNodeId = selectedNodeIds[0] ?? null;
  const primaryItemId = primaryNodeId && !noteIds.has(primaryNodeId) ? primaryNodeId : null;
  const selectedNoteId =
    selectedNodeIds.length === 1 && primaryNodeId && noteIds.has(primaryNodeId)
      ? primaryNodeId
      : null;
  const selectedItemTags = useMemo(
    () => new Set(primaryItemId ? (snapshot?.item_tags[primaryItemId] ?? []) : []),
    [snapshot?.item_tags, primaryItemId],
  );
  // Notes keep a live preview while either the shell or the controller drags.
  const renderedNotes = useMemo(
    () =>
      snapshot?.notes.map((note) => {
        const preview = previewPatches[note.id] ?? dragPreview[note.id];
        return noteWithPatch(note, preview);
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
  // Phase 6: text (FTS5), tag, colour and duplicate filtering — one tested
  // hook (state/useBoardFilter.ts). The canvas paints only what matches; the
  // selection chrome keeps tracking every node (boardNodes is unfiltered).
  const filtered = useBoardFilter(snapshot, filter);
  const renderedItems = useMemo(
    () =>
      Object.keys(previewPatches).length === 0
        ? filtered.items
        : filtered.items.map((item) => itemWithPatch(item, previewPatches[item.id])),
    [filtered.items, previewPatches],
  );
  const filteredNoteIds = useMemo(
    () => new Set(filtered.notes.map((note) => note.id)),
    [filtered.notes],
  );
  const canvasNotes = useMemo(
    () => renderedNotes.filter((note) => filteredNoteIds.has(note.id)),
    [renderedNotes, filteredNoteIds],
  );

  // The control scheme is data: apply the user's bindings.toml (if any)
  // over the defaults before any input arrives.
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  useEffect(() => {
    fetchBindingsOverride()
      .then((toml) => setBindingsError(applyBindingsOverride(toml)))
      .catch(() => undefined); // no override reachable: defaults stand
  }, []);

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
      clientId: CLIENT_ID,
      onPosterReady: () => boardCanvas.current?.clearTextureFailures(),
    });
    socket.current = sync;
    const queue = new BatchQueue(activeBoardId, CLIENT_ID);
    batchQueue.current = queue;
    return () => {
      sync.close();
      if (socket.current === sync) socket.current = null;
      queue.dispose();
      if (batchQueue.current === queue) batchQueue.current = null;
    };
  }, [activeBoardId]);

  useEffect(() => {
    if (!canvasHost.current) return;
    const canvas = new BoardCanvas({
      onViewportChange: (viewport, source) => {
        // The target camera is only read by saves and the view manager, so a
        // pan updates it once on release instead of re-rendering per move
        // (overlays follow the rendered camera, not this).
        if (source !== 'pan') setViewport(viewport);
        if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
        viewportSaveTimer.current = setTimeout(() => {
          void saveViewport(viewport);
        }, 250);
      },
      // Commit synchronously inside the canvas tick: Pixi paints this frame
      // with this camera, so the DOM chrome must commit before the same paint
      // — a normally-scheduled update lands a frame late and the outline
      // trails the canvas while easing.
      onRenderedViewportChange: (rendered) => flushSync(() => renderedCamera.set(rendered)),
      onSelectionChange: (nodeId) => {
        // Selecting outside the drilled group leaves it.
        if (!nodeId || groupOfRef.current(nodeId) !== drillRef.current) setDrillGroupId(null);
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
        setDrillGroupId(null);
        setSelectedNodeIds([]);
        setNoteEditingId(null);
        setPreviewPatches({});
        setDragPreview({});
      },
      onHoverChange: (nodeId) => setHoveredNodeId(nodeId),
      onDoubleClick: (nodeId) => doubleClickRef.current(nodeId),
      // The controller mutates canvas-side node objects during a drag; DOM
      // chrome (selection outline, notes) needs the live positions relayed.
      onGuides: setGuides,
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

  // Copy / cut / paste ride the platform's own clipboard events (Ctrl/Cmd+C,
  // X, V): they carry clipboard data synchronously and need no permission.
  // Copying puts a one-off marker on the OS clipboard; a paste whose text is
  // still that marker pastes our items, anything newer (an image copied in a
  // browser) is ingested instead.
  useEffect(() => {
    const typing = (event: Event) =>
      event.target instanceof HTMLElement &&
      !!event.target.closest('input, textarea, [contenteditable="true"]');
    const onCopyOrCut = (event: ClipboardEvent) => {
      if (typing(event) || !actionsRef.current.copy(event.type === 'cut')) return;
      event.clipboardData?.setData('text/plain', clipboardRef.current?.marker ?? '');
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (typing(event)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (clipboardRef.current && text === clipboardRef.current.marker) {
        event.preventDefault();
        actionsRef.current.pasteClipboard(null);
        return;
      }
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length > 0) {
        event.preventDefault();
        void ingest(files);
      }
    };
    window.addEventListener('copy', onCopyOrCut);
    window.addEventListener('cut', onCopyOrCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopyOrCut);
      window.removeEventListener('cut', onCopyOrCut);
      window.removeEventListener('paste', onPaste);
    };
  }, [ingest]);

  // Restore a board's saved camera ONCE, when it opens. The saved value only
  // flows the other way afterwards: every debounced save echoes back into
  // snapshot.board, and re-applying that echo snapped the eased camera (and
  // jumped it backwards if the user kept panning during the round trip).
  const cameraRestoredFor = useRef<string | null>(null);
  const openedBoard = snapshot?.board;
  useEffect(() => {
    if (!openedBoard || cameraRestoredFor.current === openedBoard.id) return;
    cameraRestoredFor.current = openedBoard.id;
    const saved = asViewport(openedBoard.viewport_state);
    boardCanvas.current?.setViewport(saved);
    setViewport(saved);
  }, [openedBoard]);

  // Phase 5: animated GIF playback. The pyramid pipeline only makes a
  // first-frame poster, so the canvas animates GIF blobs from the original
  // bytes. Only blobs whose mime type is `image/gif` participate.
  const lockedGroupIds = useMemo(
    () => new Set(snapshot?.groups.filter((group) => group.locked).map((group) => group.id) ?? []),
    [snapshot?.groups],
  );
  groupOfRef.current = (nodeId) =>
    snapshot?.items.find((item) => item.id === nodeId)?.group_id ?? null;
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
    boardCanvas.current?.update(renderedItems, gifHashes, canvasNotes, snapshot?.groups);
  }, [renderedItems, gifHashes, canvasNotes, snapshot?.groups]);

  useEffect(() => {
    boardCanvas.current?.setDrillGroup(drillGroupId);
  }, [drillGroupId]);

  commitItemChange.current = (itemId, patch) => {
    commitItemChanges.current([{ id: itemId, kind: 'item', patch }]);
  };

  // Unified node view of the board for selection chrome, hover outlines, and
  // group-mate lookup. Unfiltered — the shell tracks selected nodes even
  // when a search filter hides them — with live preview patches merged.
  // Item nodes are built once per snapshot; a live preview (drag, resize)
  // rebuilds only the previewed nodes — rebuilding all 20k per pointermove
  // dropped frames on big boards.
  // Nodes are cached per item object: applyBoardOps keeps unchanged items
  // identical, so a one-item change rebuilds one node, not 20k.
  const nodeCache = useRef(
    new WeakMap<Item, { node: CanvasNode; gif: boolean; locked: boolean }>(),
  );
  const baseItemNodes = useMemo(() => {
    const byId = new Map<string, { item: Item & { blob_hash: string }; node: CanvasNode }>();
    for (const item of snapshotItems ?? []) {
      if (item.type !== 'image' || !item.blob_hash) continue;
      const image = item as Item & { blob_hash: string };
      const gif = gifHashes.has(image.blob_hash);
      const locked = image.group_id !== null && lockedGroupIds.has(image.group_id);
      let hit = nodeCache.current.get(image);
      if (!hit || hit.gif !== gif || hit.locked !== locked) {
        hit = { node: itemToNode(image, gif, locked), gif, locked };
        nodeCache.current.set(image, hit);
      }
      byId.set(image.id, { item: image, node: hit.node });
    }
    return byId;
  }, [snapshotItems, gifHashes, lockedGroupIds]);
  const boardNodesById = useMemo(() => {
    const byId = new Map<string, CanvasNode>();
    for (const [id, { node }] of baseItemNodes) byId.set(id, node);
    for (const id of new Set([...Object.keys(previewPatches), ...Object.keys(dragPreview)])) {
      const base = baseItemNodes.get(id);
      if (!base) continue;
      const preview = previewPatches[id] ?? dragPreview[id];
      byId.set(
        id,
        itemToNode(itemWithPatch(base.item, preview), base.node.kind === 'gif', base.node.locked),
      );
    }
    for (const note of renderedNotes) byId.set(note.id, noteToNode(note));
    return byId;
  }, [baseItemNodes, previewPatches, dragPreview, renderedNotes]);
  const boardNodes = useMemo(() => [...boardNodesById.values()], [boardNodesById]);
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
      selectedNodes
        .map((node) => node.groupId)
        .filter((id): id is string => id !== null && id !== drillGroupId),
    );
    if (groupIds.size === 0) return selectedNodes;
    const selectedIdSet = new Set(selectedNodeIds);
    const mates = boardNodes.filter(
      (node) => node.groupId && groupIds.has(node.groupId) && !selectedIdSet.has(node.id),
    );
    return [...selectedNodes, ...mates];
  }, [selectedNodes, selectedNodeIds, boardNodes, drillGroupId]);
  // §6 RULE 3: a locked group at group level (not drilled into) is frozen.
  const shellLocked = shellNodes.some((node) => node.locked && node.groupId !== drillGroupId);

  // Send a batch (WS first, REST fallback) + optimistic local apply. Shared
  // by fresh commands and undo/redo replays.
  const sendOps = (ops: BatchRequestOp[]) => {
    if (!activeBoardId || !snapshot || ops.length === 0) return;
    // Optimistic apply now; the queue delivers in order, one batch at a time.
    applyOps(ops);
    batchQueue.current?.submit(ops);
  };

  commitBoardOps.current = (ops, label, coalesceKey) => {
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
    if (!entry || entry.forward.length === 0) return;
    const now = Date.now();
    const previous = coalesce.current;
    if (
      coalesceKey &&
      previous?.key === coalesceKey &&
      now - previous.at < 800 &&
      undoStack.current.at(-1) === previous.entry
    ) {
      // Same command on the same nodes moments later (held arrow key): one
      // undo entry. Redo lands on the newest absolute positions; undo chains
      // the inverses newest-first — each records only the fields its own
      // step changed, so the first inverse alone can't restore a later axis.
      previous.entry.forward = entry.forward;
      previous.entry.inverse = [...entry.inverse, ...previous.entry.inverse];
      previous.at = now;
      redoStack.current = [];
      return;
    }
    undoStack.current.push(entry);
    redoStack.current = [];
    coalesce.current = coalesceKey ? { key: coalesceKey, at: now, entry } : null;
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
  commitNodeChanges.current = (changes, label = 'Transform selection', coalesceKey) => {
    if (!snapshot) return;
    const ops: BatchRequestOp[] = [];
    for (const change of changes) {
      if (change.kind === 'item') {
        ops.push({
          kind: 'update',
          op_id: crypto.randomUUID(),
          item_id: change.id,
          fields: itemFields(change.patch),
        });
      } else {
        const note = snapshot.notes.find((candidate) => candidate.id === change.id);
        if (!note) continue;
        ops.push({
          kind: 'put_note',
          op_id: crypto.randomUUID(),
          note: { ...noteWithPatch(note, change.patch), updated_at: Date.now() },
        });
      }
    }
    commitBoardOps.current(ops, label, coalesceKey);
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
    // Escape leaves a mode before it deselects: crop mode first, then a
    // drilled group (§6 RULE 2, back to group level), then the selection.
    if (cropNodeId) {
      setCropNodeId(null);
      return;
    }
    if (drillGroupId) {
      setDrillGroupId(null);
      return;
    }
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

  // Every board action, shared by the keyboard map and the context menu so a
  // shortcut and its menu entry can never drift apart.
  const selectedItemIds = selectedNodeIds.filter((id) => !noteIds.has(id));
  // From the selected nodes, not a scan of every item (20k on big boards).
  const selectionGroupIds = [
    ...new Set(selectedNodes.map((node) => node.groupId).filter((id): id is string => id !== null)),
  ];
  const selectionGrouped = selectionGroupIds.length > 0;
  const selectionGroupStyle = snapshot?.groups.find((group) => group.id === selectionGroupIds[0]);
  const selectionLocked =
    selectionGrouped && selectionGroupIds.every((groupId) => lockedGroupIds.has(groupId));
  const actions = {
    escape: () => clearSelectionRef.current(),
    delete: () => deleteSelectionRef.current(),
    undo: () => undoRef.current(),
    redo: () => redoRef.current(),
    selectAll: () => {
      // Everything the canvas currently shows (a search filter narrows it).
      setNoteEditingId(null);
      setSelectedNodeIds([
        ...renderedItems.filter((item) => item.blob_hash).map((item) => item.id),
        ...canvasNotes.map((note) => note.id),
      ]);
    },
    group: () => {
      if (snapshot) commitBoardOps.current(groupOps(snapshot, selectedNodeIds), 'Group');
    },
    ungroup: () => {
      if (snapshot) commitBoardOps.current(ungroupOps(snapshot, selectedNodeIds), 'Ungroup');
    },
    duplicate: () => {
      if (!snapshot) return;
      const { ops, ids } = duplicateOps(
        snapshot,
        shellNodes.map((node) => node.id),
      );
      commitBoardOps.current(ops, 'Duplicate');
      setSelectedNodeIds(ids);
    },
    bringToFront: () => {
      if (snapshot) {
        const ids = shellNodes.map((node) => node.id);
        commitBoardOps.current(restackOps(snapshot, ids, 'front'), 'Bring to front');
      }
    },
    sendToBack: () => {
      if (snapshot) {
        const ids = shellNodes.map((node) => node.id);
        commitBoardOps.current(restackOps(snapshot, ids, 'back'), 'Send to back');
      }
    },
    nudge: (dx: number, dy: number, large: boolean) => {
      if (shellNodes.length === 0) return;
      // Screen px, like PureRef: 1px (Shift: 10px) at any zoom.
      const step = (large ? 10 : 1) / renderedCamera.get().zoom;
      const changes: NodeChange[] = shellNodes.map((node) => ({
        id: node.id,
        kind: node.kind === 'note' ? 'note' : 'item',
        patch: { x: node.x + dx * step, y: node.y + dy * step },
      }));
      const key = `nudge:${shellNodes
        .map((node) => node.id)
        .sort()
        .join(',')}`;
      commitNodeChanges.current(changes, 'Nudge', key);
    },
    lock: (locked: boolean) => {
      if (snapshot) {
        commitBoardOps.current(
          lockOps(snapshot, selectedNodeIds, locked),
          locked ? 'Lock group' : 'Unlock group',
        );
      }
    },
    setGroupStyle: (bgColor: string | null, opacity: number) => {
      if (snapshot) {
        commitBoardOps.current(
          groupStyleOps(snapshot, selectedNodeIds, bgColor, opacity),
          'Group colour',
        );
      }
    },
    toggleTag: (tagId: string) => {
      if (snapshot) {
        const ids = shellNodes.map((node) => node.id);
        commitBoardOps.current(toggleTagOps(snapshot, ids, tagId), 'Tag');
      }
    },
    newTag: (name: string) => {
      const existing = snapshot?.tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        actionsRef.current.toggleTag(existing.id);
        return;
      }
      // The tag lands in the store first; the next render's actions see it.
      void createTag(name).then((tag) => actionsRef.current.toggleTag(tag.id));
    },
    resetCrop: () => {
      const node = shellNodes[0];
      if (!node || node.kind === 'note') return;
      // Grow the frame far past the image: recrop clamps it to the full
      // source, content staying where it is.
      const reach = { x: node.width / node.crop.w, y: node.height / node.crop.h };
      const huge = {
        x: node.x - reach.x * 2,
        y: node.y - reach.y * 2,
        width: node.width + reach.x * 4,
        height: node.height + reach.y * 4,
        rotation: node.rotation,
      };
      const full = recrop(node, node.crop, { x: node.flipX, y: node.flipY }, huge);
      const { rotation: _rotation, ...frame } = full.box;
      commitNodeChanges.current(
        [{ id: node.id, kind: 'item', patch: { ...frame, crop: full.crop } }],
        'Reset crop',
      );
    },
    setOpacity: (opacity: number) => {
      const changes: NodeChange[] = shellNodes.map((node) => ({
        id: node.id,
        kind: node.kind === 'note' ? 'note' : 'item',
        patch: { opacity },
      }));
      commitNodeChanges.current(changes, 'Opacity');
    },
    zoomToFit: () => {
      const canvas = boardCanvas.current;
      if (!canvas) return;
      const { width, height } = canvas.size();
      const bounds = unionRect([
        ...renderedItems
          .filter((item) => item.blob_hash)
          .map((item) => boardNodesById.get(item.id)?.rotatedBounds())
          .filter((rect) => rect !== undefined),
        ...canvasNotes.map((note) => noteToNode(note).rotatedBounds()),
      ]);
      const target = fitViewport(bounds, width, height);
      if (target) {
        zoomReturn.current = null;
        canvas.flyTo(target);
      }
    },
    addNoteAt: (world: { x: number; y: number }) => addNote(world),
    /** Ctrl+C / Ctrl+X: capture the selection (and its group-mates). */
    copy: (cut: boolean) => {
      if (!snapshot || shellNodes.length === 0) return false;
      clipboardRef.current = {
        clip: copySelection(
          snapshot,
          shellNodes.map((node) => node.id),
        ),
        marker: `refthing-clipboard:${crypto.randomUUID()}`,
      };
      if (cut) deleteSelectionRef.current();
      return true;
    },
    /** Paste our clipboard centred on `at` (world), else on the cursor, else
     *  on the middle of the view. One undo entry; the paste is selected. */
    pasteClipboard: (at: { x: number; y: number } | null) => {
      const held = clipboardRef.current;
      if (!snapshot || !held) return;
      const camera = renderedCamera.get();
      const host = canvasHost.current?.getBoundingClientRect();
      const pointer = lastPointer.current;
      const target =
        at ??
        (pointer && host
          ? screenToWorld({ clientX: pointer.x, clientY: pointer.y }, camera, host)
          : host
            ? screenToWorld(
                { clientX: host.left + host.width / 2, clientY: host.top + host.height / 2 },
                camera,
                host,
              )
            : { x: 0, y: 0 });
      const { ops, ids } = pasteOps(snapshot, held.clip, target);
      commitBoardOps.current(ops, 'Paste');
      setNoteEditingId(null);
      setSelectedNodeIds(ids);
    },
    pasteImages: async (at: { x: number; y: number } | null = null) => {
      try {
        const files: File[] = [];
        for (const entry of await navigator.clipboard.read()) {
          if (entry.types.includes('text/plain') && clipboardRef.current) {
            const text = await (await entry.getType('text/plain')).text();
            if (text === clipboardRef.current.marker) {
              actionsRef.current.pasteClipboard(at);
              return;
            }
          }
          const type = entry.types.find((candidate) => candidate.startsWith('image/'));
          if (!type) continue;
          const blob = await entry.getType(type);
          files.push(new File([blob], `pasted.${type.split('/')[1] ?? 'png'}`, { type }));
        }
        if (files.length > 0) void ingest(files);
      } catch {
        // Clipboard permission denied or empty — Ctrl+V still works.
      }
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // §4 double-click: a note enters Editing; an image zooms in on itself (again
  // to return); empty canvas zooms to fit everything (plan: MOUSE table).
  const doubleClickRef = useRef<(nodeId: string | null) => void>(() => undefined);
  doubleClickRef.current = (nodeId) => {
    const canvas = boardCanvas.current;
    if (!canvas) return;
    const node = nodeId ? boardNodesById.get(nodeId) : undefined;
    // What is under the pointer picks the action from the bindings table.
    const target =
      !nodeId || !node
        ? 'empty'
        : noteIds.has(nodeId)
          ? 'note'
          : node.groupId && node.groupId !== drillGroupId
            ? 'group'
            : 'item';
    const action = bindings().doubleClick[target];
    if (action === 'zoom_to_fit') {
      actions.zoomToFit();
      return;
    }
    if (!nodeId || !node) return;
    if (action === 'enter_note_edit' && target === 'note') {
      setSelectedNodeIds([nodeId]);
      setNoteEditingId(nodeId);
      return;
    }
    // §6 RULE 2: drill in and select the child under the cursor (locked or
    // not — drilling never alters the group).
    if (action === 'drill_into_group' && node.groupId) {
      setDrillGroupId(node.groupId);
      setSelectedNodeIds([nodeId]);
      return;
    }
    if (action !== 'zoom_to_item') return;
    if (zoomReturn.current?.nodeId === nodeId) {
      canvas.flyTo(zoomReturn.current.viewport);
      zoomReturn.current = null;
      return;
    }
    const { width, height } = canvas.size();
    const camera = fitViewport(node.rotatedBounds(), width, height, 24);
    if (!camera) return;
    zoomReturn.current = { nodeId, viewport: canvas.getViewport() };
    canvas.flyTo(camera);
  };

  // Crop mode belongs to one selected image: any other selection ends it.
  useEffect(() => {
    if (cropNodeId && !(selectedNodeIds.length === 1 && selectedNodeIds[0] === cropNodeId)) {
      setCropNodeId(null);
    }
  }, [cropNodeId, selectedNodeIds]);
  useEffect(() => {
    if (!cropNodeId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') setCropNodeId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cropNodeId]);

  // Board keyboard map (canvas/controls.ts). Typing targets keep their keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], dialog')) return;
      const action = resolveKey(event);
      if (!action) return;
      event.preventDefault();
      const run = actionsRef.current;
      switch (action) {
        case 'nudge_left':
          return run.nudge(-1, 0, event.shiftKey);
        case 'nudge_right':
          return run.nudge(1, 0, event.shiftKey);
        case 'nudge_up':
          return run.nudge(0, -1, event.shiftKey);
        case 'nudge_down':
          return run.nudge(0, 1, event.shiftKey);
        case 'select_all':
          return run.selectAll();
        default:
          return run[action]();
      }
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
      drillGroupId,
      cropNodeId,
      get viewport() {
        return renderedCamera.get();
      },
      targetViewport: viewport,
      // A getter: building 20k plain objects on every render was a real cost
      // on big boards even in dev; tests read it on demand.
      get nodes() {
        return boardNodes.map(({ id, kind, x, y, width, height, rotation, zIndex, crop }) => ({
          crop,
          id,
          kind,
          x,
          y,
          width,
          height,
          rotation,
          zIndex,
        }));
      },
      notes: snapshot?.notes.map((note) => ({ id: note.id, text: noteText(note.content_json) })),
      get groups() {
        return snapshot?.groups.map((group) => ({
          id: group.id,
          locked: group.locked,
          members: snapshot.items.filter((item) => item.group_id === group.id).map((i) => i.id),
        }));
      },
      tags: snapshot?.tags.map((tag) => ({ id: tag.id, name: tag.name })),
      itemTags: snapshot?.item_tags,
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
    setDrillGroupId(null);
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
            onClick={() => setSnapshotsOpen(true)}
            disabled={!activeBoardId}
          >
            Snapshots
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
        onPointerMove={(event) => {
          lastPointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerLeave={() => {
          lastPointer.current = null;
        }}
        onPointerDownCapture={(event) => {
          if (event.button === 2) rightPress.current = { x: event.clientX, y: event.clientY };
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('input, textarea, .search-filter')) return;
          event.preventDefault();
          const press = rightPress.current;
          rightPress.current = null;
          // A right-DRAG is not a click (§2B): no menu.
          if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 3) return;
          const canvas = boardCanvas.current;
          if (!canvas) return;
          const nodeId = canvas.nodeIdAt(event.clientX, event.clientY);
          const world = screenToWorld(
            event,
            renderedCamera.get(),
            canvasHost.current?.getBoundingClientRect() ?? new DOMRect(),
          );
          if (nodeId) {
            // Right-clicking outside the selection retargets it, like PureRef.
            if (!selectedNodeIds.includes(nodeId)) {
              setNoteEditingId(null);
              setSelectedNodeIds([nodeId]);
            }
            setMenu({ kind: 'selection', client: { x: event.clientX, y: event.clientY }, world });
          } else {
            setMenu({ kind: 'canvas', client: { x: event.clientX, y: event.clientY }, world });
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <div id="canvas-host" ref={canvasHost} />
        {snapshot && (
          <SearchBar
            tags={snapshot.tags}
            filter={filter}
            onChange={setFilter}
            loading={filtered.loading}
            error={filtered.error}
            resultCount={
              filtered.active ? filtered.items.length + filtered.notes.length : undefined
            }
            onRetry={filtered.retry}
          />
        )}
        {/* Everything positioned on the canvas re-renders with the painted
            camera each frame — and nothing else does. */}
        <CameraBound>
          {(camera) => (
            <>
              {guides.map((guide) => (
                <div
                  key={`${guide.axis}:${guide.at}`}
                  className={`snap-guide snap-guide--${guide.axis}`}
                  style={
                    guide.axis === 'x'
                      ? {
                          left: camera.x + guide.at * camera.zoom,
                          top: camera.y + guide.from * camera.zoom,
                          height: (guide.to - guide.from) * camera.zoom,
                        }
                      : {
                          top: camera.y + guide.at * camera.zoom,
                          left: camera.x + guide.from * camera.zoom,
                          width: (guide.to - guide.from) * camera.zoom,
                        }
                  }
                />
              ))}
              <DrawingOverlay enabled={drawing} viewport={camera} />
              {/* §4 Editing: the one note being edited swaps its canvas sprite for
                    a DOM editor laid out with the same pretext metrics. */}
              {editingNote && (
                <NoteEditor
                  key={editingNote.id}
                  note={editingNote}
                  viewport={camera}
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
                        left: camera.x + bounds.left * camera.zoom - 0.5,
                        top: camera.y + bounds.top * camera.zoom - 0.5,
                        width: (bounds.right - bounds.left) * camera.zoom,
                        height: (bounds.bottom - bounds.top) * camera.zoom,
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
                  viewport={camera}
                  editing={noteEditing}
                  locked={shellLocked}
                  cropping={
                    cropNodeId !== null &&
                    shellNodes.length === 1 &&
                    shellNodes[0]?.id === cropNodeId
                  }
                  onDoubleClick={(event) =>
                    doubleClickRef.current(
                      boardCanvas.current?.nodeIdAt(event.clientX, event.clientY) ?? null,
                    )
                  }
                  onOutsidePress={(event) => boardCanvas.current?.overlayPointerDown(event)}
                  onChromePress={(event, action) =>
                    boardCanvas.current?.chromePointerDown(event, action)
                  }
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
                  snapTargets={(exclude) => boardCanvas.current?.snapTargets(exclude) ?? []}
                  onGuides={setGuides}
                  onPreview={(changes) =>
                    setPreviewPatches(
                      Object.fromEntries(changes.map(({ id, patch }) => [id, patch])),
                    )
                  }
                  onCommit={(changes) => {
                    setPreviewPatches({});
                    commitNodeChanges.current(changes);
                  }}
                />
              )}
            </>
          )}
        </CameraBound>
        {menu && (
          <BoardContextMenu
            position={menu.client}
            onClose={() => setMenu(null)}
            entries={
              menu.kind === 'selection'
                ? [
                    { label: 'Duplicate', action: actions.duplicate },
                    ...(shellNodes.length === 1 && shellNodes[0]?.kind !== 'note'
                      ? [
                          cropNodeId === shellNodes[0]?.id
                            ? {
                                label: 'Done Cropping',
                                shortcut: 'Enter',
                                action: () => setCropNodeId(null),
                              }
                            : {
                                label: 'Crop',
                                action: () => setCropNodeId(shellNodes[0]?.id ?? null),
                              },
                          ...(shellNodes[0] && isCropped(shellNodes[0])
                            ? [{ label: 'Reset Crop', action: actions.resetCrop }]
                            : []),
                        ]
                      : []),
                    selectionGrouped
                      ? { label: 'Ungroup', shortcut: 'Ctrl+Shift+G', action: actions.ungroup }
                      : {
                          label: 'Group',
                          shortcut: 'Ctrl+G',
                          disabled: selectedItemIds.length < 2,
                          action: actions.group,
                        },
                    {
                      label: 'Opacity',
                      action: () => undefined,
                      choices: [1, 0.75, 0.5, 0.25].map((value) => ({
                        label: `${value * 100}%`,
                        active: shellNodes.every((node) => node.opacity === value),
                        action: () => actions.setOpacity(value),
                      })),
                    },
                    ...(selectionGrouped
                      ? [
                          selectionLocked
                            ? { label: 'Unlock', action: () => actions.lock(false) }
                            : { label: 'Lock', action: () => actions.lock(true) },
                        ]
                      : []),
                    ...(selectionGrouped
                      ? [
                          {
                            label: 'Group Color',
                            action: () => undefined,
                            choices: GROUP_COLORS.map(({ name, value }) => ({
                              label: name,
                              swatch: value,
                              active: selectionGroupStyle?.bg_color === value,
                              action: () =>
                                actions.setGroupStyle(value, selectionGroupStyle?.opacity ?? 0.35),
                            })),
                          },
                          ...(selectionGroupStyle?.bg_color
                            ? [
                                {
                                  label: 'Group Opacity',
                                  action: () => undefined,
                                  choices: [0.2, 0.35, 0.6, 1].map((value) => ({
                                    label: `${Math.round(value * 100)}%`,
                                    active: selectionGroupStyle.opacity === value,
                                    action: () =>
                                      actions.setGroupStyle(selectionGroupStyle.bg_color, value),
                                  })),
                                },
                              ]
                            : []),
                        ]
                      : []),
                    ...(selectedItemIds.length > 0
                      ? [
                          ...(snapshot?.tags.length
                            ? [
                                {
                                  label: 'Tags',
                                  action: () => undefined,
                                  choices: snapshot.tags.map((tag) => ({
                                    label: tag.name,
                                    active: selectedItemIds.every((id) =>
                                      (snapshot.item_tags[id] ?? []).includes(tag.id),
                                    ),
                                    action: () => actions.toggleTag(tag.id),
                                  })),
                                },
                              ]
                            : []),
                          {
                            label: 'Add Tag',
                            action: () => undefined,
                            input: { placeholder: 'Add tag…', onSubmit: actions.newTag },
                          },
                        ]
                      : []),
                    { label: 'Bring to Front', action: actions.bringToFront },
                    { label: 'Send to Back', action: actions.sendToBack },
                    { label: 'Delete', shortcut: 'Del', action: actions.delete },
                  ]
                : [
                    { label: 'Add Note', action: () => actions.addNoteAt(menu.world) },
                    {
                      label: 'Paste',
                      shortcut: 'Ctrl+V',
                      action: () => void actions.pasteImages(menu.world),
                    },
                    { label: 'Zoom to Fit', action: actions.zoomToFit },
                  ]
            }
          />
        )}
        {snapshotsOpen && activeBoardId && (
          <SnapshotManager
            boardId={activeBoardId}
            onClose={() => setSnapshotsOpen(false)}
            onRestored={() => openBoard(activeBoardId)}
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
        {error && (
          <div className="error-banner" ref={(element) => enter(element, 'rise')}>
            {error}
          </div>
        )}
        {bindingsError && (
          <div className="error-banner" ref={(element) => enter(element, 'rise')}>
            bindings.toml ignored (using the defaults): {bindingsError}
          </div>
        )}
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

const isCropped = (node: CanvasNode) =>
  node.crop.x > 0 || node.crop.y > 0 || node.crop.w < 1 || node.crop.h < 1;

/** Group background swatches (§5B). `null` = no background. */
const GROUP_COLORS: { name: string; value: string | null }[] = [
  { name: 'No background', value: null },
  { name: 'Slate', value: '#5b6572' },
  { name: 'Red', value: '#d9534f' },
  { name: 'Amber', value: '#e6a23c' },
  { name: 'Green', value: '#5cb85c' },
  { name: 'Blue', value: '#4a90d9' },
  { name: 'Violet', value: '#9b6bd6' },
];

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
