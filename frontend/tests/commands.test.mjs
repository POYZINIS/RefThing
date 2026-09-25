import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copySelection,
  DUPLICATE_OFFSET,
  duplicateOps,
  fitViewport,
  groupOps,
  groupStyleOps,
  lockOps,
  pasteOps,
  restackOps,
  toggleTagOps,
  ungroupOps,
  unionRect,
  withGroupMates,
} from '../src/state/commands.ts';
import { applyBoardOps, prepareCommand } from '../src/state/history.ts';

let counter = 0;
const newId = () => `id-${++counter}`;

const item = (id, z, extra = {}) => ({
  id,
  board_id: 'b',
  type: 'image',
  blob_hash: `hash-${id}`,
  x: z * 10,
  y: 0,
  width: 100,
  height: 80,
  rotation: 0,
  z_index: z,
  group_id: null,
  metadata: {},
  created_at: 1,
  updated_at: 1,
  ...extra,
});
const note = (id, z) => ({
  id,
  board_id: 'b',
  x: 0,
  y: 200,
  width: 200,
  height: 100,
  rotation: 0,
  z_index: z,
  content_json: { text: id },
  bg_color: null,
  opacity: 1,
  created_at: 1,
  updated_at: 1,
});

function board(extra = {}) {
  return {
    board: { id: 'b' },
    seq: 1,
    items: [item('a', 0), item('b', 1, { group_id: 'g' }), item('c', 2, { group_id: 'g' })],
    notes: [note('n', 3)],
    groups: [
      {
        id: 'g',
        board_id: 'b',
        parent_group_id: null,
        name: 'G',
        collapsed: false,
        bg_color: null,
        opacity: 1,
        created_at: 1,
        locked: false,
      },
    ],
    item_tags: { a: ['red'] },
    tags: [],
    blobs: [],
    ...extra,
  };
}

/** forward then inverse must land exactly where we started (one undo entry). */
function roundTrip(snapshot, ops) {
  const entry = prepareCommand(snapshot, ops, 'test');
  const after = applyBoardOps(snapshot, entry.forward);
  const back = applyBoardOps(after, entry.inverse);
  const sort = (list) => [...list].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.deepEqual(sort(back.items), sort(snapshot.items));
  assert.deepEqual(sort(back.notes), sort(snapshot.notes));
  assert.deepEqual(sort(back.groups), sort(snapshot.groups));
  return after;
}

test('group: two or more items become one new group; notes are skipped', () => {
  const snapshot = board();
  assert.deepEqual(groupOps(snapshot, ['a', 'n'], newId), [], 'one item is not a group');
  const ops = groupOps(snapshot, ['a', 'b', 'n'], newId, 5);
  assert.equal(ops[0].kind, 'restore_group');
  assert.deepEqual(ops[1].item_ids, ['a', 'b']);
  const after = roundTrip(snapshot, ops);
  const groupId = ops[0].group.id;
  assert.deepEqual(
    after.items.filter((i) => i.group_id === groupId).map((i) => i.id),
    ['a', 'b'],
  );
});

test('ungroup: members leave and the empty group is removed, undoably', () => {
  const snapshot = board();
  const ops = ungroupOps(snapshot, ['b'], newId);
  assert.deepEqual(
    ops.map((op) => op.kind),
    ['set_group', 'remove_group'],
  );
  assert.deepEqual(ops[0].item_ids, ['b', 'c'], 'the whole group dissolves');
  const after = roundTrip(snapshot, ops);
  assert.equal(after.groups.length, 0);
  assert.ok(after.items.every((i) => i.group_id === null));
});

test('selecting one grouped item expands to the whole group', () => {
  assert.deepEqual(withGroupMates(board(), ['b']).sort(), ['b', 'c']);
  assert.deepEqual(withGroupMates(board(), ['a']), ['a']);
});

test('restack: front goes above items AND notes, back below everything', () => {
  const snapshot = board();
  const front = restackOps(snapshot, ['a'], 'front', 9, newId);
  assert.deepEqual(front[0].fields, { z_index: 4 });
  const back = restackOps(snapshot, ['n', 'c'], 'back', 9, newId);
  assert.deepEqual(
    back.map((op) => (op.kind === 'put_note' ? op.note.z_index : op.fields.z_index)),
    [-2, -1],
    'keeps the pair’s internal order (c below n)',
  );
  roundTrip(snapshot, back);
});

test('duplicate: offset copies on top, tags kept, ungrouped, fresh ids', () => {
  const snapshot = board();
  const { ops, ids } = duplicateOps(snapshot, ['a', 'b', 'n'], newId, 7);
  assert.equal(ids.length, 3);
  const items = ops.filter((op) => op.kind === 'restore_item');
  const notes = ops.filter((op) => op.kind === 'put_note');
  assert.equal(items.length, 2);
  assert.equal(notes.length, 1);
  const copyOfA = items.find((op) => op.item.blob_hash === 'hash-a');
  assert.equal(copyOfA.item.x, 0 + DUPLICATE_OFFSET);
  assert.deepEqual(copyOfA.tag_ids, ['red']);
  assert.ok(items.every((op) => op.item.group_id === null));
  assert.ok(ops.every((op) => !['a', 'b', 'n'].includes(op.item?.id ?? op.note?.id)));
  const zs = ops.map((op) => (op.item ?? op.note).z_index);
  assert.ok(Math.min(...zs) > 3, 'copies land above everything');
  roundTrip(snapshot, ops);
});

test('fitViewport centers the bounds and clamps zoom', () => {
  const fit = fitViewport({ left: 0, top: 0, right: 1000, bottom: 500 }, 1100, 600, 50);
  assert.equal(fit.zoom, 1);
  assert.deepEqual([fit.x, fit.y], [50, 50]);
  const tiny = fitViewport({ left: 0, top: 0, right: 1, bottom: 1 }, 1000, 1000);
  assert.equal(tiny.zoom, 4, 'clamped to max zoom');
  assert.equal(fitViewport(null, 100, 100), null);
  assert.deepEqual(
    unionRect([
      { left: 0, top: 5, right: 10, bottom: 10 },
      { left: -5, top: 0, right: 3, bottom: 20 },
    ]),
    { left: -5, top: 0, right: 10, bottom: 20 },
  );
});

test('lock: touches every selected group once and undoes exactly', () => {
  const snapshot = board();
  const ops = lockOps(snapshot, ['b', 'c'], true, newId);
  assert.deepEqual(
    ops.map((op) => [op.kind, op.group_id, op.locked]),
    [['set_group_locked', 'g', true]],
  );
  const after = roundTrip(snapshot, ops);
  assert.equal(after.groups[0].locked, true);
  assert.deepEqual(lockOps(snapshot, ['a'], true, newId), [], 'ungrouped selection: nothing');
});

test('group style and tag toggles are single undoable commands', () => {
  const snapshot = board();
  const style = groupStyleOps(snapshot, ['b'], '#ff0000', 0.5, newId);
  const styled = roundTrip(snapshot, style);
  assert.deepEqual([styled.groups[0].bg_color, styled.groups[0].opacity], ['#ff0000', 0.5]);

  // 'a' has red, 'b' doesn't → add to b only; then all have it → remove all.
  const add = toggleTagOps(snapshot, ['a', 'b', 'n'], 'red', newId);
  assert.deepEqual(
    add.map((op) => [op.item_id, op.fields]),
    [['b', { add_tag_ids: ['red'] }]],
  );
  const tagged = applyBoardOps(snapshot, prepareCommand(snapshot, add, 't').forward);
  const remove = toggleTagOps(tagged, ['a', 'b'], 'red', newId);
  assert.deepEqual(
    remove.map((op) => op.fields),
    [{ remove_tag_ids: ['red'] }, { remove_tag_ids: ['red'] }],
  );
});

test('copy → paste lands centred on the cursor, on top, into another board', () => {
  const source = board();
  const clip = copySelection(source, ['a', 'n']);
  assert.deepEqual(clip.itemTags, { a: ['red'] });
  const target = board({ board: { id: 'other' }, items: [item('z', 9)], notes: [] });
  const { ops, ids } = pasteOps(target, clip, { x: 1000, y: 500 }, newId, 3);
  assert.equal(ids.length, 2);
  const placed = ops.map((op) => op.item ?? op.note);
  assert.ok(placed.every((record) => record.board_id === 'other'));
  assert.ok(
    placed.every((record) => record.z_index > 9),
    'above everything on the target',
  );
  const left = Math.min(...placed.map((r) => r.x));
  const right = Math.max(...placed.map((r) => r.x + r.width));
  const top = Math.min(...placed.map((r) => r.y));
  const bottom = Math.max(...placed.map((r) => r.y + r.height));
  assert.deepEqual([(left + right) / 2, (top + bottom) / 2], [1000, 500]);
  roundTrip(target, ops);
  assert.deepEqual(pasteOps(target, copySelection(source, []), { x: 0, y: 0 }), {
    ops: [],
    ids: [],
  });
});
