import { useMemo, useState } from 'react';
import type { Tag } from '@/api/client';

export type FilterState = {
  text: string;
  tagIds: Set<string>;
};

export const emptyFilter: FilterState = { text: '', tagIds: new Set() };

export function filterIsEmpty(filter: FilterState): boolean {
  return filter.text.trim() === '' && filter.tagIds.size === 0;
}

type SearchBarProps = {
  tags: Tag[];
  filter: FilterState;
  onChange: (filter: FilterState) => void;
};

/**
 * Phase 6 organization chrome: text search + tag filter chips for the board.
 * Pure React UI (React owns the chrome); the canvas consumes the derived,
 * filtered item list.
 */
export default function SearchBar({ tags, filter, onChange }: SearchBarProps) {
  const [draft, setDraft] = useState(filter.text);

  const visibleTags = useMemo(
    () => tags.filter((tag) => tag.name.toLowerCase().includes(draft.trim().toLowerCase())),
    [tags, draft],
  );

  const toggleTag = (tagId: string) => {
    const next = new Set(filter.tagIds);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    onChange({ ...filter, tagIds: next });
  };

  const commitText = (text: string) => {
    setDraft(text);
    onChange({ ...filter, text });
  };

  const active = filter.tagIds.size > 0 || filter.text.trim() !== '';

  return (
    <div className={`search-filter ${active ? 'active' : ''}`}>
      <input
        className="search-input"
        aria-label="Search board items"
        placeholder="Search items, tags, notes…"
        value={draft}
        onChange={(event) => commitText(event.target.value)}
      />
      {active && (
        <button
          className="search-clear"
          type="button"
          aria-label="Clear search and filters"
          onClick={() => commitText('')}
        >
          ×
        </button>
      )}
      {visibleTags.length > 0 && (
        <div className="search-tags">
          {visibleTags.map((tag) => (
            <button
              key={tag.id}
              className={`search-tag ${filter.tagIds.has(tag.id) ? 'selected' : ''}`}
              type="button"
              aria-pressed={filter.tagIds.has(tag.id)}
              onClick={() => toggleTag(tag.id)}
            >
              {tag.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
