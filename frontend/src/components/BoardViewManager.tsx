import { useEffect, useState } from 'react';
import { type BoardView, createView, deleteView, listViews, renameView } from '@/api/client';

type BoardViewManagerProps = {
  boardId: string;
  currentViewport: { x: number; y: number; zoom: number };
  onApply: (viewport: { x: number; y: number; zoom: number }) => void;
};

/**
 * Phase 6 saved views: named viewport bookmarks. "Save current" captures the
 * live canvas viewport; clicking a view re-applies it. Pure React chrome —
 * the canvas only receives viewport commands through `onApply`.
 */
export default function BoardViewManager({
  boardId,
  currentViewport,
  onApply,
}: BoardViewManagerProps) {
  const [views, setViews] = useState<BoardView[]>([]);
  const [draft, setDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void listViews(boardId)
      .then((result) => {
        if (!cancelled) setViews(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load views');
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    const { x, y, zoom } = currentViewport;
    void createView(boardId, name, { x, y, zoom })
      .then((view) => {
        setViews((previous) => [...previous, view]);
        setDraft('');
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not save view'),
      );
  };

  const submitRename = (view: BoardView, event: React.FormEvent) => {
    event.preventDefault();
    const name = renameDraft.trim();
    if (!name) return;
    void renameView(boardId, view.id, name)
      .then((renamed) => {
        setViews((previous) =>
          previous.map((candidate) => (candidate.id === renamed.id ? renamed : candidate)),
        );
        setRenamingId(null);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not rename view'),
      );
  };

  const remove = (viewId: string) => {
    void deleteView(boardId, viewId)
      .then(() => setViews((previous) => previous.filter((view) => view.id !== viewId)))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not delete view'),
      );
  };

  return (
    <div className="view-manager">
      <div className="sidebar-heading view-manager-heading">
        <span>Views</span>
        <span className="count-badge">{views.length}</span>
      </div>
      <form className="new-view-form" onSubmit={submitCreate}>
        <input
          aria-label="New view name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Save current view…"
        />
        <button type="submit" aria-label="Save current view">
          +
        </button>
      </form>
      {error && <div className="view-error">{error}</div>}
      <ul className="view-list">
        {views.map((view) => {
          if (renamingId === view.id) {
            return (
              <li key={view.id} className="view-row">
                <form className="rename-view-form" onSubmit={(event) => submitRename(view, event)}>
                  <input
                    aria-label={`Rename view ${view.name}`}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                  />
                </form>
              </li>
            );
          }
          return (
            <li key={view.id} className="view-row">
              <button
                className="view-chip"
                type="button"
                onClick={() => onApply(asViewport(view.viewport))}
              >
                <span className="view-glyph">⌖</span>
                {view.name}
              </button>
              <button
                className="view-action"
                type="button"
                aria-label={`Rename ${view.name}`}
                onClick={() => {
                  setRenameDraft(view.name);
                  setRenamingId(view.id);
                }}
              >
                ✎
              </button>
              <button
                className="view-action view-delete"
                type="button"
                aria-label={`Delete ${view.name}`}
                onClick={() => remove(view.id)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Defensive parse of the viewport wire shape (mirrors `asViewport`). */
function asViewport(value: unknown): { x: number; y: number; zoom: number } {
  if (typeof value !== 'object' || value === null) return { x: 0, y: 0, zoom: 1 };
  const candidate = value as Record<string, unknown>;
  return {
    x: typeof candidate.x === 'number' ? candidate.x : 0,
    y: typeof candidate.y === 'number' ? candidate.y : 0,
    zoom: typeof candidate.zoom === 'number' ? candidate.zoom : 1,
  };
}
