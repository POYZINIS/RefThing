import { create } from 'zustand';
import {
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
      set({ snapshot, loading: false });
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
}));
