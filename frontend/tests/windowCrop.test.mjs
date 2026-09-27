import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cropShift, sampleCropCurve } from '../src/canvas/windowCrop.ts';

const screen = { availWidth: 1920, availHeight: 1040 };
const frame = { x: 300, y: 200, width: 1000, height: 700 };

test('dragging the left / top edge or a top-left corner crops (camera shifts back)', () => {
  // Left edge 80px right: the window narrows and its origin moves with it.
  assert.deepEqual(cropShift(frame, { ...frame, x: 380, width: 920 }, screen), { dx: 80, dy: 0 });
  // Top edge 50px down.
  assert.deepEqual(cropShift(frame, { ...frame, y: 250, height: 650 }, screen), { dx: 0, dy: 50 });
  // Top-left corner out, up and left.
  assert.deepEqual(cropShift(frame, { x: 260, y: 170, width: 1040, height: 730 }, screen), {
    dx: -40,
    dy: -30,
  });
  // Bottom-left corner: only x moves.
  assert.deepEqual(cropShift(frame, { ...frame, x: 320, width: 980, height: 760 }, screen), {
    dx: 20,
    dy: 0,
  });
});

test('the right / bottom edges, moves and maximizing keep the board anchored', () => {
  // Bottom-right corner: size changes, origin doesn't.
  assert.equal(cropShift(frame, { ...frame, width: 1200, height: 800 }, screen), null);
  // A plain move carries the board with the window.
  assert.equal(cropShift(frame, { ...frame, x: 600, y: 400 }, screen), null);
  // Maximize and restore jump across the screen: no cropping.
  const maximized = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(cropShift(frame, maximized, screen), null);
  assert.equal(cropShift(maximized, frame, screen), null);
  // Nothing changed.
  assert.equal(cropShift(frame, { ...frame }, screen), null);
});

test('the crop curve passes through every sampled step and holds at the ends', () => {
  const samples = [
    { time: 0, x: 0, y: 0 },
    { time: 16, x: 12, y: 0 },
    { time: 50, x: 30, y: 8 },
    { time: 66, x: 60, y: 8 },
  ];
  for (const sample of samples) {
    const at = sampleCropCurve(samples, sample.time);
    assert.ok(Math.abs(at.x - sample.x) < 1e-9 && Math.abs(at.y - sample.y) < 1e-9);
  }
  assert.deepEqual(sampleCropCurve(samples, -10), { x: 0, y: 0 });
  assert.deepEqual(sampleCropCurve(samples, 500), { x: 60, y: 8 });
  assert.deepEqual(sampleCropCurve([], 10), { x: 0, y: 0 });
});

test('the crop curve is smooth: continuous and moving the same way at a step', () => {
  // Uneven, bursty steps in one direction.
  const samples = [
    { time: 0, x: 0, y: 0 },
    { time: 10, x: 5, y: 0 },
    { time: 40, x: 40, y: 0 },
    { time: 48, x: 44, y: 0 },
    { time: 90, x: 90, y: 0 },
  ];
  let previous = -Infinity;
  for (let time = 0; time <= 90; time += 0.5) {
    const { x } = sampleCropCurve(samples, time);
    assert.ok(x >= previous - 1e-6, `never backs up: ${x} after ${previous} at ${time}`);
    previous = x;
  }
  // Across a sampled step the curve has no kink: velocity on each side
  // of the knot at t=40 agrees.
  const e = 0.01;
  const left = (sampleCropCurve(samples, 40).x - sampleCropCurve(samples, 40 - e).x) / e;
  const right = (sampleCropCurve(samples, 40 + e).x - sampleCropCurve(samples, 40).x) / e;
  assert.ok(Math.abs(left - right) < 0.05, `no kink: ${left} vs ${right}`);
});

test('the crop curve never overshoots a step, however uneven the timing', () => {
  // A burst then a pause then a burst — classic Catmull-Rom overshoot bait.
  const samples = [
    { time: 0, x: 0, y: 0 },
    { time: 2, x: 30, y: 0 },
    { time: 60, x: 31, y: 0 },
    { time: 62, x: 70, y: 0 },
  ];
  let previous = -Infinity;
  for (let time = 0; time <= 62; time += 0.25) {
    const { x } = sampleCropCurve(samples, time);
    assert.ok(x >= previous - 1e-9 && x <= 70 + 1e-9, `monotone: ${x} at ${time}`);
    previous = x;
  }
});
