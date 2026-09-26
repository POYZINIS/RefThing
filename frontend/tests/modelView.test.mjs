import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cameraBasis,
  DEFAULT_MODEL_SETTINGS,
  dolly,
  framingDistance,
  MAX_DISTANCE,
  MIN_DISTANCE,
  modelSettings,
  modelTextureScale,
  orbit,
  pan,
  settingsKey,
  viewOf,
} from '../src/canvas/nodes/modelView.ts';

const round = (value) => Math.round(value) + 0;
const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);

test('stored model settings are validated field by field', () => {
  assert.deepEqual(modelSettings(undefined), DEFAULT_MODEL_SETTINGS);
  assert.deepEqual(modelSettings('junk'), DEFAULT_MODEL_SETTINGS);
  const stored = modelSettings({ shading: 'flat', background: false, yaw: 1, distance: 'far' });
  assert.equal(stored.shading, 'flat');
  assert.equal(stored.background, false);
  assert.equal(stored.yaw, 1);
  assert.equal(stored.distance, DEFAULT_MODEL_SETTINGS.distance, 'malformed → default');
  assert.equal(modelSettings({ shading: 'wireframe' }).shading, 'original');
  // Out-of-range values are clamped, never trusted.
  assert.equal(modelSettings({ distance: 1e9 }).distance, MAX_DISTANCE);
  assert.ok(modelSettings({ pitch: 10 }).pitch < Math.PI / 2);
});

test('dragging right turns the model right; down tilts it towards you', () => {
  const start = viewOf(DEFAULT_MODEL_SETTINGS);
  const right = orbit(start, 100, 0, 400);
  assert.ok(right.yaw < start.yaw, 'the camera swings left around it');
  close(right.pitch, start.pitch);
  // A full viewport height of drag is half a turn.
  close(orbit({ ...start, yaw: 0 }, 400, 0, 400).yaw, -Math.PI);
  const down = orbit(start, 0, 50, 400);
  assert.ok(down.pitch > start.pitch, 'the camera rises: more of the top shows');
  // Pitch stops short of straight overhead (no flip).
  assert.ok(orbit(start, 0, 1e6, 400).pitch < Math.PI / 2);
  // Yaw wraps instead of growing without bound.
  assert.ok(Math.abs(orbit(start, 1e6, 0, 400).yaw) <= Math.PI);
});

test('the wheel dollies exponentially within limits', () => {
  const start = viewOf(DEFAULT_MODEL_SETTINGS);
  const inward = dolly(start, -100);
  assert.ok(inward.distance < start.distance);
  close(dolly(inward, 100).distance, start.distance);
  assert.equal(dolly(start, -1e6).distance, MIN_DISTANCE);
  assert.equal(dolly(start, 1e6).distance, MAX_DISTANCE);
});

test('panning moves the look-at point in the view plane', () => {
  const start = { ...viewOf(DEFAULT_MODEL_SETTINGS), yaw: 0, pitch: 0 };
  // Looking down -Z: dragging right moves the target left (-X) so the model
  // follows the pointer; dragging down moves it up (+Y).
  const moved = pan(start, 10, 10, 400, 300, Math.PI / 4);
  assert.ok(moved.panX < 0);
  assert.ok(moved.panY > 0);
  close(moved.panZ, 0);
  const { forward, right, up } = cameraBasis(start);
  assert.deepEqual([forward.x, forward.y, forward.z].map(round), [0, 0, 1]);
  assert.deepEqual([right.x, right.y, right.z].map(round), [1, 0, 0]);
  assert.deepEqual([up.x, up.y, up.z].map(round), [0, 1, 0]);
});

test('framing fits the sphere in the narrower field of view', () => {
  const fovY = Math.PI / 4;
  const square = framingDistance(1, fovY, 1);
  close(square, 1 / Math.sin(fovY / 2));
  // A tall viewport is narrower across: the camera backs off.
  assert.ok(framingDistance(1, fovY, 0.5) > square);
  // A wide one is limited by its height: same as square.
  close(framingDistance(1, fovY, 2), square);
});

test('the settings key changes with anything that changes a render', () => {
  const base = settingsKey(DEFAULT_MODEL_SETTINGS);
  assert.equal(settingsKey({ ...DEFAULT_MODEL_SETTINGS }), base);
  assert.notEqual(settingsKey({ ...DEFAULT_MODEL_SETTINGS, background: false }), base);
  assert.notEqual(settingsKey({ ...DEFAULT_MODEL_SETTINGS, shading: 'flat' }), base);
  assert.notEqual(settingsKey({ ...DEFAULT_MODEL_SETTINGS, yaw: 0 }), base);
  // Float noise below a render's precision doesn't.
  assert.equal(
    settingsKey({ ...DEFAULT_MODEL_SETTINGS, yaw: DEFAULT_MODEL_SETTINGS.yaw + 1e-9 }),
    base,
  );
});

test('model renders are bucketed by powers of two of the zoom', () => {
  assert.equal(modelTextureScale(1, 1), 1);
  assert.equal(modelTextureScale(0.7, 1), 1);
  assert.equal(modelTextureScale(0.3, 2), 1);
  assert.equal(modelTextureScale(0.2, 1), 0.25);
  assert.equal(modelTextureScale(10, 2), 4, 'capped');
  assert.ok(modelTextureScale(0.0001, 1) > 0);
});
