/**
 * This tab's writer identity. Every write that can echo back over the board
 * WebSocket (batches, viewport saves) carries it, so the echo is recognised
 * as our own instead of triggering a refetch.
 */
export const CLIENT_ID: string = crypto.randomUUID();
