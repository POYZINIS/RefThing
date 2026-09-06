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

export interface BoardSnapshot {
  board: Board;
  seq: number;
  items: Item[];
  groups: Group[];
  notes: Note[];
  tags: unknown[];
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
 * docs/api.md). `create` only ever appears in `/changes` event replays;
 * clients never send it.
 */
export type BatchOp =
  | { kind: 'move'; op_id: string; item_ids: string[]; dx: number; dy: number }
  | { kind: 'update'; op_id: string; item_id: string; fields: ItemPatch }
  | { kind: 'delete'; op_id: string; item_ids: string[] }
  | { kind: 'set_group'; op_id: string; item_ids: string[]; group_id: string | null }
  | { kind: 'set_z'; op_id: string; order: string[] }
  | { kind: 'create'; item: Item };

export type BatchRequestOp = Exclude<BatchOp, { kind: 'create' }>;

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

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new Error(message);
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
  patch: { content_json?: unknown; x?: number; y?: number; width?: number; height?: number },
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
    body: JSON.stringify({ viewport_state: viewportState }),
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
