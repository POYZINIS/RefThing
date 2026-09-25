import { ApiError, type BatchRequestOp, submitBatch } from '@/api/client';

/** Rebase attempts before a conflicting batch is given up. */
const MAX_REBASES = 3;

import { useBoardStore } from '@/state/boardStore';

/**
 * Serializes this client's board writes: ONE batch in flight at a time, each
 * sent with the board's seq as of the moment the previous batch landed.
 *
 * The server requires `base_seq` to equal the board's current seq (docs/api.md
 * → Seq contract). Firing a second batch before the first returned reused the
 * same stale base_seq, so the server rejected it and the client refetched —
 * silently dropping e.g. a note edit that committed right after the
 * select-to-front of another node. Callers still apply ops optimistically;
 * this only orders delivery.
 *
 * Writes go over REST because its response carries the new seq even when
 * every op was rejected (no diff is broadcast then, so a WebSocket echo would
 * never arrive). The socket stays the receive path for other clients' diffs.
 */
export class BatchQueue {
  private pending: BatchRequestOp[] = [];
  /** The batch currently on the wire (not yet acknowledged). */
  private sending: BatchRequestOp[] = [];
  private inFlight = false;

  constructor(
    private readonly boardId: string,
    private readonly clientId: string,
  ) {
    useBoardStore.getState().setPendingOpsSource(() => this.unacknowledged());
  }

  dispose(): void {
    useBoardStore.getState().setPendingOpsSource(null);
  }

  /** Optimistic ops the server hasn't confirmed yet: a refetch re-applies
   *  them so a snapshot fetched mid-flight can't erase them from view. */
  unacknowledged(): BatchRequestOp[] {
    return [...this.sending, ...this.pending];
  }

  submit(ops: BatchRequestOp[]): void {
    if (ops.length === 0) return;
    this.pending.push(...ops);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      let rebases = 0;
      while (this.pending.length > 0) {
        const store = useBoardStore.getState();
        if (store.activeBoardId !== this.boardId || !store.snapshot) {
          this.pending = [];
          return;
        }
        // Everything queued meanwhile rides in one request, in order.
        const ops = this.pending;
        this.pending = [];
        this.sending = ops;
        try {
          const { seq } = await submitBatch(this.boardId, {
            base_seq: store.snapshot.seq,
            client_id: this.clientId,
            ops,
          });
          this.sending = [];
          rebases = 0;
          useBoardStore.getState().applyOps([], seq);
        } catch (error) {
          this.sending = [];
          const conflict = error instanceof ApiError && error.code === 'seq_conflict';
          if (conflict && rebases < MAX_REBASES) {
            // Another writer moved the board first (docs/api.md: refetch and
            // rebase). Our ops are absolute, so they re-apply cleanly on top
            // of the fresh state: keep them pending, resync, and resend.
            rebases += 1;
            this.pending = [...ops, ...this.pending];
            await useBoardStore.getState().openBoard(this.boardId);
            continue;
          }
          // Invalid ops (or a conflict that won't settle): the REST snapshot
          // is authoritative.
          this.pending = [];
          await useBoardStore.getState().openBoard(this.boardId);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}
