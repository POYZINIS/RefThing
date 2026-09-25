import { CLIENT_ID } from '@/api/clientId';
export interface HealthStatus {
  status: string;
  version: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  item_count: number;
  updated_at: number;
}

export interface Board {
  id: string;
  name: string;
  seq: number;
  viewport_state: unknown;
  created_at: number;
  updated_at: number;
}

export interface Item {
  id: string;
  board_id: string;
  type: string;
  blob_hash: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z_index: number;
  group_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface Note {
  id: string;
  board_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z_index: number;
  content_json: unknown;
  bg_color: string | null;
  opacity: number;
  created_at: number;
  updated_at: number;
}

export interface Group {
  id: string;
  board_id: string;
  parent_group_id: string | null;
  name: string;
  collapsed: boolean;
  bg_color: string | null;
  opacity: number;
  created_at: number;
  /** §6 RULE 3: no group-level transforms while locked. */
  locked: boolean;
}

export interface BlobInfo {
  hash: string;
  original_filename: string | null;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  created_at: number;
  levels: Record<string, { width: number; height: number }>;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export interface BoardView {
  id: string;
  board_id: string;
  name: string;
  viewport: unknown;
  created_at: number;
  updated_at: number;
}

export interface BoardSnapshot {
  board: Board;
  seq: number;
  items: Item[];
  groups: Group[];
  notes: Note[];
  tags: Tag[];
  item_tags: Record<string, string[]>;
  blobs: BlobInfo[];
}

export interface IngestResponse {
  seq: number;
  items: Array<{
    item_id: string;
    blob_hash: string;
    mime_type: string;
    width: number;
    height: number;
    dedup: boolean;
    poster: string;
  }>;
}

export type ItemPatch = Partial<
  Pick<Item, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'z_index' | 'group_id' | 'metadata'>
> & {
  add_tag_ids?: string[];
  remove_tag_ids?: string[];
};

/**
 * Server-side batch op variants (`kind` is the serde tag, snake_case — see
 * docs/api.md). Variants with `op_id` are the batch protocol
 * (`POST .../items/batch` and client→server WS); the rest only ever appear in
 * `/changes` event replays / WS diffs — clients never send them.
 */
export type BatchOp =
  | { kind: 'move'; op_id: string; item_ids: string[]; dx: number; dy: number }
  | { kind: 'update'; op_id: string; item_id: string; fields: ItemPatch }
  | { kind: 'delete'; op_id: string; item_ids: string[] }
  | { kind: 'set_group'; op_id: string; item_ids: string[]; group_id: string | null }
  | { kind: 'set_z'; op_id: string; order: string[] }
  | { kind: 'restore_item'; op_id: string; item: Item; tag_ids: string[] }
  | { kind: 'put_note'; op_id: string; note: Note }
  | { kind: 'delete_notes'; op_id: string; note_ids: string[] }
  | { kind: 'restore_group'; op_id: string; group: Group }
  | { kind: 'remove_group'; op_id: string; group_id: string }
  | { kind: 'set_group_locked'; op_id: string; group_id: string; locked: boolean }
  | {
      kind: 'set_group_style';
      op_id: string;
      group_id: string;
      bg_color: string | null;
      opacity: number;
    }
  | { kind: 'create'; item: Item }
  | { kind: 'create_note'; note: Note }
  | { kind: 'update_note'; note: Note }
  | { kind: 'delete_note'; id: string }
  | { kind: 'create_group'; group: Group }
  | { kind: 'update_group'; group: Group }
  | { kind: 'delete_group'; id: string };

/** Ops a client may send in a batch — exactly the ones carrying `op_id`. */
export type BatchRequestOp = Extract<BatchOp, { op_id: string }>;

export interface BatchRequest {
  base_seq: number;
  client_id: string;
  ops: BatchRequestOp[];
}

export interface BoardEvent {
  seq: number;
  origin: string | null;
  ops: BatchOp[];
  created_at: number;
}

export interface ChangesResponse {
  seq: number;
  events: BoardEvent[];
}

/** A non-2xx API response: HTTP status plus the error envelope's `code`
 *  (docs/api.md → Error envelope), e.g. `seq_conflict`. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code: string | null = null;
    try {
      const body = (await response.json()) as { error?: { message?: string; code?: string } };
      message = body.error?.message ?? message;
      code = body.error?.code ?? null;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function fetchHealth(): Promise<HealthStatus> {
  return request<HealthStatus>('/api/health');
}

export function createSession(): Promise<{ user_id: string; token: string }> {
  return request<{ user_id: string; token: string }>('/api/auth/session', { method: 'POST' });
}

export function listBoards(): Promise<BoardSummary[]> {
  return request<BoardSummary[]>('/api/boards');
}

/** List all tags (global, not board-scoped). */
export function listTags(): Promise<Tag[]> {
  return request<Tag[]>('/api/tags');
}

export function createTag(name: string, color?: string | null): Promise<Tag> {
  return request<Tag>('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color: color ?? null }),
  });
}

export function updateTag(
  tagId: string,
  patch: { name?: string; color?: string | null },
): Promise<Tag> {
  return request<Tag>(`/api/tags/${tagId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function deleteTag(tagId: string): Promise<void> {
  return request<void>(`/api/tags/${tagId}`, { method: 'DELETE' });
}

/** List saved views for a board (Phase 6). */
export function listViews(boardId: string): Promise<BoardView[]> {
  return request<BoardView[]>(`/api/boards/${boardId}/views`);
}

export function createView(boardId: string, name: string, viewport: unknown): Promise<BoardView> {
  return request<BoardView>(`/api/boards/${boardId}/views`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, viewport }),
  });
}

export function renameView(boardId: string, viewId: string, name: string): Promise<BoardView> {
  return request<BoardView>(`/api/boards/${boardId}/views/${viewId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteView(boardId: string, viewId: string): Promise<void> {
  return request<void>(`/api/boards/${boardId}/views/${viewId}`, { method: 'DELETE' });
}

/** A single FTS5 full-text search result (Phase 6). */
export interface SearchResult {
  item_id: string;
  rank: number;
  snippet: string;
  kind: 'filename' | 'note' | 'tag' | 'colour' | 'duplicate';
}

/** Full-text search a board (Phase 6 FTS5). */
export function searchBoard(boardId: string, query: string): Promise<SearchResult[]> {
  return request<SearchResult[]>(`/api/boards/${boardId}/search?q=${encodeURIComponent(query)}`);
}

/** Colour search — find items with matching dominant colour (Phase 6). */
export function searchColour(boardId: string, hex: string): Promise<SearchResult[]> {
  return request<SearchResult[]>(
    `/api/boards/${boardId}/search-colour?colour=${encodeURIComponent(hex)}`,
  );
}

/** Find perceptual-hash duplicates on a board (Phase 6). */
export function findDuplicates(boardId: string): Promise<SearchResult[]> {
  return request<SearchResult[]>(`/api/boards/${boardId}/duplicates`);
}

export function createBoard(name: string): Promise<Board> {
  return request<Board>('/api/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function fetchBoard(boardId: string): Promise<BoardSnapshot> {
  return request<BoardSnapshot>(`/api/boards/${boardId}`);
}

export function createNote(
  boardId: string,
  note: { x: number; y: number; width: number; height: number; content_json: unknown },
): Promise<{ note: Note }> {
  return request<{ note: Note }>(`/api/boards/${boardId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note),
  });
}

export function createGroup(boardId: string, name: string): Promise<{ group: Group }> {
  return request<{ group: Group }>(`/api/boards/${boardId}/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function updateNote(
  boardId: string,
  noteId: string,
  patch: {
    content_json?: unknown;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotation?: number;
    z_index?: number;
  },
): Promise<{ note: Note }> {
  return request<{ note: Note }>(`/api/boards/${boardId}/notes/${noteId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function noteContent(note: Note): {
  text?: string;
  strokes?: Array<Array<{ x: number; y: number }>>;
} {
  return typeof note.content_json === 'object' && note.content_json !== null
    ? (note.content_json as { text?: string; strokes?: Array<Array<{ x: number; y: number }>> })
    : {};
}

export function updateBoardViewport(boardId: string, viewportState: unknown): Promise<Board> {
  return request<{ board: Board }>(`/api/boards/${boardId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    // client_id: our own echo on the WebSocket is recognised, not refetched.
    body: JSON.stringify({ viewport_state: viewportState, client_id: CLIENT_ID }),
  }).then((result) => result.board);
}

export async function ingestFiles(boardId: string, files: File[]): Promise<IngestResponse> {
  const form = new FormData();
  for (const file of files) {
    form.append('files', file, file.name);
  }
  return request<IngestResponse>(`/api/boards/${boardId}/items:ingest`, {
    method: 'POST',
    body: form,
  });
}

export function blobUrl(hash: string, level = 'full'): string {
  return `/blob/${hash}/${level}`;
}

export function submitBatch(boardId: string, requestBody: BatchRequest): Promise<{ seq: number }> {
  return request<{ seq: number }>(`/api/boards/${boardId}/items/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

export function fetchChanges(boardId: string, since: number): Promise<ChangesResponse> {
  return request<ChangesResponse>(`/api/boards/${boardId}/changes?since=${since}`);
}

export type BoardSocketEvent =
  | { type: 'hello'; board_id: string; seq: number; server_time: number }
  | { type: 'diff'; board_id: string; seq: number; origin: string | null; ops: BatchOp[] }
  | { type: 'resync'; seq: number }
  | { type: 'job'; kind: string; payload: unknown }
  | { type: 'error'; code: string; message: string };

export class BoardSocket {
  private readonly socket: WebSocket;

  constructor(
    boardId: string,
    since: number,
    clientId: string,
    private readonly onEvent: (event: BoardSocketEvent) => void,
  ) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(
      `${protocol}//${window.location.host}/api/boards/${boardId}/ws?client_id=${clientId}&since=${since}`,
    );
    this.socket.addEventListener('message', (message) => {
      try {
        this.onEvent(JSON.parse(message.data as string) as BoardSocketEvent);
      } catch {
        // Ignore malformed server frames; the REST snapshot remains authoritative.
      }
    });
  }

  send(requestBody: BatchRequest): boolean {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(requestBody));
      return true;
    }
    return false;
  }

  close(): void {
    this.socket.close();
  }
}
