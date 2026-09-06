import { create } from 'zustand';
import {
  type BatchOp,
  type BoardEvent,
  type BoardSnapshot,
  type BoardSummary,
  createBoard,
  createGroup,
  createNote,
  fetchBoard,
  ingestFiles,
  listBoards,
  submitBatch,
  updateBoardViewport,
  updateNote,
} from '@/api/client';

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
  addNote: () => Promise<void>;
  saveNote: (noteId: string, content: string) => Promise<void>;
  saveDrawing: (noteId: string, strokes: Array<Array<{ x: number; y: number }>>) => Promise<void>;
  groupItems: (itemIds: string[]) => Promise<void>;
  ungroupItems: (itemIds: string[]) => Promise<void>;
  applySnapshot: (snapshot: BoardSnapshot) => void;
  applyOps: (ops: BatchOp[], seq?: number) => void;
  applyChanges: (seq: number, events: BoardEvent[]) => void;
  markPosterReady: (itemId: string, sizes: number[]) => void;
};

export const useBoardStore = create<BoardState>((set, get) => ({
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
      const snapshot = await fetchBoard(activeBoardId);
      get().applySnapshot(snapshot);
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

  async addNote() {
    const boardId = get().activeBoardId;
    if (!boardId) return;
    await createNote(boardId, {
      x: 96,
      y: 96,
      width: 280,
      height: 180,
      content_json: { text: 'New note' },
    });
    await get().openBoard(boardId);
  },

  async saveNote(noteId, content) {
    const boardId = get().activeBoardId;
    if (!boardId) return;
    await updateNote(boardId, noteId, { content_json: { text: content } });
    await get().openBoard(boardId);
  },

  async saveDrawing(noteId, strokes) {
    const boardId = get().activeBoardId;
    if (!boardId) return;
    await updateNote(boardId, noteId, { content_json: { strokes } });
    await get().openBoard(boardId);
  },

  async groupItems(itemIds) {
    const boardId = get().activeBoardId;
    const snapshot = get().snapshot;
    if (!boardId || !snapshot || itemIds.length === 0) return;
    const { group } = await createGroup(boardId, 'Reference group');
    await submitBatch(boardId, {
      base_seq: snapshot.seq,
      client_id: crypto.randomUUID(),
      ops: [
        { kind: 'set_group', op_id: crypto.randomUUID(), item_ids: itemIds, group_id: group.id },
      ],
    });
    await get().openBoard(boardId);
  },

  async ungroupItems(itemIds) {
    const boardId = get().activeBoardId;
    const snapshot = get().snapshot;
    if (!boardId || !snapshot || itemIds.length === 0) return;
    await submitBatch(boardId, {
      base_seq: snapshot.seq,
      client_id: crypto.randomUUID(),
      ops: [{ kind: 'set_group', op_id: crypto.randomUUID(), item_ids: itemIds, group_id: null }],
    });
    await get().openBoard(boardId);
  },

  applySnapshot(snapshot) {
    set({ snapshot });
  },

  applyOps(ops, seq) {
    set((state) => {
      const snapshot = state.snapshot;
      if (!snapshot) return state;
      const items = new Map(snapshot.items.map((item) => [item.id, item]));
      let itemTags = snapshot.item_tags;
      let changed = false;
      for (const op of ops) {
        switch (op.kind) {
          case 'move':
            for (const itemId of op.item_ids) {
              const item = items.get(itemId);
              if (item) {
                items.set(itemId, { ...item, x: item.x + op.dx, y: item.y + op.dy });
                changed = true;
              }
            }
            break;
          case 'update': {
            const item = items.get(op.item_id);
            if (!item) break;
            const { add_tag_ids: addedTags, remove_tag_ids: removedTags, ...fields } = op.fields;
            items.set(op.item_id, { ...item, ...fields });
            changed = true;
            if ((addedTags?.length ?? 0) > 0 || (removedTags?.length ?? 0) > 0) {
              const nextTags = new Set(itemTags[op.item_id] ?? []);
              for (const tagId of removedTags ?? []) nextTags.delete(tagId);
              for (const tagId of addedTags ?? []) nextTags.add(tagId);
              itemTags = { ...itemTags, [op.item_id]: [...nextTags] };
            }
            break;
          }
          case 'delete':
            for (const itemId of op.item_ids) {
              changed = items.delete(itemId) || changed;
            }
            break;
          case 'set_group':
            for (const itemId of op.item_ids) {
              const item = items.get(itemId);
              if (item) {
                items.set(itemId, { ...item, group_id: op.group_id });
                changed = true;
              }
            }
            break;
          case 'set_z':
            op.order.forEach((itemId, index) => {
              const item = items.get(itemId);
              if (item) {
                items.set(itemId, { ...item, z_index: index });
                changed = true;
              }
            });
            break;
          case 'create':
            items.set(op.item.id, op.item);
            changed = true;
            break;
        }
      }
      if (!changed) {
        return seq === undefined || seq === snapshot.seq
          ? state
          : { snapshot: { ...snapshot, seq } };
      }
      // Snapshot items stay in paint order (ascending z_index, stable).
      const nextItems = [...items.values()].sort((left, right) => left.z_index - right.z_index);
      return {
        snapshot: { ...snapshot, items: nextItems, item_tags: itemTags, seq: seq ?? snapshot.seq },
      };
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
}));
