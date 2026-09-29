import { useEffect, useRef, useState } from 'react';
import { fetchBoardsFolder, setBoardsFolder, type Tag } from '@/api/client';
import { bindings, type KeyAction } from '@/canvas/bindings';
import { chooseFolder, isDesktop } from '@/shell/desktop';
import { type ThemeMode, useAppearance, type WindowResizeMode } from '@/ui/appearance';
import { Icon } from '@/ui/Icon';
import { enter } from '@/ui/motion';

type SettingsSheetProps = {
  tags: Tag[] | null;
  onRenameTag: (tagId: string, name: string) => Promise<unknown>;
  onDeleteTag: (tagId: string) => Promise<unknown>;
  onClose: () => void;
};

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);

const KEY_LABELS: Partial<Record<KeyAction, string>> = {
  add_files: 'Add files',
  find: 'Search the board',
  bold: 'Bold notes (editing: the selection)',
  italic: 'Italic notes (editing: the selection)',
  undo: 'Undo',
  redo: 'Redo',
  select_all: 'Select all',
  group: 'Group',
  ungroup: 'Ungroup',
  delete: 'Delete selection',
  nudge_left: 'Nudge (Shift: ×10)',
  escape: 'Leave a mode / deselect',
};

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: 'Backspace',
};

/** One binding as the user types it, e.g. "Ctrl+Shift+G". */
function describeKey(action: KeyAction): string | null {
  const binding = bindings().keys[action];
  if (!binding || binding.keys.length === 0) return null;
  const modifiers = binding.modifiers.map((modifier) =>
    modifier === 'primary'
      ? isMac
        ? '⌘'
        : 'Ctrl'
      : modifier[0]?.toUpperCase() + modifier.slice(1),
  );
  const keys = [...new Set(binding.keys.map((key) => KEY_NAMES[key] ?? key.toUpperCase()))];
  const arrows = action === 'nudge_left' ? '← ↑ → ↓' : keys.join(' / ');
  return [...modifiers, arrows].join('+');
}

/**
 * Settings: appearance, tags and the shortcut reference. Changes apply
 * immediately (no Save); Escape, the close button or a press on the backdrop
 * dismisses it. Board shortcuts are suspended while it is open.
 */
export function SettingsSheet({ tags, onRenameTag, onDeleteTag, onClose }: SettingsSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const appearance = useAppearance();
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    closeButton.current?.focus();
    enter(dialog.current, 'rise');
  }, []);

  const commitRename = () => {
    if (!renaming) return;
    const tag = tags?.find((candidate) => candidate.id === renaming.id);
    const name = renaming.draft.trim();
    setRenaming(null);
    if (tag && name && name !== tag.name) void onRenameTag(tag.id, name);
  };

  const shortcuts = (Object.keys(KEY_LABELS) as KeyAction[])
    .map((action) => ({ action, label: KEY_LABELS[action], keys: describeKey(action) }))
    .filter((entry) => entry.keys);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard path (native cancel)
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A press on the backdrop (the dialog box itself, outside the panel).
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="sheet-header">
        <h2 id="settings-title">Settings</h2>
        <button
          ref={closeButton}
          className="icon-button"
          type="button"
          aria-label="Close settings"
          title="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="sheet-body">
        <section className="sheet-section" aria-labelledby="settings-appearance">
          <h3 id="settings-appearance">Appearance</h3>
          <div className="setting-row">
            <label htmlFor="settings-theme">Theme</label>
            <select
              id="settings-theme"
              className="select"
              value={appearance.theme}
              onChange={(event) => appearance.set({ theme: event.target.value as ThemeMode })}
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="settings-glass">
              {isDesktop ? 'Glass background' : 'Glass panels'}
            </label>
            <input
              id="settings-glass"
              className="switch"
              type="checkbox"
              role="switch"
              aria-checked={appearance.glass}
              checked={appearance.glass}
              onChange={(event) => appearance.set({ glass: event.target.checked })}
            />
          </div>
          {isDesktop && (
            <>
              <div className={`setting-row ${appearance.glass ? '' : 'disabled'}`}>
                <label htmlFor="settings-opacity">Background opacity</label>
                <span className="range-row">
                  <input
                    id="settings-opacity"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    disabled={!appearance.glass}
                    value={Math.round(appearance.backdropOpacity * 100)}
                    onChange={(event) =>
                      appearance.set({ backdropOpacity: Number(event.target.value) / 100 })
                    }
                  />
                  <output htmlFor="settings-opacity">
                    {Math.round(appearance.backdropOpacity * 100)}%
                  </output>
                </span>
              </div>
              <p className="setting-hint">
                How much of the desktop shows through the board. Needs Glass background.
              </p>
            </>
          )}
        </section>

        <section className="sheet-section" aria-labelledby="settings-mouse">
          <h3 id="settings-mouse">Mouse</h3>
          <div className="setting-row">
            <label htmlFor="settings-zoom-speed">Scroll zoom speed</label>
            <span className="range-row">
              <input
                id="settings-zoom-speed"
                type="range"
                min={0.25}
                max={3}
                step={0.25}
                value={appearance.zoomSpeed}
                onChange={(event) => appearance.set({ zoomSpeed: Number(event.target.value) })}
              />
              <output htmlFor="settings-zoom-speed">{appearance.zoomSpeed.toFixed(2)}×</output>
            </span>
          </div>
        </section>

        <section className="sheet-section" aria-labelledby="settings-window">
          <h3 id="settings-window">Window</h3>
          <div className="setting-row">
            <label htmlFor="settings-window-resize">Left / top edge drag</label>
            <select
              id="settings-window-resize"
              className="select"
              value={appearance.windowResize}
              onChange={(event) =>
                appearance.set({ windowResize: event.target.value as WindowResizeMode })
              }
            >
              <option value="exact">Hold the board still</option>
              <option value="smooth">Smooth, settle after</option>
            </select>
          </div>
          <p className="setting-hint">
            Either way the board ends up where it was on screen. Held still, Windows can make it
            jitter while you drag; smooth eases it along a curve through each step and settles it in
            place when you stop.
          </p>
          <div className="setting-row">
            <label htmlFor="settings-frame-cap">Frame rate</label>
            <select
              id="settings-frame-cap"
              className="select"
              value={appearance.frameCap}
              onChange={(event) => appearance.set({ frameCap: Number(event.target.value) })}
            >
              <option value={0}>Normal</option>
              <option value={10}>10 fps (testing)</option>
            </select>
          </div>
          <p className="setting-hint">
            A testing aid: at 10 fps each frame the board draws stays up long enough to see, so what
            Windows shows between them during an edge drag stands out.
          </p>
        </section>

        {isDesktop && <BoardFilesSection />}

        {tags && (
          <section className="sheet-section" aria-labelledby="settings-tags">
            <h3 id="settings-tags">Tags</h3>
            {tags.length === 0 ? (
              <p>
                No tags yet. Right-click an item and use Add Tag; tags then filter the board from
                the search bar.
              </p>
            ) : (
              <ul className="list">
                {tags.map((tag) =>
                  renaming?.id === tag.id ? (
                    <li key={tag.id} className="list-row">
                      <input
                        className="field"
                        aria-label={`Rename tag ${tag.name}`}
                        value={renaming.draft}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setRenaming({ id: tag.id, draft: event.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename();
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            setRenaming(null);
                          }
                        }}
                      />
                    </li>
                  ) : confirmDelete === tag.id ? (
                    <li key={tag.id} className="confirm-row" role="alert">
                      <p>
                        Delete the tag <strong>{tag.name}</strong>? It comes off every item that has
                        it.
                      </p>
                      <div className="confirm-actions">
                        <button
                          className="button small"
                          type="button"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep tag
                        </button>
                        <button
                          className="button small danger"
                          type="button"
                          onClick={() => {
                            setConfirmDelete(null);
                            void onDeleteTag(tag.id);
                          }}
                        >
                          Delete tag
                        </button>
                      </div>
                    </li>
                  ) : (
                    <li key={tag.id} className="list-row">
                      <span className="list-main" style={{ cursor: 'default' }}>
                        <Icon name="tag" size={15} />
                        <span className="list-label">{tag.name}</span>
                      </span>
                      <span className="list-actions">
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`Rename tag ${tag.name}`}
                          title="Rename"
                          onClick={() => setRenaming({ id: tag.id, draft: tag.name })}
                        >
                          <Icon name="pencil" size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          type="button"
                          aria-label={`Delete tag ${tag.name}`}
                          title="Delete"
                          onClick={() => setConfirmDelete(tag.id)}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        )}

        <section className="sheet-section" aria-labelledby="settings-keys">
          <h3 id="settings-keys">Keyboard</h3>
          <dl className="shortcut-list">
            {shortcuts.map((entry) => (
              <div key={entry.action} style={{ display: 'contents' }}>
                <dt>{entry.label}</dt>
                <dd>
                  <kbd>{entry.keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
          <p className="setting-hint" style={{ marginTop: 0 }}>
            Remap any key or mouse gesture with a bindings.toml in the RefThing data folder.
          </p>
        </section>
      </div>
    </dialog>
  );
}

/** Settings → Board files: where boards are kept as .ref files. */
function BoardFilesSection() {
  const [folder, setFolder] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchBoardsFolder()
      .then((result) => {
        if (alive) setFolder(result.folder);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const change = async () => {
    const picked = await chooseFolder('Keep board files in…', folder ?? undefined);
    if (!picked) return;
    setMoving(true);
    setError(null);
    try {
      setFolder((await setBoardsFolder(picked)).folder);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not use that folder');
    } finally {
      setMoving(false);
    }
  };
  return (
    <section className="sheet-section" aria-labelledby="settings-board-files">
      <h3 id="settings-board-files">Board files</h3>
      <div className="setting-row">
        <span className="setting-path" title={folder ?? undefined}>
          {/* Marks keep the path's own order inside the right-aligned ellipsis. */}
          {`\u200e${folder ?? 'Documents'}\u200e`}
        </span>
        <button className="button small" type="button" disabled={moving} onClick={change}>
          {moving ? 'Moving…' : 'Change…'}
        </button>
      </div>
      <p className="setting-hint">
        Every board is kept as a .ref file here, updated as you work — everything in it, safe if the
        PC shuts off. Changing the folder moves the files in it; a new board asks where its file
        goes.
      </p>
      {error && (
        <p className="setting-hint error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
