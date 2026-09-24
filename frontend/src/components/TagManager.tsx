import { useState } from 'react';
import type { Tag } from '@/api/client';

type TagManagerProps = {
  tags: Tag[];
  selectedItemTags: Set<string>;
  onCreate: (name: string) => Promise<void>;
  onRename: (tagId: string, name: string) => Promise<void>;
  onDelete: (tagId: string) => Promise<void>;
  onToggle: (tagId: string) => void;
};

/**
 * Phase 6 tag management: create/rename/delete tags, and toggle assignment of
 * tags to the currently selected item.
 */
export default function TagManager({
  tags,
  selectedItemTags,
  onCreate,
  onRename,
  onDelete,
  onToggle,
}: TagManagerProps) {
  const [draft, setDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    void onCreate(name);
    setDraft('');
  };

  const submitRename = (tag: Tag, event: React.FormEvent) => {
    event.preventDefault();
    const name = renameDraft.trim();
    if (!name) return;
    void onRename(tag.id, name);
    setRenamingId(null);
  };

  return (
    <div className="tag-manager">
      <div className="sidebar-heading tag-manager-heading">
        <span>Tags</span>
        <span className="count-badge">{tags.length}</span>
      </div>
      <form className="new-tag-form" onSubmit={submitCreate}>
        <input
          aria-label="New tag name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New tag…"
        />
        <button type="submit" aria-label="Create tag">
          +
        </button>
      </form>
      <ul className="tag-list">
        {tags.map((tag) => {
          const selected = selectedItemTags.has(tag.id);
          if (renamingId === tag.id) {
            return (
              <li key={tag.id} className="tag-row">
                <form className="rename-tag-form" onSubmit={(event) => submitRename(tag, event)}>
                  <input
                    aria-label={`Rename tag ${tag.name}`}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                  />
                </form>
              </li>
            );
          }
          return (
            <li key={tag.id} className="tag-row">
              <button
                className={`tag-chip ${selected ? 'selected' : ''}`}
                type="button"
                aria-pressed={selected}
                onClick={() => onToggle(tag.id)}
              >
                <span
                  className="tag-dot"
                  style={tag.color ? { background: tag.color } : undefined}
                />
                {tag.name}
              </button>
              <button
                className="tag-action"
                type="button"
                aria-label={`Rename ${tag.name}`}
                onClick={() => {
                  setRenameDraft(tag.name);
                  setRenamingId(tag.id);
                }}
              >
                ✎
              </button>
              <button
                className="tag-action tag-delete"
                type="button"
                aria-label={`Delete ${tag.name}`}
                onClick={() => void onDelete(tag.id)}
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
