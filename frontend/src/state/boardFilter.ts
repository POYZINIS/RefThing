import type { BoardSnapshot, SearchResult } from '@/api/client';

export type FilterState = {
  text: string;
  tagIds: Set<string>;
  colour: string | null;
  duplicatesOnly: boolean;
};

export const emptyFilter: FilterState = {
  text: '',
  tagIds: new Set(),
  colour: null,
  duplicatesOnly: false,
};

export function filterIsEmpty(filter: FilterState): boolean {
  return (
    filter.text.trim() === '' &&
    filter.tagIds.size === 0 &&
    filter.colour === null &&
    !filter.duplicatesOnly
  );
}

export type FilterQuery = {
  boardId: string;
  text: string;
  colour: string | null;
  duplicatesOnly: boolean;
};

export type FilterHits = {
  text: Set<string> | null;
  colour: Set<string> | null;
  duplicates: Set<string> | null;
};

type SearchApi = {
  searchBoard: (boardId: string, query: string) => Promise<SearchResult[]>;
  searchColour: (boardId: string, hex: string) => Promise<SearchResult[]>;
  findDuplicates: (boardId: string) => Promise<SearchResult[]>;
};

/** Include partners returned by older servers that report each pair only once. */
export function duplicateItemIds(results: SearchResult[]): Set<string> {
  const ids = new Set<string>();
  for (const result of results) {
    ids.add(result.item_id);
    for (const partner of result.snippet.split(',')) {
      const id = partner.trim();
      if (id !== '') ids.add(id);
    }
  }
  return ids;
}

/** A null result set disables a filter; an empty set means zero matches. */
export async function fetchFilterHits(query: FilterQuery, api: SearchApi): Promise<FilterHits> {
  const [text, colour, duplicates] = await Promise.all([
    query.text === '' ? null : api.searchBoard(query.boardId, query.text),
    query.colour === null ? null : api.searchColour(query.boardId, query.colour),
    query.duplicatesOnly ? api.findDuplicates(query.boardId) : null,
  ]);
  return {
    text: text === null ? null : new Set(text.map((result) => result.item_id)),
    colour: colour === null ? null : new Set(colour.map((result) => result.item_id)),
    duplicates: duplicates === null ? null : duplicateItemIds(duplicates),
  };
}

/** Filter categories intersect; multiple selected tags retain the existing ANY semantics. */
export function filterBoardContent(
  snapshot: BoardSnapshot | null,
  filter: FilterState,
  hits: FilterHits | null,
) {
  if (!snapshot) return { items: [], notes: [] };
  if (filterIsEmpty(filter)) return { items: snapshot.items, notes: snapshot.notes };

  const hasText = filter.text.trim() !== '';
  const imageOnly = filter.tagIds.size > 0 || filter.colour !== null || filter.duplicatesOnly;
  return {
    items: snapshot.items.filter((item) => {
      if (
        filter.tagIds.size > 0 &&
        !snapshot.item_tags[item.id]?.some((tagId) => filter.tagIds.has(tagId))
      ) {
        return false;
      }
      if (hasText && !hits?.text?.has(item.id)) return false;
      if (filter.colour !== null && !hits?.colour?.has(item.id)) return false;
      if (filter.duplicatesOnly && !hits?.duplicates?.has(item.id)) return false;
      return true;
    }),
    notes: imageOnly ? [] : snapshot.notes.filter((note) => !hasText || hits?.text?.has(note.id)),
  };
}
