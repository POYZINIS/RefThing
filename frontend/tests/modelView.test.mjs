import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anglesFacing,
  cameraBasis,
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_MODEL_SUN,
  dolly,
  framingDistance,
  isDefaultView,
  isFacing,
  lerpAngles,
  MAX_DISTANCE,
  MIN_DISTANCE,
  modelSettings,
  modelTextureScale,
  orbit,
  pan,
  projectDirection,
  rotateSun,
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

test('the sun is a unit direction; anything malformed is the default sun', () => {
  const { sunX, sunY, sunZ } = DEFAULT_MODEL_SETTINGS;
  close(Math.hypot(sunX, sunY, sunZ), 1);
  const stored = modelSettings({ sunX: 0, sunY: 2, sunZ: 0 });
  assert.deepEqual([stored.sunX, stored.sunY, stored.sunZ], [0, 1, 0], 'normalized');
  const zero = modelSettings({ sunX: 0, sunY: 0, sunZ: 0 });
  assert.equal(zero.sunY, DEFAULT_MODEL_SUN.sunY);
});

test('the gizmo projects directions into the camera view', () => {
  const front = { yaw: 0, pitch: 0 };
  const x = projectDirection({ x: 1, y: 0, z: 0 }, front);
  close(x.x, 1);
  close(x.y, 0);
  const up = projectDirection({ x: 0, y: 1, z: 0 }, front);
  close(up.y, -1, 1e-9);
  close(projectDirection({ x: 0, y: 0, z: 1 }, front).depth, 1);
  // Turned half around, +X points left.
  close(projectDirection({ x: 1, y: 0, z: 0 }, { yaw: Math.PI, pitch: 0 }).x, -1);
});

test('dragging the trackball swings the sun the way the pointer goes', () => {
  const front = { yaw: 0, pitch: 0 };
  const facing = { sunX: 0, sunY: 0, sunZ: 1 };
  const right = rotateSun(facing, front, 20, 0);
  assert.ok(projectDirection({ x: right.sunX, y: right.sunY, z: right.sunZ }, front).x > 0);
  const down = rotateSun(facing, front, 0, 20);
  assert.ok(projectDirection({ x: down.sunX, y: down.sunY, z: down.sunZ }, front).y > 0);
  close(Math.hypot(down.sunX, down.sunY, down.sunZ), 1);
  // Far enough and it goes around behind the model.
  const behind = rotateSun(facing, front, 90, 0);
  assert.ok(projectDirection({ x: behind.sunX, y: behind.sunY, z: behind.sunZ }, front).depth < 0);
});

test('Reset View is about the camera only', () => {
  assert.ok(isDefaultView(DEFAULT_MODEL_SETTINGS));
  assert.ok(
    isDefaultView({ ...DEFAULT_MODEL_SETTINGS, sunX: 1, sunY: 0, sunZ: 0, shading: 'flat' }),
  );
  assert.ok(!isDefaultView({ ...DEFAULT_MODEL_SETTINGS, yaw: 0 }));
});

test('axis views: facing a direction, recognizing it, easing to it', () => {
  const facingX = anglesFacing({ x: 1, y: 0, z: 0 });
  close(facingX.yaw, Math.PI / 2);
  close(facingX.pitch, 0);
  assert.ok(isFacing(facingX, { x: 1, y: 0, z: 0 }));
  assert.ok(!isFacing(facingX, { x: 0, y: 0, z: 1 }));
  const top = anglesFacing({ x: 0, y: 1, z: 0 });
  assert.equal(top.yaw, 0, 'X stays to the right from above');
  assert.ok(top.pitch > Math.PI / 2 - 0.01 && top.pitch < Math.PI / 2);
  // Easing takes the short way round.
  const half = lerpAngles({ yaw: 3, pitch: 0 }, { yaw: -3, pitch: 0.4 }, 0.5);
  assert.ok(Math.abs(Math.abs(half.yaw) - Math.PI) < 0.01, `across the seam: ${half.yaw}`);
  close(half.pitch, 0.2);
});

test('orbiting leaves an axis view for perspective; menu ortho stays', () => {
  const axis = { ...viewOf(DEFAULT_MODEL_SETTINGS), projection: 'orthographic', axisView: true };
  const turned = orbit(axis, 10, 0, 400);
  assert.equal(turned.projection, 'perspective');
  assert.equal(turned.axisView, false);
  const chosen = { ...axis, axisView: false };
  assert.equal(orbit(chosen, 10, 0, 400).projection, 'orthographic');
  // Stored: axisView only means something with ortho.
  assert.equal(modelSettings({ projection: 'perspective', axisView: true }).axisView, false);
  assert.equal(modelSettings({ projection: 'sideways' }).projection, 'perspective');
});
