/**
 * Transform-shell math against the testing conventions: sampled canonical
 * paths (§1), per-sample assertions (§4), every zone × every modifier combo
 * (§3), failures report the sample index + time (§4 rule 4).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyToNode,
  beginAspectReset,
  beginFlip,
  beginMove,
  beginResize,
  beginRotate,
  boxCenter,
  FULL_CROP,
  finishAspectReset,
  hitZone,
  recrop,
  snapTranslate,
  stepGesture,
  toLocal,
  toWorld,
  zoneCursor,
  zonesCollapsed,
} from '../src/canvas/transform.ts';
import { at, figureEight, rotationSweep, sineWaveHandle } from './gesture-paths.mjs';

const near = (actual, expected, epsilon = 1e-6) =>
  Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected));

const ZONES = [
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
  'top',
  'bottom',
  'left',
  'right',
];
const MODIFIERS = [
  { shift: false, alt: false },
  { shift: true, alt: false },
  { shift: false, alt: true },
  { shift: true, alt: true },
];
const direction = (zone) => ({
  x: zone.includes('left') ? -1 : zone.includes('right') ? 1 : 0,
  y: zone.includes('top') ? -1 : zone.includes('bottom') ? 1 : 0,
});
const label = (mods) =>
  [mods.shift && 'Shift', mods.alt && 'Alt'].filter(Boolean).join('+') || 'none';

// ---------------------------------------------------------------- MOVE --

for (const zoom of [0.25, 1, 4]) {
  for (const variant of [
    { name: 'slow', durationMs: 2000, loops: 1 },
    { name: 'fast', durationMs: 200, loops: 1 },
    { name: '3-loop', durationMs: 6000, loops: 3 },
  ]) {
    test(`move: figure-8 ${variant.name} @ ${zoom * 100}% tracks displacement every sample`, () => {
      const center = { x: 400, y: 300 };
      const gesture = beginMove(center);
      const path = figureEight({
        centerX: center.x,
        centerY: center.y,
        amplitudeX: 240 / zoom,
        amplitudeY: 160 / zoom,
        durationMs: variant.durationMs,
        loops: variant.loops,
      });
      for (const sample of path) {
        const result = stepGesture(gesture, sample, { shift: false, alt: false }, zoom);
        assert.equal(result.kind, 'translate');
        assert.ok(near(result.dx, sample.x - center.x), at(sample, `dx ${result.dx}`));
        assert.ok(near(result.dy, sample.y - center.y), at(sample, `dy ${result.dy}`));
      }
    });
  }
}

test('move: Shift pressed mid-drag locks to the dominant axis, release frees it', () => {
  const start = { x: 0, y: 0 };
  const gesture = beginMove(start);
  const path = figureEight({
    centerX: 0,
    centerY: 0,
    amplitudeX: 300,
    amplitudeY: 100,
    durationMs: 2000,
  });
  const shiftFrom = 5;
  const shiftTo = 60;
  for (const sample of path) {
    const shift = sample.index >= shiftFrom && sample.index < shiftTo;
    const result = stepGesture(gesture, sample, { shift, alt: false }, 1);
    if (shift) {
      assert.equal(result.dy, 0, at(sample, 'x-locked drag moved vertically'));
    } else {
      assert.ok(near(result.dy, sample.y), at(sample, 'free drag lost the y delta'));
    }
  }
});

// -------------------------------------------------------------- RESIZE --

function resizeCase({ zone, mods, frequency, rotation, freeTransform, zoom }) {
  const box = { x: 100, y: 50, width: 200, height: 100, rotation };
  const dir = direction(zone);
  const corner = dir.x !== 0 && dir.y !== 0;
  // Grab 2px (screen) inside the zone, not dead-center on the handle line.
  const grabLocal = {
    x: dir.x * (box.width / 2) - dir.x * (2 / zoom),
    y: dir.y * (box.height / 2) - dir.y * (2 / zoom),
  };
  const press = toWorld(grabLocal, box);
  const gesture = beginResize(zone, box, press);
  // The sine path runs in the box's local frame (its axes are the zone's
  // axes), then maps to world for rotated boxes.
  const localPath = sineWaveHandle({
    startX: grabLocal.x,
    startY: grabLocal.y,
    deltaX: dir.x * 120,
    deltaY: dir.y * 70,
    zoneKind: corner ? 'corner' : 'edge',
    amplitude: 25,
    frequency,
    durationMs: 1000,
  });
  const proportional = freeTransform ? mods.shift : !mods.shift;
  const anchorLocal = mods.alt
    ? { x: 0, y: 0 }
    : { x: (-dir.x * box.width) / 2, y: (-dir.y * box.height) / 2 };
  const anchorWorld = toWorld(anchorLocal, box);
  for (const localSample of localPath) {
    const sample = { ...localSample, ...toWorld(localSample, box) };
    const result = stepGesture(gesture, sample, mods, zoom, freeTransform);
    assert.equal(result.kind, 'resize', at(sample, 'not a resize'));
    const next = result.to;
    assert.equal(next.rotation, rotation, at(sample, 'resize changed rotation'));
    // Single-node selection: distributing onto the node == the box result.
    const patch = applyToNode(result, box);
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(
        near(patch[key], next[key]),
        at(sample, `node ${key} ${patch[key]} != box ${next[key]}`),
      );
    }
    if (proportional) {
      const aspect = next.width / next.height;
      assert.ok(Math.abs(aspect / 2 - 1) < 0.005, at(sample, `aspect drifted to ${aspect}`));
    } else if (!corner) {
      // Edge stretch: the perpendicular dimension is bit-for-bit unchanged
      // despite the along-edge wobble.
      const perpendicular = dir.x !== 0 ? 'height' : 'width';
      assert.equal(next[perpendicular], box[perpendicular], at(sample, `${perpendicular} changed`));
    }
    // The modifier-determined anchor never moves in world space.
    const nextAnchorLocal = mods.alt
      ? { x: 0, y: 0 }
      : {
          x: (-dir.x * next.width) / 2,
          y: (-dir.y * next.height) / 2,
        };
    const nextAnchorWorld = toWorld(nextAnchorLocal, next);
    assert.ok(
      near(nextAnchorWorld.x, anchorWorld.x, 1e-6) && near(nextAnchorWorld.y, anchorWorld.y, 1e-6),
      at(sample, `anchor moved to (${nextAnchorWorld.x}, ${nextAnchorWorld.y})`),
    );
  }
  // No first-move jump: the handle stays under the grab point.
  const first = stepGesture(gesture, press, mods, zoom, freeTransform);
  assert.ok(near(first.to.width, box.width) && near(first.to.height, box.height), 'grab jump');
}

for (const kind of [
  { name: 'image', freeTransform: false },
  { name: 'note', freeTransform: true },
]) {
  for (const rotation of [0, 30]) {
    for (const zone of ZONES) {
      for (const mods of MODIFIERS) {
        for (const frequency of [1, 4]) {
          test(`resize ${kind.name} ${zone} [${label(mods)}] f=${frequency} rot=${rotation}`, () =>
            resizeCase({
              zone,
              mods,
              frequency,
              rotation,
              freeTransform: kind.freeTransform,
              zoom: 1,
            }));
        }
      }
    }
  }
}

for (const zoom of [0.25, 4]) {
  for (const zone of ZONES) {
    test(`resize image ${zone} @ ${zoom * 100}% keeps its anchor`, () =>
      resizeCase({
        zone,
        mods: MODIFIERS[0],
        frequency: 4,
        rotation: 0,
        freeTransform: false,
        zoom,
      }));
  }
}

test('resize: Shift toggled mid-gesture switches proportional ↔ stretch live', () => {
  const box = { x: 0, y: 0, width: 200, height: 100, rotation: 0 };
  const gesture = beginResize('right', box, { x: 200, y: 50 });
  const path = sineWaveHandle({
    startX: 200,
    startY: 50,
    deltaX: 100,
    deltaY: 0,
    zoneKind: 'edge',
    amplitude: 20,
    frequency: 4,
    durationMs: 1000,
  });
  for (const sample of path) {
    const shift = sample.index % 20 >= 10;
    const { to } = stepGesture(gesture, sample, { shift, alt: false }, 1, false);
    if (shift) assert.equal(to.height, 100, at(sample, 'Shift stretch changed height'));
    else assert.ok(near(to.width / to.height, 2), at(sample, 'proportional lost aspect'));
  }
});

test('resize: dragging through the 24px collapse size and back never sticks', () => {
  const box = { x: 0, y: 0, width: 200, height: 200, rotation: 0 };
  const gesture = beginResize('right', box, { x: 200, y: 100 });
  const shrink = sineWaveHandle({
    startX: 200,
    startY: 100,
    deltaX: -190,
    deltaY: 0,
    zoneKind: 'edge',
    amplitude: 10,
    frequency: 1,
    durationMs: 500,
  });
  const grow = sineWaveHandle({
    startX: 10,
    startY: 100,
    deltaX: 240,
    deltaY: 0,
    zoneKind: 'edge',
    amplitude: 10,
    frequency: 1,
    durationMs: 500,
  }).map((sample) => ({
    ...sample,
    index: sample.index + shrink.length,
    timeMs: sample.timeMs + 500,
  }));
  let collapsedSomewhere = false;
  let last = null;
  for (const sample of [...shrink, ...grow]) {
    const { to } = stepGesture(gesture, sample, { shift: true, alt: false }, 1, false);
    assert.ok(Number.isFinite(to.width) && to.width > 0, at(sample, `bad width ${to.width}`));
    if (zonesCollapsed(to, 1, 24)) collapsedSomewhere = true;
    last = to;
  }
  assert.ok(collapsedSomewhere, 'path never crossed the collapse size');
  assert.ok(near(last.width, 250), `ended at ${last.width}`);
  assert.equal(zonesCollapsed(last, 1, 24), false);
});

// -------------------------------------------------------------- ROTATE --

const rotateBox = { x: 0, y: 0, width: 200, height: 100, rotation: 0 };
const pivot = boxCenter(rotateBox);

for (const sweep of [90, 180, 270, 360, 720]) {
  for (const sign of [1, -1]) {
    test(`rotate: ${sign > 0 ? '+' : '-'}${sweep}° sweep accumulates monotonically`, () => {
      const path = rotationSweep({
        centerX: pivot.x,
        centerY: pivot.y,
        radius: 150,
        segments: [sign * sweep],
        durationMs: 2000,
      });
      const gesture = beginRotate(rotateBox, { x: pivot.x + 150, y: pivot.y });
      let previous = 0;
      for (const sample of path) {
        const result = stepGesture(gesture, sample, { shift: false, alt: false }, 1);
        assert.ok(
          near(result.delta, sample.angle, 1e-6),
          at(sample, `delta ${result.delta} != ${sample.angle}`),
        );
        assert.ok(sign * (result.delta - previous) >= 0, at(sample, 'rotation reversed/jumped'));
        previous = result.delta;
      }
      assert.ok(near(previous, sign * sweep, 1e-6));
    });
  }
}

test('rotate: Ctrl+Shift snaps exactly at every 45° crossing of a 360° sweep', () => {
  // 64 samples over 360° → every 8th sample lands exactly on a 45° multiple.
  const path = rotationSweep({
    centerX: pivot.x,
    centerY: pivot.y,
    radius: 150,
    segments: [360],
    durationMs: 64 * 16,
  });
  const gesture = beginRotate(rotateBox, { x: pivot.x + 150, y: pivot.y });
  let checked = 0;
  for (const sample of path) {
    const result = stepGesture(gesture, sample, { shift: true, alt: false }, 1);
    assert.ok(
      near(result.delta % 45, 0, 1e-9) || near(Math.abs(result.delta % 45), 45, 1e-9),
      at(sample, 'off-grid'),
    );
    const nearest = Math.round(sample.angle / 45) * 45;
    if (Math.abs(sample.angle - nearest) < 1e-9) {
      assert.ok(
        Math.abs(result.delta - nearest) < 0.1,
        at(sample, `at ${nearest}° got ${result.delta}`),
      );
      checked += 1;
    }
  }
  assert.equal(checked, 8, 'expected an assertion at each of 45…360°');
});

test('rotate: +180° then -180° in one held gesture tracks the reversal live', () => {
  const path = rotationSweep({
    centerX: pivot.x,
    centerY: pivot.y,
    radius: 150,
    segments: [180, -180],
    durationMs: 2000,
  });
  const gesture = beginRotate(rotateBox, { x: pivot.x + 150, y: pivot.y });
  for (const sample of path) {
    const result = stepGesture(gesture, sample, { shift: false, alt: false }, 1);
    assert.ok(
      near(result.delta, sample.angle, 1e-6),
      at(sample, `delta ${result.delta} != ${sample.angle}`),
    );
  }
});

test('rotate: a lone node spins in place (pivot = its own center)', () => {
  const gesture = beginRotate(rotateBox, { x: pivot.x + 150, y: pivot.y });
  const result = stepGesture(
    gesture,
    { x: pivot.x, y: pivot.y + 150 },
    { shift: false, alt: false },
    1,
  );
  const patch = applyToNode(result, rotateBox);
  assert.ok(near(patch.x, 0) && near(patch.y, 0) && near(patch.rotation, 90));
});

// ------------------------------------------------------- ASPECT RESET --

test('aspect reset: Alt+click squares the box keeping area and center', () => {
  const box = { x: 0, y: 0, width: 200, height: 50, rotation: 0 };
  const gesture = beginAspectReset(box, { x: 100, y: 25 });
  const result = finishAspectReset(gesture, { x: 101, y: 25 }, 1);
  assert.equal(result.kind, 'square');
  assert.ok(near(result.box.width, 100) && near(result.box.height, 100));
  assert.ok(near(boxCenter(result.box).x, 100) && near(boxCenter(result.box).y, 25));
});

test('aspect reset: travel past the 3px click epsilon is a drag, not a reset', () => {
  const box = { x: 0, y: 0, width: 200, height: 50, rotation: 0 };
  const gesture = beginAspectReset(box, { x: 100, y: 25 });
  assert.equal(finishAspectReset(gesture, { x: 104, y: 25 }, 1), null);
});

// ------------------------------------------------------------ HIT ZONES --

test('hit zones: corner wins over edge, body inside, null outside', () => {
  const box = { x: 0, y: 0, width: 100, height: 60, rotation: 0 };
  assert.equal(hitZone({ x: 0, y: 0 }, box, 8, 10), 'top-left');
  assert.equal(hitZone({ x: 4, y: 3 }, box, 8, 10), 'top-left');
  assert.equal(hitZone({ x: 50, y: 0 }, box, 8, 10), 'top');
  assert.equal(hitZone({ x: 100, y: 30 }, box, 8, 10), 'right');
  assert.equal(hitZone({ x: 50, y: 30 }, box, 8, 10), 'body');
  assert.equal(hitZone({ x: 200, y: 30 }, box, 8, 10), null);
});

test('hit zones rotate with the box, and so do the cursors', () => {
  const box = { x: 0, y: 0, width: 100, height: 60, rotation: 90 };
  // The local top edge sits to the right of center after a 90° CW turn.
  assert.equal(hitZone({ x: 50 + 30, y: 30 }, box, 8, 10), 'top');
  assert.equal(zoneCursor('top', 0), 'ns-resize');
  assert.equal(zoneCursor('top', 90), 'ew-resize');
  assert.equal(zoneCursor('top-left', -45), 'ew-resize');
});

test('zones collapse below 24px on screen', () => {
  const box = { x: 0, y: 0, width: 100, height: 20, rotation: 0 };
  assert.equal(zonesCollapsed(box, 1, 24), true);
  assert.equal(zonesCollapsed(box, 2, 24), false);
});

// ---------------------------------------------------- MULTI-SELECTION --

test('multi-select rotate turns every member about the shared pivot', () => {
  const a = { x: 0, y: 0, width: 10, height: 10, rotation: 0 };
  const selection = { x: 0, y: 0, width: 110, height: 10, rotation: 0 };
  const gesture = beginRotate(selection, { x: 155, y: 5 });
  const result = stepGesture(gesture, { x: 55, y: 105 }, { shift: false, alt: false }, 1);
  const patch = applyToNode(result, a);
  assert.ok(near(patch.rotation, 90));
  assert.ok(near(patch.x + 5, 55) && near(patch.y + 5, -45), JSON.stringify(patch));
});

test('multi-select resize scales member positions and sizes from the box anchor', () => {
  const a = { x: 0, y: 0, width: 10, height: 10, rotation: 0 };
  const b = { x: 100, y: 0, width: 10, height: 10, rotation: 0 };
  const from = { x: 0, y: 0, width: 110, height: 10, rotation: 0 };
  const to = { x: 0, y: 0, width: 220, height: 20, rotation: 0 };
  const pa = applyToNode({ kind: 'resize', from, to }, a);
  const pb = applyToNode({ kind: 'resize', from, to }, b);
  assert.deepEqual(
    [pa.x, pa.y, pa.width, pb.x, pb.y, pb.width].map((v) => Math.round(v * 1e6) / 1e6),
    [0, 0, 20, 200, 0, 20],
  );
});

test('local/world frame round-trips for rotated boxes', () => {
  const box = { x: 10, y: 20, width: 80, height: 40, rotation: 37 };
  const point = { x: 33, y: -12 };
  const back = toWorld(toLocal(point, box), box);
  assert.ok(near(back.x, point.x) && near(back.y, point.y));
});

// ---------------------------------------------------------------- FLIP --

test('flip: Alt+Shift drag waits for the click epsilon, then locks the drag axis', () => {
  const box = { x: 0, y: 0, width: 200, height: 100, rotation: 0 };
  const gesture = beginFlip(box, { x: 100, y: 50 });
  assert.equal(stepGesture(gesture, { x: 101, y: 51 }, { shift: true, alt: true }, 1), null);
  const flip = stepGesture(gesture, { x: 140, y: 60 }, { shift: true, alt: true }, 1);
  assert.deepEqual([flip.kind, flip.axis], ['flip', 'x']);
  // Once locked, a later vertical swing does not change the axis.
  const later = stepGesture(gesture, { x: 100, y: 300 }, { shift: true, alt: true }, 1);
  assert.equal(later.axis, 'x');
});

test('flip: a lone node mirrors in place (toggle flip, negate rotation)', () => {
  const node = { x: 0, y: 0, width: 200, height: 100, rotation: 30, flipX: false };
  const patch = applyToNode({ kind: 'flip', axis: 'x', center: boxCenter(node) }, node);
  assert.ok(near(patch.x, 0) && near(patch.y, 0));
  assert.equal(patch.rotation, -30);
  assert.equal(patch.flipX, true);
  const back = applyToNode(
    { kind: 'flip', axis: 'x', center: boxCenter(node) },
    { ...node, ...patch },
  );
  assert.equal(back.flipX, false, 'flipping twice restores');
  assert.equal(back.rotation, 30);
});

test('flip: a multi-selection mirrors positions across the shared center', () => {
  const left = { x: 0, y: 0, width: 10, height: 10, rotation: 0, flipY: false };
  const patch = applyToNode({ kind: 'flip', axis: 'y', center: { x: 50, y: 100 } }, left);
  assert.deepEqual([patch.x, patch.y, patch.flipY], [0, 190, true]);
});

// ------------------------------------------------------------ SNAPPING --

test('snap: edges and centers pull onto the nearest line per axis, with guides', () => {
  const moving = { left: 0, top: 0, right: 100, bottom: 50 };
  const target = { left: 205, top: 300, right: 305, bottom: 400 };
  // Moving right by 103 puts the right edge at 203 — 2px from target.left.
  const result = snapTranslate(moving, 103, 0, [target], 8);
  assert.equal(result.dx, 105, 'right edge snaps onto the target left edge');
  assert.equal(result.dy, 0, 'no y line within reach');
  assert.deepEqual(result.guides, [{ axis: 'x', at: 205, from: 0, to: 400 }]);
});

test('snap: centers align too, and nothing snaps outside the threshold', () => {
  const moving = { left: 0, top: 0, right: 100, bottom: 100 };
  const target = { left: 400, top: 0, right: 600, bottom: 90 };
  const centered = snapTranslate(moving, 0, -3, [target], 8);
  assert.equal(centered.dy, -5, 'moving center (50) snaps to target center (45)');
  const far = snapTranslate(moving, 0, 30, [target], 8);
  assert.deepEqual([far.dx, far.dy, far.guides.length], [0, 30, 0]);
});

test('snap: the closest candidate wins over the first one found', () => {
  const moving = { left: 0, top: 0, right: 10, bottom: 10 };
  const result = snapTranslate(
    moving,
    0,
    0,
    [
      { left: 16, top: 50, right: 30, bottom: 60 },
      { left: 13, top: 80, right: 20, bottom: 90 },
    ],
    8,
  );
  assert.equal(result.dx, 3, 'right edge 10 → 13 (3px) beats 10 → 16 (6px)');
});

// ---------------------------------------------------------------- CROP --

test('crop: pulling the right edge in trims the source; content stays put', () => {
  const from = { x: 0, y: 0, width: 200, height: 100, rotation: 0 };
  const to = { ...from, width: 150 };
  const { box, crop } = recrop(from, FULL_CROP, { x: false, y: false }, to);
  assert.deepEqual(box, to);
  assert.ok(near(crop.w, 0.75) && near(crop.x, 0) && near(crop.h, 1));
});

test('crop: the frame cannot grow past the image; uncropping restores it', () => {
  const from = { x: 50, y: 0, width: 150, height: 100, rotation: 0 };
  const crop = { x: 0.25, y: 0, w: 0.75, h: 1 }; // left quarter trimmed
  const grown = { x: -100, y: 0, width: 300, height: 100, rotation: 0 };
  const result = recrop(from, crop, { x: false, y: false }, grown);
  assert.ok(near(result.box.x, 0) && near(result.box.width, 200), JSON.stringify(result.box));
  assert.ok(near(result.crop.x, 0) && near(result.crop.w, 1));
});

test('crop: a flipped image trims the mirrored side of the source', () => {
  const from = { x: 0, y: 0, width: 200, height: 100, rotation: 0 };
  // Frame's right edge in → on a horizontally flipped image that is the
  // source's LEFT side.
  const { crop } = recrop(from, FULL_CROP, { x: true, y: false }, { ...from, width: 150 });
  assert.ok(near(crop.x, 0.25) && near(crop.w, 0.75), JSON.stringify(crop));
});

test('crop: rotated frames trim along their own axes', () => {
  const from = { x: 0, y: 0, width: 200, height: 100, rotation: 90 };
  const gesture = beginResize('bottom', from, toWorld({ x: 0, y: 50 }, from));
  const target = toWorld({ x: 0, y: 25 }, from); // bottom edge up by 25 (local)
  const resized = stepGesture(gesture, target, { shift: true, alt: false }, 1, false).to;
  const { box, crop } = recrop(from, FULL_CROP, { x: false, y: false }, resized);
  assert.ok(near(crop.h, 0.75) && near(crop.y, 0) && near(crop.w, 1), JSON.stringify(crop));
  // The top edge (anchor) did not move in world space.
  const topBefore = toWorld({ x: 0, y: -50 }, from);
  const topAfter = toWorld({ x: 0, y: -box.height / 2 }, box);
  assert.ok(near(topBefore.x, topAfter.x) && near(topBefore.y, topAfter.y));
});
