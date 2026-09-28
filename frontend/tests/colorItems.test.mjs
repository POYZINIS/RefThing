import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hsvToHex } from '../src/color/harmony.ts';
import {
  DEFAULT_WHEEL,
  isBoardItem,
  joinTarget,
  paletteColors,
  paletteSize,
  swatchAt,
  swatchCenter,
  wheelState,
} from '../src/color/items.ts';

const box = (id, x, colors, extra = {}) => ({
  id,
  x,
  y: 0,
  width: colors.length * 60,
  height: 80,
  rotation: 0,
  colors,
  ...extra,
});

test('palette and wheel metadata are validated', () => {
  assert.deepEqual(paletteColors({ palette: { colors: ['#AABBCC', 'red', '#123456', 4] } }), [
    '#aabbcc',
    '#123456',
  ]);
  assert.deepEqual(paletteColors({}), []);
  const wheel = wheelState({
    colorwheel: { base: '#FF0000', harmony: 'triad', mode: 'hsl', library: [['#000000'], 'x', []] },
  });
  assert.equal(wheel.base, '#ff0000');
  assert.equal(wheel.harmony, 'triad');
  assert.equal(wheel.mode, 'hsl');
  assert.deepEqual(wheel.library, [['#000000']]);
  assert.equal(wheel.colors.length, 5, 'colours default to the harmony');
  assert.equal(wheel.points.length, 5, 'and so do its points');
  // Exact points are kept while they match the colours; stale ones (a
  // patch that set only colours) are rebuilt from the colours.
  const exact = { h: 212.25, s: 0.6312, v: 0.0421 };
  const kept = wheelState({
    colorwheel: { colors: Array(5).fill(hsvToHex(exact)), points: Array(5).fill(exact) },
  });
  assert.deepEqual(kept.points[2], exact);
  const stale = wheelState({
    colorwheel: { colors: Array(5).fill('#ff0000'), points: Array(5).fill(exact) },
  });
  assert.equal(hsvToHex(stale.points[2]), '#ff0000');
  const junk = wheelState({ colorwheel: { harmony: 'rainbow', mode: 'cmyk' } });
  assert.equal(junk.harmony, DEFAULT_WHEEL.harmony);
  assert.equal(junk.mode, 'hsv');
});

test('blob-less colour tools are board items; other blob-less items are not', () => {
  assert.ok(isBoardItem({ blob_hash: null, type: 'palette' }));
  assert.ok(isBoardItem({ blob_hash: null, type: 'colorwheel' }));
  assert.ok(isBoardItem({ blob_hash: 'abc', type: 'image' }));
  assert.ok(!isBoardItem({ blob_hash: null, type: 'image' }));
});

test('palettes arrive camera-sized and swatches are hit where they are drawn', () => {
  assert.deepEqual(paletteSize(5, 1), { width: 320, height: 64 * (7 / 9) });
  assert.deepEqual(paletteSize(5, 2), { width: 160, height: 32 * (7 / 9) });
  const palette = box('p', 100, ['#111111', '#222222', '#333333']);
  assert.equal(swatchAt(palette, 3, { x: 110, y: 40 }), 0);
  assert.equal(swatchAt(palette, 3, { x: 200, y: 40 }), 1);
  assert.equal(swatchAt(palette, 3, { x: 279, y: 40 }), 2);
  assert.equal(swatchAt(palette, 3, { x: 290, y: 40 }), null, 'outside');
  // Rotated a half turn, the first swatch is on the right.
  const turned = { ...palette, rotation: 180 };
  assert.equal(swatchAt(turned, 3, { x: 270, y: 40 }), 0);
  const centre = swatchCenter(palette, 3, 1);
  assert.ok(Math.abs(centre.x - 190) < 1e-9 && Math.abs(centre.y - 40) < 1e-9);
});

test("a palette dropped at another's end joins it, keeping the target's swatch size", () => {
  const target = box('t', 0, ['#aa0000', '#00aa00']);
  // Its left edge right at the target's right edge.
  const right = joinTarget(box('m', 122, ['#0000aa']), [target], 10);
  assert.ok(right);
  assert.equal(right.side, 'right');
  assert.deepEqual(right.colors, ['#aa0000', '#00aa00', '#0000aa']);
  assert.deepEqual([right.box.x, right.box.width], [0, 180]);
  // Its right edge at the target's left edge: the colours go in front.
  const left = joinTarget(box('m', -58, ['#0000aa']), [target], 10);
  assert.equal(left.side, 'left');
  assert.deepEqual(left.colors, ['#0000aa', '#aa0000', '#00aa00']);
  assert.deepEqual([left.box.x, left.box.width], [-60, 180]);
  // Too far, or not on the same row: nothing.
  assert.equal(joinTarget(box('m', 160, ['#0000aa']), [target], 10), null);
  assert.equal(joinTarget(box('m', 120, ['#0000aa'], { y: 200 }), [target], 10), null);
  // Never joins itself.
  assert.equal(joinTarget(target, [target], 10), null);
});
