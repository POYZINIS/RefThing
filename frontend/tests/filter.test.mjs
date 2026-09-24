import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  duplicateItemIds,
  emptyFilter,
  fetchFilterHits,
  filterBoardContent,
  filterIsEmpty,
} from '../src/state/boardFilter.ts';

const snapshot = {
  items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  notes: [{ id: 'note-a' }, { id: 'note-b' }],
  item_tags: { a: ['red'], b: ['blue'], c: ['red', 'blue'] },
};

function ids(content) {
  return {
    items: content.items.map((item) => item.id),
    notes: content.notes.map((note) => note.id),
  };
}

test('clearing all filters restores items and notes without requiring a server response', () => {
  assert.equal(filterIsEmpty(emptyFilter), true);
  assert.deepEqual(ids(filterBoardContent(snapshot, emptyFilter, null)), {
    items: ['a', 'b', 'c'],
    notes: ['note-a', 'note-b'],
  });
});

test('a successful text search with zero hits stays empty', () => {
  const filter = { ...emptyFilter, text: 'a' };
  const hits = { text: new Set(), colour: null, duplicates: null };
  assert.deepEqual(ids(filterBoardContent(snapshot, filter, hits)), { items: [], notes: [] });
  assert.deepEqual(ids(filterBoardContent(snapshot, filter, null)), { items: [], notes: [] });
});

test('text search filters notes alongside images', () => {
  const filter = { ...emptyFilter, text: 'match' };
  const hits = { text: new Set(['b', 'note-b']), colour: null, duplicates: null };
  assert.deepEqual(ids(filterBoardContent(snapshot, filter, hits)), {
    items: ['b'],
    notes: ['note-b'],
  });
});

test('text, tags, color, and duplicate filters intersect', () => {
  const filter = {
    text: 'match',
    tagIds: new Set(['red']),
    colour: '#ff0000',
    duplicatesOnly: true,
  };
  const hits = {
    text: new Set(['a', 'c', 'note-a']),
    colour: new Set(['a', 'b', 'c']),
    duplicates: new Set(['b', 'c']),
  };
  assert.deepEqual(ids(filterBoardContent(snapshot, filter, hits)), { items: ['c'], notes: [] });
});

test('each image-only filter excludes notes, and selected tags use ANY matching', () => {
  const variants = [
    { ...emptyFilter, tagIds: new Set(['red', 'blue']) },
    { ...emptyFilter, colour: '#ff0000' },
    { ...emptyFilter, duplicatesOnly: true },
  ];
  const hits = {
    text: null,
    colour: new Set(['a', 'b', 'c']),
    duplicates: new Set(['a', 'b', 'c']),
  };
  for (const filter of variants) {
    assert.equal(filterIsEmpty(filter), false);
    assert.deepEqual(ids(filterBoardContent(snapshot, filter, hits)), {
      items: ['a', 'b', 'c'],
      notes: [],
    });
  }
});

test('duplicate partners appear even when the server emits a pair only once', () => {
  const results = [
    { item_id: 'a', snippet: 'b, c,', kind: 'duplicate', rank: 0 },
    { item_id: 'b', snippet: 'a', kind: 'duplicate', rank: 0 },
  ];
  assert.deepEqual([...duplicateItemIds(results)].sort(), ['a', 'b', 'c']);
});

test('enabled search requests start together and preserve empty versus disabled results', async () => {
  const calls = [];
  let resolveText;
  const api = {
    searchBoard: (boardId, text) => {
      calls.push(['text', boardId, text]);
      return new Promise((resolve) => {
        resolveText = resolve;
      });
    },
    searchColour: async (boardId, colour) => {
      calls.push(['colour', boardId, colour]);
      return [];
    },
    findDuplicates: async (boardId) => {
      calls.push(['duplicates', boardId]);
      return [{ item_id: 'a', snippet: 'b', kind: 'duplicate', rank: 0 }];
    },
  };
  const pending = fetchFilterHits(
    { boardId: 'board-a', text: 'match', colour: '#ff0000', duplicatesOnly: true },
    api,
  );
  assert.deepEqual(calls, [
    ['text', 'board-a', 'match'],
    ['colour', 'board-a', '#ff0000'],
    ['duplicates', 'board-a'],
  ]);
  resolveText([]);
  const hits = await pending;
  assert.deepEqual(hits.text, new Set());
  assert.deepEqual(hits.colour, new Set());
  assert.deepEqual(hits.duplicates, new Set(['a', 'b']));

  calls.length = 0;
  assert.deepEqual(
    await fetchFilterHits(
      { boardId: 'board-a', text: '', colour: null, duplicatesOnly: false },
      api,
    ),
    { text: null, colour: null, duplicates: null },
  );
  assert.deepEqual(calls, []);
});

test('request failures remain errors instead of silently showing unfiltered items', async () => {
  await assert.rejects(
    fetchFilterHits(
      { boardId: 'board-a', text: 'match', colour: null, duplicatesOnly: false },
      {
        searchBoard: async () => {
          throw new Error('offline');
        },
      },
    ),
    /offline/,
  );
});
