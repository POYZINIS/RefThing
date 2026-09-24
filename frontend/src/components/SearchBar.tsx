import { useState } from 'react';
import type { Tag } from '@/api/client';
import { emptyFilter, type FilterState, filterIsEmpty } from '@/state/boardFilter';
import './SearchBar.css';

export { emptyFilter, type FilterState, filterIsEmpty } from '@/state/boardFilter';

type SearchBarProps = {
  tags: Tag[];
  filter: FilterState;
  onChange: (filter: FilterState) => void;
  loading?: boolean;
  error?: string | null;
  resultCount?: number;
  onRetry?: () => void;
};

export default function SearchBar({
  tags,
  filter,
  onChange,
  loading = false,
  error = null,
  resultCount,
  onRetry,
}: SearchBarProps) {
  const [lastColour, setLastColour] = useState('#ff0000');
  const active = !filterIsEmpty(filter);
  const toggleTag = (tagId: string) => {
    const next = new Set(filter.tagIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    onChange({ ...filter, tagIds: next });
  };

  return (
    <div className={`search-filter ${active ? 'active' : ''}`}>
      <div className="search-input-row">
        <input
          className="search-input"
          aria-label="Search board items"
          placeholder="Search items, tags, notes…"
          value={filter.text}
          onChange={(event) => onChange({ ...filter, text: event.target.value })}
        />
        {active && (
          <button
            className="search-clear"
            type="button"
            aria-label="Clear search and filters"
            title="Clear search and filters"
            onClick={() => onChange({ ...emptyFilter, tagIds: new Set() })}
          >
            ×
          </button>
        )}
      </div>
      <div className="search-options">
        <button
          className={`search-tag ${filter.colour !== null ? 'selected' : ''}`}
          type="button"
          aria-pressed={filter.colour !== null}
          title="Filter images by a similar dominant color"
          onClick={() =>
            onChange({ ...filter, colour: filter.colour === null ? lastColour : null })
          }
        >
          Color
        </button>
        {filter.colour !== null && (
          <label className="search-colour-label">
            <input
              className="search-colour-input"
              type="color"
              aria-label="Search color"
              value={filter.colour}
              onChange={(event) => {
                setLastColour(event.target.value);
                onChange({ ...filter, colour: event.target.value });
              }}
            />
            <span>{filter.colour}</span>
          </label>
        )}
        <button
          className={`search-tag ${filter.duplicatesOnly ? 'selected' : ''}`}
          type="button"
          aria-pressed={filter.duplicatesOnly}
          title="Show likely duplicates based on visual similarity"
          onClick={() => onChange({ ...filter, duplicatesOnly: !filter.duplicatesOnly })}
        >
          Duplicates
        </button>
      </div>
      {tags.length > 0 && (
        <div className="search-tags">
          {tags.map((tag) => (
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
      {active && (
        <div className="search-feedback" role="status" aria-live="polite">
          {loading ? (
            'Searching…'
          ) : error ? (
            <>
              <span>Search failed: {error}</span>
              {onRetry && (
                <button className="search-tag" type="button" onClick={onRetry}>
                  Retry
                </button>
              )}
            </>
          ) : resultCount !== undefined ? (
            resultCount === 0 ? (
              'No matches. Change or clear the filters.'
            ) : (
              `${resultCount} ${resultCount === 1 ? 'match' : 'matches'}`
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
