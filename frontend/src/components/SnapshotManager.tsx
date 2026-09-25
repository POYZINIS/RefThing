import { useEffect, useRef, useState } from 'react';
import {
  captureSnapshot,
  listSnapshots,
  restoreSnapshot,
  type SavedSnapshot,
} from '@/api/snapshots';
import { Icon } from '@/ui/Icon';
import { enter } from '@/ui/motion';

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
  const closeButton = useRef<HTMLButtonElement>(null);
  const [snapshots, setSnapshots] = useState<SavedSnapshot[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    closeButton.current?.focus();
    enter(dialog.current, 'rise');
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard path (native cancel)
    <dialog
      ref={dialog}
      className="sheet"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !busy) onClose();
      }}
      aria-labelledby="snapshots-title"
    >
      <div className="sheet-header">
        <h2 id="snapshots-title">Snapshots</h2>
        <button
          ref={closeButton}
          className="icon-button"
          type="button"
          aria-label="Close snapshots"
          title="Close"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="sheet-body">
        <p>
          Save a version of this board before a big change. The 10 most recent are kept, and
          restoring saves the current state first.
        </p>
        <form
          className="inline-form"
          style={{ padding: 0 }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await captureSnapshot(boardId, label.trim());
              setLabel('');
            });
          }}
        >
          <input
            className="field"
            aria-label="Snapshot name"
            placeholder="Version name (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            disabled={busy}
          />
          <button className="button primary" type="submit" disabled={busy}>
            Save snapshot
          </button>
        </form>
        {error && (
          <div className="sheet-error" role="alert">
            {error}
          </div>
        )}
        {snapshots.length === 0 ? (
          <p>No snapshots of this board yet.</p>
        ) : (
          <ul className="snapshot-list">
            {snapshots.map((snapshot) => (
              <li key={snapshot.created_at} className="snapshot-row">
                <span style={{ minWidth: 0 }}>
                  <strong>{snapshot.label || 'Untitled snapshot'}</strong>
                  <small>{new Date(snapshot.created_at).toLocaleString()}</small>
                </span>
                {confirm === snapshot.created_at ? (
                  <span className="confirm-actions">
                    <button
                      className="button small"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="button small danger"
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
                      Replace board
                    </button>
                  </span>
                ) : (
                  <button
                    className="button small"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirm(snapshot.created_at)}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
