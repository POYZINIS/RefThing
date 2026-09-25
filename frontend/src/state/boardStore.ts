import { create } from 'zustand';
import {
  type BatchOp,
  type BoardEvent,
  type BoardSnapshot,
  type BoardSummary,
  createBoard,
  createTag as createTagApi,
  deleteTag as deleteTagApi,
  fetchBoard,
  ingestFiles,
  listBoards,
  type Tag,
  updateBoardViewport,
  updateNote,
  updateTag as updateTagApi,
} from '@/api/client';
import { applyBoardOps } from './history';

/** Geometry patch for a note — kept for the (unwired) drawing overlay's
 *  content path. Interactive note geometry flows through `put_note` batch
 *  ops (see App.tsx commitBoardOps), not REST PATCH. */
export type NoteGeoPatch = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  z_index?: number;
};

type BoardState = {
  boards: BoardSummary[];
  activeBoardId: string | null;
  snapshot: BoardSnapshot | null;
  loading: boolean;
  error: string | null;
  loadBoards: () => Promise<void>;
  openBoard: (boardId: string) => Promise<void>;
  createAndOpenBoard: (name: string) => Promise<void>;
  ingest: (files: File[]) => Promise<void>;
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
  markPosterReady: (itemId: string, sizes: number[]) => void;
};

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
  error: null,

  async loadBoards() {
    set({ loading: true, error: null });
    try {
      const boards = await listBoards();
      set({ boards });
      const activeBoardId = get().activeBoardId ?? boards[0]?.id;
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

  async ingest(files) {
    const boardId = get().activeBoardId;
    if (!boardId || files.length === 0) return;
    set({ loading: true, error: null });
    try {
      await ingestFiles(boardId, files);
      await get().openBoard(boardId);
      set((state) => ({
        boards: state.boards.map((board) =>
          board.id === boardId
            ? { ...board, item_count: state.snapshot?.items.length ?? board.item_count }
            : board,
        ),
      }));
    } catch (error: unknown) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Could not ingest files',
      });
    }
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
    get().applyOps(
      events.flatMap((event) => event.ops),
      seq,
    );
  },

  markPosterReady(itemId, sizes) {
    set((state) => {
      const snapshot = state.snapshot;
      if (!snapshot || sizes.length === 0) return state;
      const item = snapshot.items.find((candidate) => candidate.id === itemId);
      const hash = item?.blob_hash;
      if (!hash) return state;
      let touched = false;
      const blobs = snapshot.blobs.map((blob) => {
        if (blob.hash !== hash) return blob;
        touched = true;
        const levels = { ...blob.levels };
        const full = levels.full;
        for (const size of sizes) {
          const name = size <= 64 ? 'thumb' : size <= 256 ? 'small' : 'medium';
          levels[name] = {
            width: size,
            height: full && full.width > 0 ? Math.round((size * full.height) / full.width) : size,
          };
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
