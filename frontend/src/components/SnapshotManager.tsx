import { useEffect, useRef, useState } from 'react';
import {
  captureSnapshot,
  listSnapshots,
  restoreSnapshot,
  type SavedSnapshot,
} from '@/api/snapshots';

export function SnapshotManager({
  boardId,
  onClose,
  onRestored,
}: {
  boardId: string;
  onClose: () => void;
  onRestored: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshots, setSnapshots] = useState<SavedSnapshot[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    let current = true;
    void listSnapshots(boardId)
      .then((rows) => {
        if (current) setSnapshots(rows);
      })
      .catch((error: unknown) => {
        if (current) setError(error instanceof Error ? error.message : 'Could not load snapshots');
      });
    return () => {
      current = false;
    };
  }, [boardId]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSnapshots(await listSnapshots(boardId));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not update snapshots');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="snapshot-dialog"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      aria-labelledby="snapshots-title"
    >
      <h2 id="snapshots-title">Board snapshots</h2>
      <p>Save a version before making changes. The 10 most recent versions are kept.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await captureSnapshot(boardId, label.trim());
            setLabel('');
          });
        }}
      >
        <input
          aria-label="Snapshot name"
          placeholder="Version name (optional)"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          Save snapshot
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {snapshots.length === 0 && <p>No saved snapshots yet.</p>}
      <ul>
        {snapshots.map((snapshot) => (
          <li key={snapshot.created_at}>
            <span>
              {snapshot.label || 'Untitled snapshot'}
              <small>{new Date(snapshot.created_at).toLocaleString()}</small>
            </span>
            {confirm === snapshot.created_at ? (
              <span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      // Capture a recovery point before replacing the current board.
                      await captureSnapshot(boardId, 'Before restore');
                      await restoreSnapshot(boardId, snapshot.created_at);
                      await onRestored();
                      setConfirm(null);
                    })
                  }
                >
                  Replace current board
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" disabled={busy} onClick={() => setConfirm(snapshot.created_at)}>
                Restore
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" disabled={busy} onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
