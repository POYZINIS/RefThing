import { type ComponentType, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BatchQueue } from '@/api/batchQueue';
import {
  type BatchRequestOp,
  type BlobInfo,
  blobUrl,
  createSession,
  fetchBindingsOverride,
  fetchHealth,
  type HealthStatus,
  type Item,
  isBoardFile,
  type Note,
} from '@/api/client';
import { CLIENT_ID } from '@/api/clientId';
import { BoardSync } from '@/api/ws';
import { BoardCanvas, type ViewportState } from '@/canvas/BoardCanvas';
import { applyBindingsOverride, bindings, resolveKey } from '@/canvas/bindings';
import { MIN_ZOOM, screenToWorld } from '@/canvas/coordinates';
import {
  itemFields,
  itemToNode,
  itemWithPatch,
  noteToNode,
  noteWithPatch,
} from '@/canvas/nodes/adapters';
import {
  grownNoteHeight,
  NOTE_FONTS,
  NOTE_SIZES,
  type NoteFontId,
  type NoteStyle,
  noteScale,
  noteStyle,
  noteText,
  storedStyle,
} from '@/canvas/nodes/noteText';
import type { CanvasNode, NodeChange, NodePatch, SpriteNode } from '@/canvas/nodes/types';
import { CameraBound, renderedCamera } from '@/canvas/renderedCamera';
import { type Guide, recrop } from '@/canvas/transform';
import { BoardContextMenu, type MenuEntry } from '@/components/BoardContextMenu';
import { BoardSwitcher } from '@/components/BoardSwitcher';
import { type MediaHandle, MediaPlayer } from '@/components/MediaPlayer';
import { NoteEditor } from '@/components/NoteEditor';
import SearchBar, { emptyFilter, type FilterState } from '@/components/SearchBar';
import { SelectionOverlay } from '@/components/SelectionOverlay';
import { SettingsSheet } from '@/components/SettingsSheet';
import { SnapshotManager } from '@/components/SnapshotManager';
import { OpenTarget, type Toast, Toasts } from '@/components/Toasts';
import { WindowControls } from '@/components/WindowControls';
import { beginWindowMove, setNativeGlass } from '@/shell/desktop';
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
  restoreProportionsChanges,
  toggleTagOps,
  topZ,
  ungroupOps,
  unionRect,
} from '@/state/commands';
import { type HistoryEntry, prepareCommand } from '@/state/history';
import { useBoardFilter } from '@/state/useBoardFilter';
import { useAppearance } from '@/ui/appearance';
import { Icon } from '@/ui/Icon';
import { useProximityReveal } from '@/ui/useProximityReveal';

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
  // Search opens where it was asked for (right-click point / cursor).
  const [searchAt, setSearchAt] = useState<{ x: number; y: number } | null>(null);
  // The corner groups hide until the pointer comes near (useProximityReveal).
  const boardCorner = useRef<HTMLDivElement>(null);
  const windowCorner = useRef<HTMLDivElement>(null);
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Files dragged over the window (drop feedback); a counter, because
  // dragenter/leave fire for every child the drag crosses.
  const [fileDrag, setFileDrag] = useState(0);
  const [bindingsDismissed, setBindingsDismissed] = useState(false);
  // A quiet confirmation (e.g. what an imported board brought across).
  const [notice, setNotice] = useState<{ title: string; message?: string } | null>(null);
  const [healthDismissed, setHealthDismissed] = useState(false);
  const theme = useAppearance((state) => state.resolved);
  const setAppearance = useAppearance((state) => state.set);
  const glass = useAppearance((state) => state.glass);
  // Unified selection: items and notes share one id list (mixed multi-select
  // works); the noteIds set below routes persistence per kind.
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  // The note currently in text-edit mode (§4 RULE 2 — double-click only).
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  /** Phase 11 live mode: the video/audio item whose player is mounted. */
  /** A media item that should start playing once its player mounts. */
  const [autoPlayId, setAutoPlayId] = useState<string | null>(null);
  /** The mounted player's controls (double-click / Play toggle it). */
  const mediaHandle = useRef<MediaHandle | null>(null);
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
  // Right-press origin, in SCREEN px: a right-drag past the click epsilon is
  // not a click, so it must not open the menu (testing §2B context menu vs
  // move window). Screen, not client: moving the window keeps the pointer
  // still relative to the page.
  const rightPress = useRef<{ x: number; y: number } | null>(null);
  // Double-click zoom on an image toggles back to the camera it came from.
  const zoomReturn = useRef<{ nodeId: string; viewport: ViewportState } | null>(null);
  // Consecutive nudges of the same selection coalesce into one undo entry.
  const coalesce = useRef<{ key: string; at: number; entry: HistoryEntry } | null>(null);
  const socket = useRef<BoardSync | null>(null);
  const batchQueue = useRef<BatchQueue | null>(null);
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const busy = useBoardStore((state) => state.busy);
  const error = useBoardStore((state) => state.error);
  const clearError = useBoardStore((state) => state.clearError);
  const loadBoards = useBoardStore((state) => state.loadBoards);
  const openBoard = useBoardStore((state) => state.openBoard);
  const createAndOpenBoard = useBoardStore((state) => state.createAndOpenBoard);
  const renameBoard = useBoardStore((state) => state.renameBoard);
  const deleteBoard = useBoardStore((state) => state.deleteBoard);
  const ingest = useBoardStore((state) => state.ingest);
  const importBoard = useBoardStore((state) => state.importBoard);
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
          // Keep every other content key (an imported note's text scale).
          note: {
            ...note,
            content_json: { ...(note.content_json as object), text: content },
            height,
            updated_at: Date.now(),
          },
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
  const selectedNoteId =
    selectedNodeIds.length === 1 && primaryNodeId && noteIds.has(primaryNodeId)
      ? primaryNodeId
      : null;
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

  const connectRef = useRef<() => void>(() => undefined);
  connectRef.current = () => {
    setHealth({ kind: 'loading' });
    setHealthDismissed(false);
    fetchHealth()
      .then((result) => {
        setHealth({ kind: 'ok', health: result });
        return createSession().then(() => loadBoards());
      })
      .catch((caught: unknown) => {
        setHealth({
          kind: 'error',
          message: caught instanceof Error ? caught.message : 'Backend unreachable',
        });
      });
  };
  useEffect(() => connectRef.current(), []);

  // The desktop backdrop material follows the glass preference.
  useEffect(() => setNativeGlass(glass), [glass]);

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
      onMoveWindow: (event) => {
        beginWindowMove(event, RIGHT_CLICK_EPSILON_PX);
      },
      snapToGrid: false,
    });
    boardCanvas.current = canvas;
    canvas.setZoomSpeed(useAppearance.getState().zoomSpeed);
    void canvas.mount(canvasHost.current);
    return () => {
      if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
      canvas.destroy();
      boardCanvas.current = null;
    };
  }, [saveViewport]);

  // Scroll zoom speed (Settings), live.
  const zoomSpeed = useAppearance((state) => state.zoomSpeed);
  useEffect(() => {
    boardCanvas.current?.setZoomSpeed(zoomSpeed);
  }, [zoomSpeed]);
  // Unfilled notes draw their text in the theme's flip: repaint on a switch.
  useEffect(() => {
    if (theme) boardCanvas.current?.redraw();
  }, [theme]);

  // The note being edited is drawn by its DOM editor, not the canvas.
  useEffect(() => {
    boardCanvas.current?.setHiddenNode(noteEditing ? noteEditingId : null);
  }, [noteEditing, noteEditingId]);

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
      // Phase 11: any file lands on the board (media, documents as cards).
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        actionsRef.current.addFiles(files, lastPointer.current);
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
  }, []);

  // Restore a board's saved camera ONCE, when it opens. The saved value only
  // flows the other way afterwards: every debounced save echoes back into
  // snapshot.board, and re-applying that echo snapped the eased camera (and
  // jumped it backwards if the user kept panning during the round trip).
  const cameraRestoredFor = useRef<string | null>(null);
  const openedBoard = snapshot?.board;
  useEffect(() => {
    if (!openedBoard || cameraRestoredFor.current === openedBoard.id) return;
    cameraRestoredFor.current = openedBoard.id;
    const saved = savedViewport(openedBoard.viewport_state);
    if (saved) {
      boardCanvas.current?.setViewport(saved);
      setViewport(saved);
      return;
    }
    // Never framed (NULL viewport_state): show the whole board, not the
    // world origin — content left of or above 0,0 would open off-screen.
    const canvas = boardCanvas.current;
    const content = useBoardStore.getState().snapshot;
    const host = canvasHost.current;
    if (!canvas || !content || !host) return;
    // The host, not canvas.size(): Pixi may still be initialising.
    const { clientWidth: width, clientHeight: height } = host;
    const bounds = unionRect([
      ...content.items.map((item) => ({
        left: item.x,
        top: item.y,
        right: item.x + item.width,
        bottom: item.y + item.height,
      })),
      ...content.notes.map((note) => noteToNode(note).rotatedBounds()),
    ]);
    const start = fitViewport(bounds, width, height, 72, [MIN_ZOOM, 1]) ?? {
      x: width / 2,
      y: height / 2,
      zoom: 1,
    };
    canvas.setViewport(start);
    setViewport(start);
  }, [openedBoard]);

  // Blobs by hash: a node's kind (GIF playback, media posters, file cards)
  // and card text come from its blob.
  const lockedGroupIds = useMemo(
    () => new Set(snapshot?.groups.filter((group) => group.locked).map((group) => group.id) ?? []),
    [snapshot?.groups],
  );
  groupOfRef.current = (nodeId) =>
    snapshot?.items.find((item) => item.id === nodeId)?.group_id ?? null;
  const blobsByHash = useMemo(
    () => new Map((snapshot?.blobs ?? []).map((blob) => [blob.hash, blob])),
    [snapshot?.blobs],
  );

  useEffect(() => {
    // Notes go in as geometry-only nodes (hit-testing, box select); they
    // keep rendering through the DOM NoteOverlay.
    boardCanvas.current?.update(renderedItems, blobsByHash, canvasNotes, snapshot?.groups);
  }, [renderedItems, blobsByHash, canvasNotes, snapshot?.groups]);

  useEffect(() => {
    boardCanvas.current?.setDrillGroup(drillGroupId);
  }, [drillGroupId]);

  // Unified node view of the board for selection chrome, hover outlines, and
  // group-mate lookup. Unfiltered — the shell tracks selected nodes even
  // when a search filter hides them — with live preview patches merged.
  // Item nodes are built once per snapshot; a live preview (drag, resize)
  // rebuilds only the previewed nodes — rebuilding all 20k per pointermove
  // dropped frames on big boards.
  // Nodes are cached per item object: applyBoardOps keeps unchanged items
  // identical, so a one-item change rebuilds one node, not 20k.
  const nodeCache = useRef(
    new WeakMap<Item, { node: CanvasNode; blob: BlobInfo | undefined; locked: boolean }>(),
  );
  const baseItemNodes = useMemo(() => {
    const byId = new Map<string, { item: Item & { blob_hash: string }; node: CanvasNode }>();
    for (const item of snapshotItems ?? []) {
      if (!item.blob_hash) continue;
      const withBlob = item as Item & { blob_hash: string };
      const blob = blobsByHash.get(withBlob.blob_hash);
      const locked = withBlob.group_id !== null && lockedGroupIds.has(withBlob.group_id);
      let hit = nodeCache.current.get(withBlob);
      if (!hit || hit.blob !== blob || hit.locked !== locked) {
        hit = { node: itemToNode(withBlob, blob, locked), blob, locked };
        nodeCache.current.set(withBlob, hit);
      }
      byId.set(withBlob.id, { item: withBlob, node: hit.node });
    }
    return byId;
  }, [snapshotItems, blobsByHash, lockedGroupIds]);
  const boardNodesById = useMemo(() => {
    const byId = new Map<string, CanvasNode>();
    for (const [id, { node }] of baseItemNodes) byId.set(id, node);
    for (const id of new Set([...Object.keys(previewPatches), ...Object.keys(dragPreview)])) {
      const base = baseItemNodes.get(id);
      if (!base) continue;
      const preview = previewPatches[id] ?? dragPreview[id];
      byId.set(
        id,
        itemToNode(
          itemWithPatch(base.item, preview),
          blobsByHash.get(base.item.blob_hash),
          base.node.locked,
        ),
      );
    }
    for (const note of renderedNotes) byId.set(note.id, noteToNode(note));
    return byId;
  }, [baseItemNodes, blobsByHash, previewPatches, dragPreview, renderedNotes]);
  const boardNodes = useMemo(() => [...boardNodesById.values()], [boardNodesById]);
  // A lone selected video/audio item gets its player (custom controls);
  // it lasts while that item stays the one selected node.
  const liveCandidate =
    selectedNodeIds.length === 1 && selectedNodeIds[0]
      ? boardNodesById.get(selectedNodeIds[0])
      : undefined;
  const liveNode =
    liveCandidate && (liveCandidate.kind === 'video' || liveCandidate.kind === 'audio')
      ? liveCandidate
      : null;
  /** Double-click / Play: toggle the item's playback, selecting it (and
   *  starting it) first when it isn't the live one yet. */
  const playMediaRef = useRef<(nodeId: string) => void>(() => undefined);
  playMediaRef.current = (nodeId) => {
    if (liveNode?.id === nodeId && mediaHandle.current) {
      mediaHandle.current.toggle();
      return;
    }
    setNoteEditingId(null);
    setSelectedNodeIds([nodeId]);
    setAutoPlayId(nodeId);
  };
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
  const selectedNoteRecords =
    snapshot?.notes.filter((note) => selectedNodeIds.includes(note.id)) ?? [];
  const selectedNoteStyles = selectedNoteRecords.map((note) => noteStyle(note.content_json));
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
    /** Open a file item's original in a new tab (the browser shows what it
     *  can — PDFs, text, media — and downloads the rest). */
    openFile: (node: SpriteNode) => {
      window.open(blobUrl(node.blobHash, 'full'), '_blank', 'noopener');
    },
    download: (node: SpriteNode) => {
      const link = document.createElement('a');
      link.href = blobUrl(node.blobHash, 'full');
      link.download = node.label;
      link.click();
    },
    /** Restyle the selected notes (content_json.style) as one undo step; a
     *  note grows to fit when its text gets bigger. */
    styleNotes: (patch: Partial<NoteStyle>) => {
      if (!snapshot) return;
      const now = Date.now();
      const ops: BatchRequestOp[] = selectedNoteRecords.map((note) => {
        const style = { ...noteStyle(note.content_json), ...patch };
        const { style: _old, ...rest } = (note.content_json ?? {}) as Record<string, unknown>;
        const stored = storedStyle(style);
        const content = Object.keys(stored).length > 0 ? { ...rest, style: stored } : rest;
        const height = grownNoteHeight(
          noteText(content),
          note.width,
          note.height,
          noteScale(content),
          style,
        );
        return {
          kind: 'put_note' as const,
          op_id: crypto.randomUUID(),
          note: { ...note, content_json: content, height, updated_at: now },
        };
      });
      if (ops.length > 0) commitBoardOps.current(ops, 'Text style');
    },
    /** The selected notes' fill; null = none (text only, over the board). */
    fillNotes: (fill: string | null) => {
      const now = Date.now();
      const ops: BatchRequestOp[] = selectedNoteRecords.map((note) => ({
        kind: 'put_note' as const,
        op_id: crypto.randomUUID(),
        note: { ...note, bg_color: fill, updated_at: now },
      }));
      if (ops.length > 0) commitBoardOps.current(ops, 'Note fill');
    },
    /** Ctrl/Cmd+B / +I on selected notes: on for all, unless all are on. */
    bold: () =>
      actionsRef.current.styleNotes({ bold: !selectedNoteStyles.every((style) => style.bold) }),
    italic: () =>
      actionsRef.current.styleNotes({
        italic: !selectedNoteStyles.every((style) => style.italic),
      }),
    restoreProportions: () => {
      const changes = restoreProportionsChanges(shellNodes, ({ id }) => {
        const item = snapshot?.items.find((candidate) => candidate.id === id);
        const blob = item?.blob_hash ? blobsByHash.get(item.blob_hash) : undefined;
        return blob?.width && blob.height ? { width: blob.width, height: blob.height } : null;
      });
      if (changes.length > 0) commitNodeChanges.current(changes, 'Restore Proportions');
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
    /** World point for files arriving at `client` (a drop, the pointer), or
     *  the middle of the view when there is none. */
    dropPoint: (client: { x: number; y: number } | null) => {
      const host = canvasHost.current?.getBoundingClientRect();
      if (!host) return { x: 0, y: 0 };
      const at = client ?? { x: host.left + host.width / 2, y: host.top + host.height / 2 };
      return screenToWorld({ clientX: at.x, clientY: at.y }, renderedCamera.get(), host);
    },
    /** Add files (Phase 11: every type lands; the server's type handlers
     *  decide how it draws), centred where they arrived. Empty entries —
     *  dropped folders — are skipped. */
    addFiles: (files: FileList | File[], client: { x: number; y: number } | null = null) => {
      const accepted = Array.from(files).filter((file) => file.size > 0);
      // A PureRef board comes in whole, as a board of its own.
      const boardFiles = accepted.filter(isBoardFile);
      const rest = accepted.filter((file) => !isBoardFile(file));
      if (rest.length > 0) void ingest(rest, actionsRef.current.dropPoint(client));
      if (boardFiles.length > 0) void actionsRef.current.importBoards(boardFiles);
    },
    /** Import board files one after another; the last one stays open. */
    importBoards: async (files: File[]) => {
      for (const file of files) {
        const result = await importBoard(file);
        if (!result) continue;
        const counts = [
          `${result.images} ${result.images === 1 ? 'image' : 'images'}`,
          `${result.notes} ${result.notes === 1 ? 'note' : 'notes'}`,
        ].join(', ');
        setNotice({
          title: `Imported ${result.name}`,
          message:
            result.skipped.length > 0
              ? `${counts}. Not brought in: ${result.skipped.join('; ')}.`
              : `${counts}.`,
        });
      }
    },
    add_files: () => {
      if (activeBoardId) fileInput.current?.click();
    },
    /** Ctrl+F: the search panel, at the cursor (else the top of the view). */
    find: () => {
      if (!snapshot) return;
      setSearchAt(lastPointer.current ?? { x: window.innerWidth / 2 - 180, y: 64 });
    },
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
            : node.kind === 'video' || node.kind === 'audio'
              ? 'media'
              : node.kind === 'file'
                ? 'file'
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
    if (action === 'play_media' && (node.kind === 'video' || node.kind === 'audio')) {
      playMediaRef.current(nodeId);
      return;
    }
    if (action === 'open_file' && node.kind !== 'note') {
      actions.openFile(node);
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
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], dialog, [role="dialog"], [role="menu"]',
        )
      )
        return;
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
        return boardNodes.map((node) => ({
          crop: node.crop,
          id: node.id,
          kind: node.kind,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation,
          zIndex: node.zIndex,
          poster: node.kind === 'note' ? undefined : node.poster,
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

  const toasts: Toast[] = [];
  if (health.kind === 'error' && !healthDismissed) {
    toasts.push({
      id: 'health',
      kind: 'error',
      title: 'Can’t reach the RefThing server',
      message: `Boards can’t open or save until it answers (${health.message}).`,
      action: { label: 'Try again', run: () => connectRef.current() },
      onDismiss: () => setHealthDismissed(true),
    });
  }
  if (error) {
    toasts.push({ id: 'error', kind: 'error', title: error, onDismiss: clearError });
  }
  if (bindingsError && !bindingsDismissed) {
    toasts.push({
      id: 'bindings',
      kind: 'error',
      title: 'bindings.toml was ignored',
      message: `The default controls are in use. ${bindingsError}`,
      onDismiss: () => setBindingsDismissed(true),
    });
  }
  if (notice) {
    toasts.push({
      id: `notice:${notice.title}`,
      kind: 'info',
      title: notice.title,
      message: notice.message,
      onDismiss: () => setNotice(null),
    });
  }

  // Empty and settled: not while it loads or while files are arriving.
  const boardIsEmpty =
    !!snapshot && snapshot.items.length === 0 && snapshot.notes.length === 0 && !loading && !busy;
  const noBoards = health.kind === 'ok' && !loading && !activeBoardId && boards.length === 0;
  const status = busy ?? (loading && activeBoardId ? 'Opening board…' : null);
  const primaryKey = /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  /** Files dropped or chosen: onto the open board at `client`, or — with no
   *  board yet — onto a new one. */
  const dropFiles = async (files: FileList | File[], client: { x: number; y: number } | null) => {
    if (activeBoardId) {
      actions.addFiles(files, client);
      return;
    }
    const all = Array.from(files).filter((file) => file.size > 0);
    // Board files need no board to land on: each becomes its own.
    const boardFiles = all.filter(isBoardFile);
    if (boardFiles.length > 0) await actions.importBoards(boardFiles);
    const accepted = all.filter((file) => !isBoardFile(file));
    if (accepted.length === 0) return;
    await createAndOpenBoard('Untitled board');
    // A new board opens framed on the world origin.
    await ingest(accepted, { x: 0, y: 0 });
  };

  // With no board yet (first run) the board group stays out: it's the way in.
  const boardCornerShown = useProximityReveal(boardCorner, !activeBoardId);
  const windowCornerShown = useProximityReveal(windowCorner, false);

  // Text controls for the notes in the selection (§5B: a note's rare
  // actions live in its menu). Rows stay open while you adjust.
  const every = <K extends keyof NoteStyle>(key: K, value: NoteStyle[K]) =>
    selectedNoteStyles.length > 0 && selectedNoteStyles.every((style) => style[key] === value);
  const fills = selectedNoteRecords.map((note) => note.bg_color);
  const textMenu: MenuEntry[] =
    selectedNoteRecords.length === 0
      ? []
      : [
          {
            label: 'Style',
            keepOpen: true,
            action: () => undefined,
            choices: [
              {
                label: 'Bold',
                toggle: true,
                active: every('bold', true),
                action: actions.bold,
              },
              {
                label: 'Italic',
                toggle: true,
                active: every('italic', true),
                action: actions.italic,
              },
            ],
          },
          {
            label: 'Align',
            keepOpen: true,
            action: () => undefined,
            choices: (['left', 'center', 'right'] as const).map((align) => ({
              label: align[0]?.toUpperCase() + align.slice(1),
              active: every('align', align),
              action: () => actions.styleNotes({ align }),
            })),
          },
          {
            label: 'Font',
            keepOpen: true,
            action: () => undefined,
            choices: (Object.keys(NOTE_FONTS) as NoteFontId[]).map((font) => ({
              label: NOTE_FONTS[font].label,
              font: NOTE_FONTS[font].family,
              active: every('font', font),
              action: () => actions.styleNotes({ font }),
            })),
          },
          {
            label: 'Size',
            keepOpen: true,
            action: () => undefined,
            choices: NOTE_SIZES.map((size) => ({
              label: size.label,
              active: every('size', size.px),
              action: () => actions.styleNotes({ size: size.px }),
            })),
          },
          {
            label: 'Text color',
            keepOpen: true,
            action: () => undefined,
            choices: [
              {
                label: 'Automatic',
                swatch: 'auto',
                active: every('color', null),
                action: () => actions.styleNotes({ color: null }),
              },
              ...NOTE_TEXT_COLORS.map(({ name, value }) => ({
                label: name,
                swatch: value,
                active: every('color', value),
                action: () => actions.styleNotes({ color: value }),
              })),
            ],
          },
          {
            label: 'Fill',
            keepOpen: true,
            action: () => undefined,
            choices: [
              {
                label: 'No fill',
                swatch: null,
                active: fills.every((fill) => fill === null),
                action: () => actions.fillNotes(null),
              },
              ...NOTE_FILLS.map(({ name, value }) => ({
                label: name,
                swatch: value,
                active: fills.every((fill) => fill === value),
                action: () => actions.fillNotes(value),
              })),
            ],
          },
          {
            label: 'Markdown',
            keepOpen: true,
            checked: every('markdown', true),
            action: () => actions.styleNotes({ markdown: !every('markdown', true) }),
          },
          { separator: true, label: 'text' },
        ];

  const canvasMenu: MenuEntry[] = [
    { label: 'Add Note', action: () => actions.addNoteAt(menu?.world ?? { x: 0, y: 0 }) },
    {
      label: 'Paste',
      shortcut: `${primaryKey}V`,
      action: () => void actions.pasteImages(menu?.world ?? null),
    },
    { label: 'Add Files…', shortcut: `${primaryKey}O`, action: actions.add_files },
    { separator: true, label: 'view' },
    {
      label: 'Search…',
      shortcut: `${primaryKey}F`,
      action: () => setSearchAt(menu?.client ?? null),
    },
    { label: 'Zoom to Fit', action: actions.zoomToFit },
  ];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file drops land anywhere in the window
    <div
      className="app-shell"
      onDragEnter={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        setFileDrag((count) => count + 1);
      }}
      onDragLeave={(event) => {
        if (isFileDrag(event)) setFileDrag((count) => Math.max(0, count - 1));
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = health.kind === 'ok' ? 'copy' : 'none';
      }}
      onDrop={(event) => {
        event.preventDefault();
        setFileDrag(0);
        if (health.kind !== 'ok' || event.dataTransfer.files.length === 0) return;
        void dropFiles(event.dataTransfer.files, { x: event.clientX, y: event.clientY });
      }}
      onContextMenu={(event) => {
        // No browser menu over the chrome; text fields keep theirs.
        if (!(event.target as HTMLElement).closest('input, textarea')) event.preventDefault();
      }}
    >
      <main
        className={`canvas-frame ${fileDrag > 0 ? 'dragging-files' : ''}`}
        onPointerMove={(event) => {
          lastPointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerLeave={() => {
          lastPointer.current = null;
        }}
        onPointerDownCapture={(event) => {
          if (event.button === 2) rightPress.current = { x: event.screenX, y: event.screenY };
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('input, textarea, .open-target')) return;
          event.preventDefault();
          const press = rightPress.current;
          rightPress.current = null;
          // A right-DRAG is not a click (§2B): no menu.
          if (
            press &&
            Math.hypot(event.screenX - press.x, event.screenY - press.y) >= RIGHT_CLICK_EPSILON_PX
          )
            return;
          const canvas = boardCanvas.current;
          if (!canvas || !activeBoardId) return;
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
      >
        <div id="canvas-host" ref={canvasHost} />
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
              {liveNode && (
                <MediaPlayer
                  key={liveNode.id}
                  node={liveNode}
                  viewport={camera}
                  autoPlay={autoPlayId === liveNode.id}
                  onAutoPlayed={() => setAutoPlayId(null)}
                  handle={mediaHandle}
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
        {noBoards && (
          <OpenTarget
            label="New board"
            dropLabel="Drop to start a board"
            hint="or drop images and files anywhere"
            dragging={fileDrag > 0}
            onActivate={() => void createAndOpenBoard('Untitled board')}
          />
        )}
        {activeBoardId && boardIsEmpty && (
          <OpenTarget
            label="Add files"
            dropLabel="Drop files"
            hint="Drop or paste images, video, audio or any file. Right-click for a note."
            dragging={fileDrag > 0}
            onActivate={actions.add_files}
          />
        )}
        {fileDrag > 0 && activeBoardId && !boardIsEmpty && (
          <div className="drop-overlay">
            <span>Drop to add here</span>
          </div>
        )}
      </main>

      <header className="chrome-top" data-tauri-drag-region>
        <div
          ref={boardCorner}
          className="chrome-corner"
          data-revealed={boardCornerShown}
          role="toolbar"
          aria-label="Board"
        >
          <div className="control-group">
            <BoardSwitcher
              boards={boards}
              activeBoardId={activeBoardId}
              activeItemCount={
                snapshot && snapshot.board.id === activeBoardId
                  ? snapshot.items.length + snapshot.notes.length
                  : null
              }
              onOpen={(boardId) => void openBoard(boardId)}
              onCreate={(name) => createAndOpenBoard(name)}
              onRename={renameBoard}
              onDelete={deleteBoard}
              onSnapshots={() => setSnapshotsOpen(true)}
            />
            <span className="chrome-divider" />
            <button
              className="icon-button"
              type="button"
              aria-label="Add files"
              title={`Add files (${primaryKey}O)`}
              disabled={!activeBoardId}
              onClick={actions.add_files}
            >
              <Icon name="addFiles" />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              onClick={() => setAppearance({ theme: theme === 'dark' ? 'light' : 'dark' })}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="gear" />
            </button>
          </div>
        </div>
        <span className="chrome-spacer" data-tauri-drag-region />
        <div ref={windowCorner} className="chrome-corner" data-revealed={windowCornerShown}>
          <WindowControls />
        </div>
      </header>

      {snapshot && (
        <SearchBar
          tags={snapshot.tags}
          filter={filter}
          onChange={setFilter}
          loading={filtered.loading}
          error={filtered.error}
          resultCount={filtered.active ? filtered.items.length + filtered.notes.length : undefined}
          onRetry={filtered.retry}
          openAt={searchAt}
          onOpen={() => setSearchAt({ x: window.innerWidth / 2 - 180, y: 64 })}
          onClose={() => setSearchAt(null)}
        />
      )}

      {/* Opening a board, adding files, importing: a quiet line, bottom centre. */}
      {status && (
        <div className="chrome-bottom">
          <div className="status-pill" role="status">
            <span className="spinner" />
            {status}
          </div>
        </div>
      )}

      {menu && (
        <BoardContextMenu
          position={menu.client}
          onClose={() => setMenu(null)}
          entries={
            menu.kind === 'selection'
              ? [
                  ...textMenu,
                  { label: 'Duplicate', action: actions.duplicate },
                  ...(() => {
                    // Phase 11: play / open / download a lone media or file item.
                    const lone = shellNodes.length === 1 ? shellNodes[0] : undefined;
                    if (!lone || lone.kind === 'note') return [];
                    return [
                      ...(lone.kind === 'video' || lone.kind === 'audio'
                        ? [
                            {
                              label: 'Play / Pause',
                              action: () => playMediaRef.current(lone.id),
                            },
                          ]
                        : []),
                      ...(lone.kind === 'file'
                        ? [{ label: 'Open', action: () => actions.openFile(lone) }]
                        : []),
                      { label: 'Download', action: () => actions.download(lone) },
                    ];
                  })(),
                  { label: 'Restore Proportions', action: actions.restoreProportions },
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
              : canvasMenu
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
      {settingsOpen && (
        <SettingsSheet
          tags={snapshot?.tags ?? null}
          onRenameTag={renameTag}
          onDeleteTag={deleteTag}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <Toasts toasts={toasts} />
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          if (event.target.files) actions.addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {import.meta.env.DEV && LazyFpsHud && (
        <Suspense fallback={null}>
          <LazyFpsHud />
        </Suspense>
      )}
    </div>
  );
}

/** A right press that travels less than this (screen px) is a click: the
 *  context menu. Further, and it's a right-drag (the window moves). */
const RIGHT_CLICK_EPSILON_PX = 3;

/** Note text colours (plus Automatic: the theme's flip, or contrast with a
 *  fill). Board content, so fixed across themes. */
const NOTE_TEXT_COLORS: { name: string; value: string }[] = [
  { name: 'Ink', value: '#1f2622' },
  { name: 'White', value: '#f4f6f4' },
  { name: 'Gray', value: '#8d9891' },
  { name: 'Red', value: '#d9534f' },
  { name: 'Amber', value: '#e6a23c' },
  { name: 'Green', value: '#4caf6a' },
  { name: 'Blue', value: '#4a90d9' },
  { name: 'Violet', value: '#9b6bd6' },
];

/** Note fills (plus No fill: text only, over the board). */
const NOTE_FILLS: { name: string; value: string }[] = [
  { name: 'Paper', value: '#f4f6f4' },
  { name: 'Charcoal', value: '#2b2f2d' },
  { name: 'Sticky', value: '#f5e7ad' },
  { name: 'Rose', value: '#f3c9c3' },
  { name: 'Mint', value: '#cde8d3' },
  { name: 'Sky', value: '#c8ddf3' },
  { name: 'Lavender', value: '#dfd3f3' },
];

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

/** A board's saved camera, or null when it was never framed. */
function savedViewport(value: unknown): ViewportState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return null;
  return { x, y, zoom };
}

const isFileDrag = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');
