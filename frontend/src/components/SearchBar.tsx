import { useState } from 'react';
import type { Tag } from '@/api/client';
import { emptyFilter, type FilterState, filterIsEmpty } from '@/state/boardFilter';
import { Icon } from '@/ui/Icon';
import { Popover } from '@/ui/Popover';

export { emptyFilter, type FilterState, filterIsEmpty } from '@/state/boardFilter';

type SearchBarProps = {
  tags: Tag[];
  filter: FilterState;
  onChange: (filter: FilterState) => void;
  loading?: boolean;
  error?: string | null;
  resultCount?: number;
  onRetry?: () => void;
  /** Where the panel is open (client px), or null when closed. */
  openAt: { x: number; y: number } | null;
  /** Reopen the panel (from the filter pill). */
  onOpen: () => void;
  onClose: () => void;
};

/**
 * Search and filter (Phase 6), with no permanent place on screen: the panel
 * opens where the board was right-clicked (Search… in the context menu) or
 * at the cursor (Ctrl+F), and closes like any popover. The filter itself
 * outlives the panel; while one holds, a small pill at the top says so and
 * offers the way back — otherwise a filtered board just looks emptier.
 */
export default function SearchBar({
  tags,
  filter,
  onChange,
  loading = false,
  error = null,
  resultCount,
  onRetry,
  openAt,
  onOpen,
  onClose,
}: SearchBarProps) {
  const [lastColour, setLastColour] = useState('#ff0000');
  const active = !filterIsEmpty(filter);
  const clear = () => onChange({ ...emptyFilter, tagIds: new Set() });
  const toggleTag = (tagId: string) => {
    const next = new Set(filter.tagIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    onChange({ ...filter, tagIds: next });
  };

  const summary = loading
    ? 'Searching…'
    : resultCount === undefined
      ? null
      : resultCount === 0
        ? 'No matches'
        : `${resultCount} ${resultCount === 1 ? 'match' : 'matches'}`;

  return (
    <>
      {openAt && (
        <Popover anchor={openAt} label="Search" className="search-popover" onClose={onClose}>
          <form className="search-filter" onSubmit={(event) => event.preventDefault()}>
            <div className="search-input-row">
              <Icon name="search" size={16} />
              <input
                className="search-input"
                aria-label="Search board items"
                placeholder="Search items, tags, notes"
                value={filter.text}
                onChange={(event) => onChange({ ...filter, text: event.target.value })}
              />
              {active && (
                <button
                  className="icon-button search-clear"
                  type="button"
                  aria-label="Clear search and filters"
                  title="Clear search and filters"
                  onClick={clear}
                >
                  <Icon name="close" size={15} />
                </button>
              )}
            </div>
            <div className="search-options">
              <button
                className="chip"
                type="button"
                aria-pressed={filter.colour !== null}
                title="Show images whose main color is close to a chosen color"
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
                className="chip"
                type="button"
                aria-pressed={filter.duplicatesOnly}
                title="Show only images that look like near-copies of each other"
                onClick={() => onChange({ ...filter, duplicatesOnly: !filter.duplicatesOnly })}
              >
                Duplicates
              </button>
            </div>
            {tags.length > 0 && (
              <fieldset className="search-tags">
                <legend className="visually-hidden">Filter by tag</legend>
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    className="chip"
                    type="button"
                    aria-pressed={filter.tagIds.has(tag.id)}
                    onClick={() => toggleTag(tag.id)}
                  >
                    <Icon name="tag" size={13} />
                    {tag.name}
                  </button>
                ))}
              </fieldset>
            )}
            {active && (error || summary) && (
              <div
                className={`search-panel-status ${error ? 'error' : ''}`}
                role="status"
                aria-live="polite"
              >
                {error ? (
                  <>
                    <span>Search failed: {error}</span>
                    {onRetry && (
                      <button className="button small" type="button" onClick={onRetry}>
                        Retry
                      </button>
                    )}
                  </>
                ) : resultCount === 0 ? (
                  'No matches. Change or clear the filters.'
                ) : (
                  summary
                )}
              </div>
            )}
          </form>
        </Popover>
      )}
      {active && !openAt && (
        <div className="filter-pill" role="status" aria-live="polite">
          <Icon name="search" size={14} />
          <span className="filter-pill-text">
            {error ? 'Search failed' : (summary ?? 'Filtered')}
            {filter.text && <em>“{filter.text}”</em>}
          </span>
          <button className="text-action" type="button" onClick={onOpen}>
            Edit
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Clear search and filters"
            title="Clear"
            onClick={clear}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </>
  );
}
