import { useRef, useState } from 'react';
import { type BoardFileStatus, type BoardSummary, boardDownloadUrl } from '@/api/client';
import { Icon } from '@/ui/Icon';
import { Popover } from '@/ui/Popover';

type BoardSwitcherProps = {
  boards: BoardSummary[];
  activeBoardId: string | null;
  /** Live count for the open board (the list's count is from load time). */
  activeItemCount: number | null;
  onOpen: (boardId: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (boardId: string, name: string) => Promise<void>;
  onDelete: (boardId: string) => Promise<void>;
  onSnapshots: () => void;
  /** The open board's `.ref` file, when it's kept in one (desktop). */
  file: BoardFileStatus | null;
  /** The desktop keeps boards in files; the browser downloads them. */
  canKeepFiles: boolean;
  onOpenFile: () => void;
  onSaveToFile: () => void;
};

/** "C:\\Boards\\Moodboard.ref" → "Moodboard.ref". */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const itemsLabel = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;

/**
 * The board you're on, and the way to every other one. The name sits in the
 * top-left group; the list, a new-board field and per-board rename / delete
 * open beneath it on demand — nothing about boards stays on screen.
 */
export function BoardSwitcher({
  boards,
  activeBoardId,
  activeItemCount,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onSnapshots,
  file,
  canKeepFiles,
  onOpenFile,
  onSaveToFile,
}: BoardSwitcherProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const active = boards.find((board) => board.id === activeBoardId) ?? null;

  const close = () => {
    setOpen(false);
    setRenaming(null);
    setConfirmDelete(null);
  };
  const countOf = (board: BoardSummary) =>
    board.id === activeBoardId && activeItemCount !== null ? activeItemCount : board.item_count;

  const commitRename = () => {
    if (!renaming) return;
    const board = boards.find((candidate) => candidate.id === renaming.id);
    const name = renaming.draft.trim();
    setRenaming(null);
    if (board && name && name !== board.name) void onRename(board.id, name);
  };

  return (
    <>
      <button
        ref={anchor}
        className="board-switch"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={active ? `Boards: ${active.name}` : 'Boards'}
        title="Boards"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="boards" />
        <span className="board-switch-name">{active?.name ?? 'Boards'}</span>
        <span className="board-switch-chevron">
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      {open && (
        <Popover anchor={anchor} onClose={close} label="Boards" className="board-popover">
          <div className="popover-heading">
            <span>Boards</span>
            <span className="count">{boards.length}</span>
          </div>
          <div className="popover-scroll">
            {boards.length === 0 ? (
              <p className="popover-empty">No boards yet. Name one below to start.</p>
            ) : (
              <ul className="list">
                {boards.map((board) =>
                  renaming?.id === board.id ? (
                    <li key={board.id} className="list-row">
                      <input
                        className="field"
                        aria-label={`Rename ${board.name}`}
                        data-own-escape
                        value={renaming.draft}
                        // biome-ignore lint/a11y/noAutofocus: the rename was just requested
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) =>
                          setRenaming({ id: board.id, draft: event.target.value })
                        }
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename();
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setRenaming(null);
                          }
                        }}
                      />
                    </li>
                  ) : confirmDelete === board.id ? (
                    <li key={board.id} className="confirm-row" role="alert">
                      <p>
                        Delete <strong>{board.name}</strong> and its {itemsLabel(countOf(board))}?
                        This can’t be undone.
                      </p>
                      <div className="confirm-actions">
                        <button
                          className="button small"
                          type="button"
                          // biome-ignore lint/a11y/noAutofocus: safe default for a destructive prompt
                          autoFocus
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep board
                        </button>
                        <button
                          className="button small danger"
                          type="button"
                          onClick={() => {
                            setConfirmDelete(null);
                            void onDelete(board.id);
                          }}
                        >
                          Delete board
                        </button>
                      </div>
                    </li>
                  ) : (
                    <li
                      key={board.id}
                      className={`list-row board-row ${board.id === activeBoardId ? 'selected' : ''}`}
                    >
                      <button
                        className="list-main"
                        type="button"
                        aria-current={board.id === activeBoardId ? 'true' : undefined}
                        onClick={() => {
                          close();
                          if (board.id !== activeBoardId) onOpen(board.id);
                        }}
                      >
                        <span className="list-marker" />
                        <span className="list-label">{board.name}</span>
                        <span className="list-meta">{countOf(board)}</span>
                      </button>
                      <span className="list-actions">
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`Rename ${board.name}`}
                          title="Rename"
                          onClick={() => setRenaming({ id: board.id, draft: board.name })}
                        >
                          <Icon name="pencil" size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          type="button"
                          aria-label={`Delete ${board.name}`}
                          title="Delete"
                          onClick={() => setConfirmDelete(board.id)}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              setCreating(true);
              void onCreate(newName)
                .then(() => {
                  setNewName('');
                  close();
                })
                .finally(() => setCreating(false));
            }}
          >
            <input
              className="field"
              aria-label="New board name"
              placeholder="New board name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button className="button primary" type="submit" disabled={creating}>
              Create
            </button>
          </form>
          {activeBoardId && file && (
            <div
              className={`board-file-status${file.error ? ' failed' : ''}`}
              title={file.error ?? file.path}
              role="status"
            >
              <Icon name={file.error ? 'alert' : 'check'} size={14} />
              <span>
                {file.error
                  ? `Couldn’t write ${fileName(file.path)} — retrying`
                  : file.saved
                    ? `Saved in ${fileName(file.path)}`
                    : `Saving to ${fileName(file.path)}…`}
              </span>
            </div>
          )}
          <div className="popover-footer board-file-actions">
            <button
              className="text-action"
              type="button"
              onClick={() => {
                close();
                onOpenFile();
              }}
            >
              <Icon name="openFile" size={16} />
              Open board file…
            </button>
            {activeBoardId &&
              (canKeepFiles ? (
                <button
                  className="text-action"
                  type="button"
                  onClick={() => {
                    close();
                    onSaveToFile();
                  }}
                >
                  <Icon name="saveFile" size={16} />
                  {file ? 'Move file…' : 'Save as .ref file…'}
                </button>
              ) : (
                <a className="text-action" href={boardDownloadUrl(activeBoardId)} download>
                  <Icon name="saveFile" size={16} />
                  Download .ref
                </a>
              ))}
            {activeBoardId && (
              <button
                className="text-action"
                type="button"
                onClick={() => {
                  close();
                  onSnapshots();
                }}
              >
                <Icon name="history" size={16} />
                Snapshots…
              </button>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
