export type SavedSnapshot = { board_id: string; created_at: number; label: string };

async function snapshotRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? 'Could not update snapshots');
  return body as T;
}

export function listSnapshots(boardId: string): Promise<SavedSnapshot[]> {
  return snapshotRequest(`/api/boards/${boardId}/snapshots`);
}

export function captureSnapshot(boardId: string, label: string): Promise<SavedSnapshot> {
  return snapshotRequest(`/api/boards/${boardId}/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
}

export function restoreSnapshot(boardId: string, createdAt: number): Promise<{ seq: number }> {
  return snapshotRequest(`/api/boards/${boardId}/snapshots/${createdAt}/restore`, {
    method: 'POST',
  });
}
