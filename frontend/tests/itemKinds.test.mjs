import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardDetail, formatBytes, formatDuration, itemKind } from '../src/canvas/nodes/itemKind.ts';
import { restoreProportionsChanges } from '../src/state/commands.ts';

const blob = (overrides = {}) => ({
  hash: 'h',
  original_filename: null,
  mime_type: 'application/octet-stream',
  byte_size: 0,
  width: null,
  height: null,
  created_at: 0,
  levels: {},
  ...overrides,
});

test('item kinds follow the server type, refined by the blob', () => {
  assert.equal(itemKind({ type: 'image' }, blob({ mime_type: 'image/png' })), 'image');
  assert.equal(itemKind({ type: 'image' }, blob({ mime_type: 'image/gif' })), 'gif');
  assert.equal(itemKind({ type: 'video' }, undefined), 'video');
  assert.equal(itemKind({ type: 'audio' }, undefined), 'audio');
  assert.equal(itemKind({ type: 'file' }, undefined), 'file');
  // Unknown future types still land as a card, never disappear.
  assert.equal(itemKind({ type: 'model3d' }, undefined), 'file');
});

test('card detail: extension, size and duration', () => {
  assert.equal(
    cardDetail(
      blob({ original_filename: 'clip.final.mp4', mime_type: 'video/mp4', byte_size: 13_002_342 }),
      14.4,
    ),
    'MP4 · 12 MB · 0:14',
  );
  assert.equal(
    cardDetail(blob({ mime_type: 'application/pdf', byte_size: 2048 }), undefined),
    'PDF · 2.0 KB',
  );
  assert.equal(cardDetail(blob({ mime_type: 'image/svg+xml', byte_size: 10 }), null), 'SVG · 10 B');
});

test('byte and duration formatting', () => {
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(61.6), '1:02');
  assert.equal(formatDuration(3725), '1:02:05');
});

const node = (overrides) => ({
  id: 'a',
  kind: 'image',
  x: 0,
  y: 0,
  width: 256,
  height: 256,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  ...overrides,
});

test('restore proportions keeps the center and the longer edge', () => {
  const wide = restoreProportionsChanges([node({ id: 'wide' })], () => ({
    width: 400,
    height: 100,
  }));
  assert.deepEqual(wide, [
    { id: 'wide', kind: 'item', patch: { x: 0, y: 96, width: 256, height: 64 } },
  ]);
  const tall = restoreProportionsChanges([node({ id: 'tall' })], () => ({
    width: 100,
    height: 400,
  }));
  assert.deepEqual(tall[0]?.patch, { x: 96, y: 0, width: 64, height: 256 });
});

test('restore proportions uses the visible (cropped) ratio', () => {
  // A 400×100 source cropped to its left quarter is square.
  const changes = restoreProportionsChanges(
    [node({ crop: { x: 0, y: 0, w: 0.25, h: 1 } })],
    () => ({ width: 400, height: 100 }),
  );
  assert.deepEqual(changes, []);
});

test('restore proportions skips notes, cards and in-proportion items', () => {
  const changes = restoreProportionsChanges(
    [
      node({ id: 'note', kind: 'note' }),
      node({ id: 'card', kind: 'file' }),
      node({ id: 'fine', width: 400, height: 100 }),
    ],
    ({ id }) => (id === 'card' ? null : { width: 400, height: 100 }),
  );
  assert.deepEqual(changes, []);
});
