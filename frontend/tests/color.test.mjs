import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE_INDEX,
  HARMONIES,
  harmonize,
  hexToHsv,
  hexToRgb,
  hslToHsv,
  hsvToHex,
  hsvToHsl,
  randomPalette,
  rebase,
} from '../src/color/harmony.ts';
import { extractPalette, oklabToHex, toOklab } from '../src/color/sample.ts';

const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

test('hex, HSV and HSL convert both ways', () => {
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#336699', '#ffffff', '#000000', '#c0ffee']) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex);
    assert.equal(hsvToHex(hslToHsv(hsvToHsl(hexToHsv(hex)))), hex);
  }
  assert.deepEqual(hexToRgb('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc });
  assert.equal(hexToRgb('nope'), null);
  const red = hexToHsv('#ff0000');
  assert.deepEqual([red.h, red.s, red.v], [0, 1, 1]);
});

test('every harmony gives five colours with the base in the middle', () => {
  const base = { h: 200, s: 0.7, v: 0.8 };
  for (const harmony of HARMONIES) {
    const colors = harmonize(base, harmony);
    assert.equal(colors.length, 5, harmony);
    assert.deepEqual(colors[BASE_INDEX], base, `${harmony}: base in the middle`);
    for (const color of colors) {
      assert.ok(color.s >= 0 && color.s <= 1 && color.v >= 0 && color.v <= 1, harmony);
      assert.ok(color.h >= 0 && color.h < 360, harmony);
    }
  }
});

test('the harmonies put their hues where the rules say', () => {
  const base = { h: 10, s: 0.8, v: 0.8 };
  const hues = (harmony) => harmonize(base, harmony).map((color) => color.h);
  assert.deepEqual(hues('analogous'), [310, 340, 10, 40, 70]);
  assert.ok(
    hues('complementary').some((hue) => hueDistance(hue, 190) < 1e-9),
    'opposite',
  );
  assert.ok(hues('triad').some((hue) => hueDistance(hue, 130) < 1e-9));
  assert.ok(hues('triad').some((hue) => hueDistance(hue, 250) < 1e-9));
  assert.deepEqual(new Set(hues('square')), new Set([100, 190, 10, 280]));
  assert.ok(hues('split-complementary').some((hue) => hueDistance(hue, 160) < 1e-9));
  assert.ok(hues('split-complementary').some((hue) => hueDistance(hue, 220) < 1e-9));
  assert.ok(hues('tetrad').some((hue) => hueDistance(hue, 70) < 1e-9));
  assert.ok(hues('tetrad').some((hue) => hueDistance(hue, 250) < 1e-9));
  // Monochromatic and shades never leave the base hue.
  for (const harmony of ['monochromatic', 'shades']) {
    assert.ok(
      hues(harmony).every((hue) => hue === 10),
      harmony,
    );
  }
  // Shades keep saturation too; only value changes.
  assert.ok(harmonize(base, 'shades').every((color) => color.s === base.s));
});

test('dragging any handle turns the whole harmony', () => {
  const base = { h: 100, s: 0.6, v: 0.7 };
  const colors = harmonize(base, 'analogous');
  // Drag the +30° handle to 170°: the base follows to 140°.
  const next = rebase(base, 'analogous', 3, { ...colors[3], h: 170 });
  assert.ok(Math.abs(next.h - 140) < 1e-9);
  assert.equal(rebase(base, 'analogous', BASE_INDEX, { h: 5, s: 0.2, v: 0.3 }).h, 5);
});

test('random palettes stay in pleasant bands with a dark and a light anchor', () => {
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let run = 0; run < 50; run += 1) {
    const { colors, harmony } = randomPalette(random);
    assert.equal(colors.length, 5, harmony);
    const values = colors.map((hex) => hexToHsv(hex).v);
    assert.ok((values[0] ?? 1) < 0.35, `dark anchor: ${values[0]}`);
    assert.ok((values[4] ?? 0) > 0.85, `light anchor: ${values[4]}`);
    for (const value of values.slice(1, 4)) assert.ok(value >= 0.29 && value <= 0.93);
  }
});

test('OKLab round-trips', () => {
  for (const [r, g, b] of [
    [255, 0, 0],
    [12, 200, 90],
    [128, 128, 128],
  ]) {
    const hex = oklabToHex(toOklab(r, g, b));
    const back = hexToRgb(hex);
    assert.ok(Math.abs(back.r - r) <= 1 && Math.abs(back.g - g) <= 1 && Math.abs(back.b - b) <= 1);
  }
});

test("sampling finds an image's main colours and ignores transparency", () => {
  // Three solid blocks (red, blue, near-white) and a transparent band.
  const pixels = new Uint8ClampedArray(400 * 4);
  for (let i = 0; i < 400; i += 1) {
    const [r, g, b, a] =
      i < 100
        ? [220, 30, 30, 255]
        : i < 200
          ? [30, 60, 220, 255]
          : i < 300
            ? [245, 245, 240, 255]
            : [0, 255, 0, 0];
    pixels.set([r, g, b, a], i * 4);
  }
  const palette = extractPalette(pixels, { count: 3 });
  assert.equal(palette.length, 3);
  const has = (target) =>
    palette.some((hex) => {
      const rgb = hexToRgb(hex);
      return (
        Math.abs(rgb.r - target[0]) < 8 &&
        Math.abs(rgb.g - target[1]) < 8 &&
        Math.abs(rgb.b - target[2]) < 8
      );
    });
  assert.ok(has([220, 30, 30]) && has([30, 60, 220]) && has([245, 245, 240]), palette.join());
  assert.ok(
    !palette.some((hex) => hexToRgb(hex).g > 200 && hexToRgb(hex).r < 50),
    'no transparent green',
  );
  // Ordered dark to light.
  const lightness = palette.map((hex) => toOklab(...Object.values(hexToRgb(hex)))[0]);
  assert.deepEqual(
    [...lightness].sort((a, b) => a - b),
    lightness,
  );
  assert.deepEqual(extractPalette(new Uint8ClampedArray(16)), [], 'all transparent');
});

test('a two-colour image samples as two colours, not five near-copies', () => {
  const pixels = new Uint8ClampedArray(1000 * 4);
  for (let i = 0; i < 1000; i += 1) {
    // Two colours with a little noise, as a real (compressed) image has.
    const noise = (i * 37) % 7;
    const [r, g, b] = i < 500 ? [220 + noise, 90, 30] : [30, 120 + noise, 200];
    pixels.set([r, g, b, 255], i * 4);
  }
  assert.equal(extractPalette(pixels, { count: 5 }).length, 2);
});
