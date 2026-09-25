import { BoardSocket, type BoardSocketEvent, fetchChanges } from '@/api/client';
import { useBoardStore } from '@/state/boardStore';

/** `levels` are level names (what the server sends); `sizes` is the older
 *  documented shape, still accepted. */
type PosterReadyPayload = { item_id?: string; levels?: string[]; sizes?: number[] };

export type BoardSyncOptions = {
  boardId: string;
  clientId: string;
  /** Called when a pyramid job finished so the canvas can retry higher levels. */
  onPosterReady?: () => void;
};

/**
 * Owns the board WebSocket and keeps the board store in sync with the live
 * diff stream (docs/api.md → WebSocket):
 * - `hello` / empty-op `diff` → catch up via `GET /changes?since=`.
 * - `diff` from another client → apply its ops incrementally.
 * - `diff` from ourselves (echo) → only advance the seq cursor; the ops were
 *   already applied optimistically on send.
 * - `resync` → the only path that triggers a full board refetch.
 *
 * Receive-only: this client's own writes go through BatchQueue (REST), which
 * orders them against the seq contract.
 */
export class BoardSync {
  private readonly clientId: string;
  private readonly onPosterReady?: () => void;
  private readonly socket: BoardSocket;
  private catchingUp = false;

  constructor(options: BoardSyncOptions) {
    this.clientId = options.clientId;
    this.onPosterReady = options.onPosterReady;
    const since = useBoardStore.getState().snapshot?.seq ?? 0;
    this.socket = new BoardSocket(options.boardId, since, options.clientId, (event) => {
      void this.handle(event);
    });
  }

  close(): void {
    this.socket.close();
  }

  private async handle(event: BoardSocketEvent): Promise<void> {
    const store = useBoardStore.getState();
    switch (event.type) {
      case 'hello':
        if (event.seq > (store.snapshot?.seq ?? 0)) await this.catchUp();
        break;
      case 'diff': {
        const currentSeq = store.snapshot?.seq ?? 0;
        if (event.origin === this.clientId) {
          store.applyOps([], event.seq);
          break;
        }
        if (event.seq <= currentSeq) break;
        if (event.ops.length > 0) {
          store.applyOps(event.ops, event.seq);
        } else {
          // Creates and board/group/note mutations have no BatchOp shape.
          await this.catchUp();
        }
        break;
      }
      case 'resync': {
        const boardId = store.activeBoardId;
        if (boardId) await store.openBoard(boardId);
        break;
      }
      case 'job': {
        if (event.kind === 'poster_ready') {
          const payload = (event.payload ?? {}) as PosterReadyPayload;
          if (typeof payload.item_id === 'string') {
            store.markPosterReady(
              payload.item_id,
              Array.isArray(payload.levels)
                ? payload.levels
                : Array.isArray(payload.sizes)
                  ? payload.sizes
                  : [],
            );
          }
          this.onPosterReady?.();
        }
        break;
      }
      case 'error': {
        // A rejected frame (e.g. stale base_seq) means our optimistic state
        // may have diverged; the REST snapshot is authoritative.
        const boardId = store.activeBoardId;
        if (boardId) await store.openBoard(boardId);
        break;
      }
    }
  }

  private async catchUp(): Promise<void> {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = useBoardStore.getState();
        const boardId = state.activeBoardId;
        if (!boardId) return;
        const since = state.snapshot?.seq ?? 0;
        let seq: number;
        let events: Awaited<ReturnType<typeof fetchChanges>>['events'];
        try {
          ({ seq, events } = await fetchChanges(boardId, since));
        } catch {
          break;
        }
        const current = useBoardStore.getState();
        if (current.activeBoardId !== boardId) return;
        if ((current.snapshot?.seq ?? 0) !== since) continue; // raced; retry fresh
        // Our own op-less events (viewport saves) need nothing; anyone else's
        // (creates, note/group edits) can only be reconciled by a refetch.
        if (events.some((event) => event.ops.length === 0 && event.origin !== this.clientId)) {
          break;
        }
        current.applyChanges(seq, events);
        return;
      }
      const state = useBoardStore.getState();
      const boardId = state.activeBoardId;
      if (boardId) await state.openBoard(boardId);
    } finally {
      this.catchingUp = false;
    }
  }
}
