import { create } from 'zustand';
import {
  type BatchOp,
  type BatchRequestOp,
  type BoardEvent,
  type BoardSnapshot,
  type BoardSummary,
  createBoard,
  createTag as createTagApi,
  deleteBoard as deleteBoardApi,
  deleteTag as deleteTagApi,
  fetchBoard,
  type ImportResult,
  type IngestResponse,
  importBoard as importBoardApi,
  ingestFiles,
  listBoards,
  renameBoard as renameBoardApi,
  submitBatch,
  type Tag,
  updateBoardViewport,
  updateNote,
  updateTag as updateTagApi,
} from '@/api/client';
import { CLIENT_ID } from '@/api/clientId';
import { arrangeDrop, arrivalSize, type Camera, DROP_GAP } from './commands';
import { applyBoardOps } from './history';

type BoardState = {
  boards: BoardSummary[];
  activeBoardId: string | null;
  snapshot: BoardSnapshot | null;
  loading: boolean;
  /** A long write in progress, for the status line ("Adding 3 files…"). */
  busy: string | null;
  error: string | null;
  clearError: () => void;
  loadBoards: () => Promise<void>;
  openBoard: (boardId: string) => Promise<void>;
  createAndOpenBoard: (name: string) => Promise<void>;
  renameBoard: (boardId: string, name: string) => Promise<void>;
  deleteBoard: (boardId: string) => Promise<void>;
  /** Import a board file (PureRef `.pur`) as a new board and open it. */
  importBoard: (file: File) => Promise<ImportResult | null>;
  /** Upload files; `at` (world) centres them on the drop point, sized
   *  relative to `camera` (see arrivalSize). */
  ingest: (
    files: File[],
    at?: { x: number; y: number },
    camera?: Camera,
    /** Deliver the placement ops (the app's optimistic write queue). */
    place?: (ops: BatchRequestOp[]) => void,
  ) => Promise<void>;
  /** Put freshly ingested items and blobs into the open board's snapshot. */
  addIngested: (boardId: string, response: IngestResponse) => void;
  saveViewport: (viewportState: { x: number; y: number; zoom: number }) => Promise<void>;
  saveDrawing: (noteId: string, strokes: Array<Array<{ x: number; y: number }>>) => Promise<void>;
  createTag: (name: string, color?: string | null) => Promise<Tag>;
  renameTag: (tagId: string, name: string) => Promise<Tag>;
  deleteTag: (tagId: string) => Promise<void>;
  addTagLocal: (tag: Tag) => void;
  applySnapshot: (snapshot: BoardSnapshot) => void;
  applyOps: (ops: BatchOp[], seq?: number) => void;
  setPendingOpsSource: (source: (() => BatchOp[]) | null) => void;
  applyChanges: (seq: number, events: BoardEvent[]) => void;
  /** A poster job finished: record its levels on the item's blob (by name,
   *  e.g. ['thumb', 'small', 'medium', 'full']; legacy edge sizes accepted). */
  markPosterReady: (itemId: string, ready: (string | number)[]) => void;
};

/** Longest edge per pyramid level (px); `full` is native. */
const LEVEL_EDGES: Record<string, number> = {
  thumb: 64,
  small: 256,
  medium: 1024,
  full: Number.POSITIVE_INFINITY,
};

/** The board to open on launch: `?board=<id>` in the URL, else the last one
 *  opened on this machine. */
const LAST_BOARD_KEY = 'refthing.lastBoard';
function preferredBoard(): string | null {
  try {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('board');
    return fromUrl ?? globalThis.localStorage?.getItem(LAST_BOARD_KEY) ?? null;
  } catch {
    return null;
  }
}
function rememberBoard(boardId: string | null): void {
  try {
    if (boardId) globalThis.localStorage?.setItem(LAST_BOARD_KEY, boardId);
    else globalThis.localStorage?.removeItem(LAST_BOARD_KEY);
  } catch {
    // Storage blocked: launch falls back to the first board.
  }
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** poster_ready notices for items not in the snapshot yet (by item id). */
const earlyPosters = new Map<string, (string | number)[]>();

/** Unacknowledged optimistic ops (registered by the active BatchQueue). */
let pendingOpsSource: (() => BatchOp[]) | null = null;

export const useBoardStore = create<BoardState>((set, get) => ({
  setPendingOpsSource(source) {
    pendingOpsSource = source;
  },

  boards: [],
  activeBoardId: null,
  snapshot: null,
  loading: true,
  busy: null,
  error: null,

  clearError() {
    set({ error: null });
  },

  async loadBoards() {
    set({ loading: true, error: null });
    try {
      const boards = await listBoards();
      set({ boards });
      const preferred = preferredBoard();
      const activeBoardId =
        get().activeBoardId ??
        (boards.some((board) => board.id === preferred) ? preferred : boards[0]?.id);
      if (activeBoardId) {
        await get().openBoard(activeBoardId);
      } else {
        set({ loading: false });
      }
    } catch (error: unknown) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Could not load boards',
      });
    }
  },

  async openBoard(activeBoardId) {
    set({ loading: true, error: null, activeBoardId });
    rememberBoard(activeBoardId);
    try {
      const fetched = await fetchBoard(activeBoardId);
      // Writes still on their way to the server are missing from a fetch
      // taken mid-flight; re-apply them (client ops are absolute/idempotent)
      // or a refetch would visibly undo the user's last action.
      const pending = get().activeBoardId === activeBoardId ? (pendingOpsSource?.() ?? []) : [];
      get().applySnapshot(
        pending.length > 0 ? applyBoardOps(fetched, pending, fetched.seq) : fetched,
      );
      set({ loading: false });
    } catch (error: unknown) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Could not open board',
      });
    }
  },

  async createAndOpenBoard(name) {
    const board = await createBoard(name.trim() || 'Untitled board');
    set((state) => ({
      boards: [
        { id: board.id, name: board.name, item_count: 0, updated_at: board.updated_at },
        ...state.boards,
      ],
    }));
    await get().openBoard(board.id);
  },

  async renameBoard(boardId, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const board = await renameBoardApi(boardId, trimmed);
      set((state) => ({
        boards: state.boards.map((entry) =>
          entry.id === boardId ? { ...entry, name: board.name } : entry,
        ),
        snapshot:
          state.snapshot?.board.id === boardId
            ? { ...state.snapshot, board: { ...state.snapshot.board, name: board.name } }
            : state.snapshot,
      }));
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : 'Could not rename the board' });
    }
  },

  async deleteBoard(boardId) {
    try {
      await deleteBoardApi(boardId);
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : 'Could not delete the board' });
      return;
    }
    const boards = get().boards.filter((board) => board.id !== boardId);
    set({ boards });
    if (get().activeBoardId !== boardId) return;
    const next = boards[0]?.id ?? null;
    if (next) {
      await get().openBoard(next);
    } else {
      rememberBoard(null);
      set({ activeBoardId: null, snapshot: null, loading: false });
    }
  },

  async importBoard(file) {
    set({ busy: `Importing ${file.name}…`, error: null });
    try {
      const result = await importBoardApi(file);
      set({ boards: await listBoards() });
      await get().openBoard(result.board_id);
      return result;
    } catch (error: unknown) {
      set({
        error: `Could not import ${file.name}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      });
      return null;
    } finally {
      set({ busy: null });
    }
  },

  async ingest(files, at, camera = { zoom: 1, width: 0, height: 0 }, place) {
    const boardId = get().activeBoardId;
    if (!boardId || files.length === 0) return;
    set({ busy: `Adding ${plural(files.length, 'file')}…`, error: null });
    try {
      const response = await ingestFiles(boardId, files, at);
      // Show the files at once from what the server sent back — no board
      // refetch (a big board took seconds to come back before a drop showed).
      get().addIngested(boardId, response);
      // Size each file to the camera (natural pixels on screen, capped to
      // the view) and centre the drop on the point it landed — sizes are
      // known only now, after the server probed each file.
      if (at && response.items.length > 0) {
        const sizes = response.items.map((item) => arrivalSize(item, camera));
        const corners = arrangeDrop(sizes, at, DROP_GAP / (camera.zoom > 0 ? camera.zoom : 1));
        const ops = response.items.map((item, index) => ({
          kind: 'update' as const,
          op_id: crypto.randomUUID(),
          item_id: item.item_id,
          fields: { ...(corners[index] ?? at), ...sizes[index] },
        }));
        if (place) {
          place(ops);
        } else {
          const { seq } = await submitBatch(boardId, {
            base_seq: get().snapshot?.seq ?? response.seq,
            client_id: CLIENT_ID,
            ops,
          });
          get().applyOps(ops, seq);
        }
      }
    } catch (error: unknown) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Could not add the files',
      });
    } finally {
      set({ busy: null });
    }
  },

  addIngested(boardId, response) {
    set((state) => {
      const snapshot = state.snapshot;
      // Another board is open now (or it is still loading): its own fetch
      // brings the files.
      if (!snapshot || state.activeBoardId !== boardId) return state;
      const items = new Map(snapshot.items.map((item) => [item.id, item]));
      const blobs = new Map(snapshot.blobs.map((blob) => [blob.hash, blob]));
      for (const { item, blob } of response.items) {
        items.set(item.id, item);
        if (blob) blobs.set(blob.hash, { ...blobs.get(blob.hash), ...blob });
      }
      // Posters that finished before these items were known.
      queueMicrotask(() => {
        for (const { item } of response.items) {
          const ready = earlyPosters.get(item.id);
          if (!ready) continue;
          earlyPosters.delete(item.id);
          get().markPosterReady(item.id, ready);
        }
      });
      return {
        snapshot: {
          ...snapshot,
          items: [...items.values()],
          blobs: [...blobs.values()],
          // The ingest's own events: this client's writes, nothing to replay.
          seq: Math.max(snapshot.seq, response.seq),
        },
        boards: state.boards.map((board) =>
          board.id === boardId ? { ...board, item_count: items.size } : board,
        ),
      };
    });
  },

  async saveViewport(viewportState) {
    const boardId = get().activeBoardId;
    if (!boardId) return;
    try {
      const board = await updateBoardViewport(boardId, viewportState);
      set((state) => (state.snapshot ? { snapshot: { ...state.snapshot, board } } : state));
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : 'Could not save viewport' });
    }
  },

  async saveDrawing(noteId, strokes) {
    const boardId = get().activeBoardId;
    if (!boardId) return;
    await updateNote(boardId, noteId, { content_json: { strokes } });
    await get().openBoard(boardId);
  },

  applySnapshot(snapshot) {
    set({ snapshot });
  },

  applyOps(ops, seq) {
    set((state) => {
      const snapshot = state.snapshot;
      if (!snapshot) return state;
      // One indexed implementation for every op kind (including put_note /
      // restore_item / group ops the interactive commands now emit).
      // The seq cursor only moves forward: a late WS echo of an older batch
      // must never rewind it under a newer REST response.
      return { snapshot: applyBoardOps(snapshot, ops, Math.max(snapshot.seq, seq ?? 0)) };
    });
  },

  applyChanges(seq, events) {
    // Items this client already shows (its own ingest, placed since) keep
    // their state: replaying their create would snap them back.
    const known = new Set(get().snapshot?.items.map((item) => item.id));
    get().applyOps(
      events
        .flatMap((event) => event.ops)
        .filter((op) => !(op.kind === 'create' && known.has(op.item.id))),
      seq,
    );
  },

  markPosterReady(itemId, ready) {
    set((state) => {
      const snapshot = state.snapshot;
      if (!snapshot || ready.length === 0) return state;
      const item = snapshot.items.find((candidate) => candidate.id === itemId);
      const hash = item?.blob_hash;
      if (!hash) {
        // A poster can finish before its drop's upload response lands (the
        // first file of several): keep it for when the item arrives.
        earlyPosters.set(itemId, ready);
        return state;
      }
      let touched = false;
      const blobs = snapshot.blobs.map((blob) => {
        if (blob.hash !== hash) return blob;
        touched = true;
        const levels = { ...blob.levels };
        const native =
          levels.full ??
          (blob.width && blob.height ? { width: blob.width, height: blob.height } : null);
        for (const entry of ready) {
          // Level names (what the server sends) or legacy edge sizes.
          const name =
            typeof entry === 'string'
              ? entry
              : entry <= 64
                ? 'thumb'
                : entry <= 256
                  ? 'small'
                  : 'medium';
          const edge = LEVEL_EDGES[name];
          if (edge === undefined || name in levels) continue;
          const scale = native ? Math.min(1, edge / Math.max(native.width, native.height, 1)) : 1;
          levels[name] = native
            ? { width: Math.round(native.width * scale), height: Math.round(native.height * scale) }
            : { width: edge, height: edge };
        }
        return { ...blob, levels };
      });
      return touched ? { snapshot: { ...snapshot, blobs } } : state;
    });
  },

  createTag(name, color) {
    return createTagApi(name, color).then((tag) => {
      get().addTagLocal(tag);
      return tag;
    });
  },

  renameTag(tagId, name) {
    return updateTagApi(tagId, { name }).then((tag) => {
      get().addTagLocal(tag);
      return tag;
    });
  },

  deleteTag(tagId) {
    return deleteTagApi(tagId).then(() => {
      set((state) => {
        const snapshot = state.snapshot;
        if (!snapshot) return state;
        const tags = snapshot.tags.filter((tag) => tag.id !== tagId);
        const item_tags = Object.fromEntries(
          Object.entries(snapshot.item_tags)
            .map(([itemId, tagIds]) => [itemId, tagIds.filter((id) => id !== tagId)])
            .filter(([, tagIds]) => (tagIds as string[]).length > 0),
        );
        return { snapshot: { ...snapshot, tags, item_tags } };
      });
    });
  },

  addTagLocal(tag) {
    set((state) => {
      const snapshot = state.snapshot;
      if (!snapshot) return state;
      const exists = snapshot.tags.some((candidate) => candidate.id === tag.id);
      const tags = exists
        ? snapshot.tags.map((candidate) => (candidate.id === tag.id ? tag : candidate))
        : [...snapshot.tags, tag];
      return { snapshot: { ...snapshot, tags } };
    });
  },
}));
