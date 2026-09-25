import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gestureRoles,
  heldModifiers,
  loadBindings,
  resolveKey,
  resolvePress,
} from '../src/canvas/bindings.ts';

const defaults = loadBindings();
const mods = (...names) => new Set(names);
const ev = (over = {}) => ({
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

test('default presses reproduce the interaction conventions', () => {
  const cases = [
    [1, [], 'item', 'pan'],
    [1, ['shift'], 'selection', 'pan'],
    [0, [], 'item', 'move_item'],
    [0, ['shift'], 'item', 'toggle_select'],
    [0, [], 'empty', 'box_select'],
    [0, [], 'selection', 'move_selection'],
    [0, ['shift'], 'selection', 'move_selection'], // Shift = axis lock role
    [0, ['primary'], 'selection', 'rotate'],
    [0, ['primary', 'shift'], 'handle', 'rotate'], // Ctrl wins over a handle
    [0, ['alt'], 'selection', 'reset_aspect'],
    [0, ['alt', 'shift'], 'selection', 'flip'],
    [0, [], 'handle', 'scale'],
    [0, ['shift', 'alt'], 'handle', 'scale'],
    [2, [], 'item', null], // right button is the context menu, not a press
    [0, ['primary'], 'item', null], // no binding: ignored rather than guessed
  ];
  for (const [button, held, target, expected] of cases) {
    assert.equal(
      resolvePress(button, mods(...held), target, defaults),
      expected,
      `button ${button} [${held}] on ${target}`,
    );
  }
});

test('Z + drag is the alternate zoom on any target', () => {
  for (const target of ['item', 'empty', 'selection', 'handle']) {
    assert.equal(resolvePress(0, mods('z'), target, defaults), 'drag_zoom', target);
  }
  assert.deepEqual([...heldModifiers(ev(), (code) => code === 'KeyZ')], ['z']);
});

test('Space is always allowed (it is the snap-move role, not a press modifier)', () => {
  assert.equal(resolvePress(0, mods('shift', 'space'), 'selection', defaults), 'move_selection');
});

test('default keys', () => {
  const key = (k, over) => resolveKey({ ...ev(over), key: k }, defaults);
  assert.equal(key('Delete'), 'delete');
  assert.equal(key('g', { ctrlKey: true }), 'group');
  assert.equal(key('G', { ctrlKey: true, shiftKey: true }), 'ungroup');
  assert.equal(key('z', { ctrlKey: true }), 'undo');
  assert.equal(key('Z', { ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(key('y', { ctrlKey: true }), 'redo');
  assert.equal(key('a', { ctrlKey: true }), 'select_all');
  assert.equal(key('ArrowLeft', { shiftKey: true }), 'nudge_left');
  assert.equal(key('a'), null, 'a bare letter does nothing');
  assert.equal(key('z', { ctrlKey: true, altKey: true }), null, 'extra modifiers never match');
});

test('gesture roles follow the table, and an override rebinds them everywhere', () => {
  assert.deepEqual(
    gestureRoles(ev({ shiftKey: true }), () => false, defaults),
    {
      constrain: true,
      center: false,
      snap: false,
    },
  );
  assert.equal(
    gestureRoles(ev({ shiftKey: true }), (code) => code === 'Space', defaults).snap,
    true,
  );
  const custom = loadBindings(`
[gesture]
center = ["shift"]
constrain = ["alt"]

[actions.flip]
button = "left"
modifiers = ["primary", "alt"]
target = "selection"

[keys.undo]
key = "u"
`);
  assert.deepEqual(
    gestureRoles(ev({ shiftKey: true }), () => false, custom),
    {
      constrain: false,
      center: true,
      snap: false,
    },
  );
  assert.equal(resolvePress(0, mods('primary', 'alt'), 'selection', custom), 'flip');
  assert.equal(resolveKey({ ...ev(), key: 'u' }, custom), 'undo');
  assert.equal(
    resolveKey({ ...ev(), key: 'Delete' }, custom),
    'delete',
    'untouched entries remain',
  );
  assert.deepEqual([...heldModifiers(ev({ ctrlKey: true }))], ['primary']);
});
