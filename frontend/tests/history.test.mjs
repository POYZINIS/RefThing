import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBoardOps, mergePatch, prepareCommand } from '../src/state/history.ts';

const item = {
  id: 'a',
  board_id: 'b',
  type: 'image',
  blob_hash: 'h',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  z_index: 0,
  group_id: null,
  metadata: { phash: 'p', dominant_colors: ['#f00'] },
  created_at: 1,
  updated_at: 1,
};
const snapshot = {
  board: { id: 'b' },
  seq: 1,
  items: [item],
  notes: [],
  groups: [],
  item_tags: {},
  tags: [],
  blobs: [],
};

test('mergePatch follows RFC 7396: set, delete with null, keep the rest', () => {
  assert.deepEqual(mergePatch({ a: 1, b: { c: 1, d: 2 } }, { a: null, b: { d: 3 }, e: true }), {
    b: { c: 1, d: 3 },
    e: true,
  });
});

test('metadata updates merge (pipeline keys survive) and undo removes added keys', () => {
  const ops = [
    { kind: 'update', op_id: 'o', item_id: 'a', fields: { metadata: { flip_x: true } } },
  ];
  const entry = prepareCommand(snapshot, ops, 'flip');
  const after = applyBoardOps(snapshot, entry.forward);
  assert.deepEqual(after.items[0].metadata, {
    phash: 'p',
    dominant_colors: ['#f00'],
    flip_x: true,
  });
  assert.deepEqual(entry.inverse[0].fields.metadata, { flip_x: null }, 'inverse deletes the key');
  const undone = applyBoardOps(after, entry.inverse);
  assert.deepEqual(undone.items[0].metadata, item.metadata);
});

test('a metadata update that changes nothing is dropped (no undo entry)', () => {
  const ops = [{ kind: 'update', op_id: 'o', item_id: 'a', fields: { metadata: { phash: 'p' } } }];
  assert.equal(prepareCommand(snapshot, ops, 'noop').forward.length, 0);
});
