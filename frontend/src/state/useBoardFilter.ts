import { useCallback, useEffect, useMemo, useState } from 'react';
import { type BoardSnapshot, findDuplicates, searchBoard, searchColour } from '@/api/client';
import {
  type FilterHits,
  type FilterState,
  fetchFilterHits,
  filterBoardContent,
  filterIsEmpty,
} from '@/state/boardFilter';

type SearchState = {
  key: string;
  hits: FilterHits | null;
  loading: boolean;
  error: string | null;
};

const searchApi = { searchBoard, searchColour, findDuplicates };

export function useBoardFilter(snapshot: BoardSnapshot | null, filter: FilterState) {
  const boardId = snapshot?.board.id ?? '';
  const text = filter.text.trim();
  const { colour, duplicatesOnly } = filter;
  const needsSearch = boardId !== '' && (text !== '' || colour !== null || duplicatesOnly);
  const queryKey = JSON.stringify([boardId, text, colour, duplicatesOnly]);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [retryIndex, setRetryIndex] = useState(0);
  const retry = useCallback(() => setRetryIndex((index) => index + 1), []);
  const query = useMemo(
    () => ({ boardId, text, colour, duplicatesOnly }),
    [boardId, text, colour, duplicatesOnly],
  );

  // Changes to board content and completed image processing refresh visual
  // metadata. Viewport-only saves do not schedule another search.
  const seq = snapshot?.seq;
  const notes = snapshot?.notes;
  const tags = snapshot?.tags;
  const blobs = snapshot?.blobs;
  // biome-ignore lint/correctness/useExhaustiveDependencies: seq/notes/tags/blobs/retryIndex intentionally re-run the search when board content changes
  useEffect(() => {
    if (!needsSearch) return;
    let cancelled = false;
    setSearch((previous) => ({
      key: queryKey,
      hits: previous?.key === queryKey ? previous.hits : null,
      loading: true,
      error: null,
    }));
    const timer = setTimeout(
      () => {
        void fetchFilterHits(query, searchApi).then(
          (hits) => {
            if (!cancelled) setSearch({ key: queryKey, hits, loading: false, error: null });
          },
          (caught: unknown) => {
            if (!cancelled) {
              setSearch({
                key: queryKey,
                hits: null,
                loading: false,
                error: caught instanceof Error ? caught.message : 'Could not search this board',
              });
            }
          },
        );
      },
      text === '' ? 0 : 250,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsSearch, queryKey, query, text, seq, notes, tags, blobs, retryIndex]);

  const current = search?.key === queryKey ? search : null;
  const hits = current?.hits ?? null;
  const content = useMemo(
    () => filterBoardContent(snapshot, filter, hits),
    [snapshot, filter, hits],
  );
  return {
    ...content,
    active: !filterIsEmpty(filter),
    loading: needsSearch && (current === null || current.loading),
    error: needsSearch ? (current?.error ?? null) : null,
    retry,
  };
}
