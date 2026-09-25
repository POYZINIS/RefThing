import { parse } from 'smol-toml';

/**
 * The control scheme as DATA (project plan: "CONTROL SCHEME AS CONFIG").
 * Every pointer press, double-click, key and gesture modifier is resolved
 * through this table; no input path hard-codes a button or a modifier.
 *
 * Override any entry by putting a `bindings.toml` with the same shape in the
 * RefThing data folder (served at GET /api/settings/bindings) — overrides
 * merge per action, so a file can rebind just one thing.
 */
export const DEFAULT_BINDINGS_TOML = `
# Gesture modifier ROLES, read live during a drag. A role is on while ALL its
# keys are held. "primary" = Ctrl (Cmd on macOS).
[gesture]
constrain = ["shift"]          # aspect toggle, 45deg rotate snap, axis-locked move
center = ["alt"]               # scale from the center
snap_move = ["shift", "space"] # snap to other nodes' edges/centers while moving

# Pointer presses. target: item (unselected node), empty (bare canvas),
# selection (body of the selection box), handle (one of its 8 zones), any.
# "optional" modifiers may be held without changing the action (they act as
# gesture roles instead). The most specific match wins.
[actions.pan]
button = "middle"
target = "any"
optional = ["shift", "alt", "primary"]

# Plan: "Z + drag - alternate zoom gesture" (drag right/up = zoom in,
# around the press point). Z is held, not typed.
[actions.drag_zoom]
button = "left"
modifiers = ["z"]
target = "any"

[actions.toggle_select]
button = "left"
modifiers = ["shift"]
target = "item"

[actions.move_item]
button = "left"
target = "item"

[actions.box_select]
button = "left"
target = "empty"
optional = ["shift"]

[actions.rotate]
button = "left"
modifiers = ["primary"]
target = ["selection", "handle"]
optional = ["shift"]

[actions.flip]
button = "left"
modifiers = ["alt", "shift"]
target = "selection"

[actions.reset_aspect]
button = "left"
modifiers = ["alt"]
target = "selection"

[actions.move_selection]
button = "left"
target = "selection"
optional = ["shift"]

[actions.scale]
button = "left"
target = "handle"
optional = ["shift", "alt"]

# Double-clicks, by what is under the pointer.
[double_click]
note = "enter_note_edit"
group = "drill_into_group"
item = "zoom_to_item"
empty = "zoom_to_fit"
# Phase 11: video/audio go Live (a player over the item); files open.
media = "play_media"
file = "open_file"

# Keyboard. "primary" = Ctrl/Cmd. "optional" keys may be held too (e.g.
# Shift = larger nudge step).
[keys.delete]
key = ["Delete", "Backspace"]

[keys.group]
key = "g"
modifiers = ["primary"]

[keys.ungroup]
key = "g"
modifiers = ["primary", "shift"]

[keys.select_all]
key = "a"
modifiers = ["primary"]

[keys.undo]
key = "z"
modifiers = ["primary"]

[keys.redo]
key = ["y", "Z"]
modifiers = ["primary"]
optional = ["shift"]

[keys.nudge_left]
key = "ArrowLeft"
optional = ["shift"]

[keys.nudge_right]
key = "ArrowRight"
optional = ["shift"]

[keys.nudge_up]
key = "ArrowUp"
optional = ["shift"]

[keys.nudge_down]
key = "ArrowDown"
optional = ["shift"]

[keys.escape]
key = "Escape"
`;

/** `space` and `z` are held keys (PointerEvent doesn't carry them). */
export type Modifier = 'shift' | 'alt' | 'primary' | 'space' | 'z';
export type PressTarget = 'item' | 'empty' | 'selection' | 'handle';
export type PressAction =
  | 'pan'
  | 'drag_zoom'
  | 'toggle_select'
  | 'move_item'
  | 'box_select'
  | 'rotate'
  | 'flip'
  | 'reset_aspect'
  | 'move_selection'
  | 'scale';
export type KeyAction =
  | 'delete'
  | 'group'
  | 'ungroup'
  | 'select_all'
  | 'undo'
  | 'redo'
  | 'nudge_left'
  | 'nudge_right'
  | 'nudge_up'
  | 'nudge_down'
  | 'escape';
export type DoubleClickTarget = 'note' | 'group' | 'item' | 'media' | 'file' | 'empty';

type PressBinding = {
  button: 'left' | 'middle' | 'right';
  modifiers: Modifier[];
  optional: Modifier[];
  targets: (PressTarget | 'any')[];
};
type KeyBinding = { keys: string[]; modifiers: Modifier[]; optional: Modifier[] };

export type Bindings = {
  gesture: { constrain: Modifier[]; center: Modifier[]; snapMove: Modifier[] };
  press: Partial<Record<PressAction, PressBinding>>;
  keys: Partial<Record<KeyAction, KeyBinding>>;
  doubleClick: Partial<Record<DoubleClickTarget, string>>;
};

const list = <T>(value: unknown): T[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as T[]) : [value as T];

type Raw = {
  gesture?: Record<string, unknown>;
  actions?: Record<string, Record<string, unknown>>;
  keys?: Record<string, Record<string, unknown>>;
  double_click?: Record<string, string>;
};

function build(raw: Raw): Bindings {
  const gesture = raw.gesture ?? {};
  const press: Bindings['press'] = {};
  for (const [name, entry] of Object.entries(raw.actions ?? {})) {
    press[name as PressAction] = {
      button: (entry.button as PressBinding['button']) ?? 'left',
      modifiers: list<Modifier>(entry.modifiers),
      optional: list<Modifier>(entry.optional),
      targets: list<PressTarget | 'any'>(entry.target ?? 'any'),
    };
  }
  const keys: Bindings['keys'] = {};
  for (const [name, entry] of Object.entries(raw.keys ?? {})) {
    keys[name as KeyAction] = {
      keys: list<string>(entry.key),
      modifiers: list<Modifier>(entry.modifiers),
      optional: list<Modifier>(entry.optional),
    };
  }
  return {
    gesture: {
      constrain: list<Modifier>(gesture.constrain),
      center: list<Modifier>(gesture.center),
      snapMove: list<Modifier>(gesture.snap_move),
    },
    press,
    keys,
    doubleClick: { ...(raw.double_click ?? {}) },
  };
}

/** Defaults merged with an override TOML, per action (not per file). */
export function loadBindings(overrideToml?: string | null): Bindings {
  const base = parse(DEFAULT_BINDINGS_TOML) as Raw;
  if (!overrideToml) return build(base);
  const override = parse(overrideToml) as Raw;
  return build({
    gesture: { ...base.gesture, ...override.gesture },
    actions: { ...base.actions, ...override.actions },
    keys: { ...base.keys, ...override.keys },
    double_click: { ...base.double_click, ...override.double_click },
  });
}

let active = loadBindings();

/** The bindings every input path reads. */
export const bindings = (): Bindings => active;

/** Apply a user override (bindings.toml). Invalid TOML keeps the current
 *  scheme and returns the parse error instead of throwing. */
export function applyBindingsOverride(toml: string | null): string | null {
  try {
    active = loadBindings(toml);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------- matching

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);

type ModifierEvent = { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean };

/** Is a physical key (KeyboardEvent.code) down right now? (heldKeys.ts) */
type KeyProbe = (code: string) => boolean;
const noKeys: KeyProbe = () => false;

/** The modifiers physically held, as binding names. `space` and `z` come
 *  from the held-key tracker (PointerEvent doesn't carry them). */
export function heldModifiers(event: ModifierEvent, keyDown: KeyProbe = noKeys): Set<Modifier> {
  const held = new Set<Modifier>();
  if (event.shiftKey) held.add('shift');
  if (event.altKey) held.add('alt');
  if (isMac ? event.metaKey : event.ctrlKey) held.add('primary');
  if (keyDown('Space')) held.add('space');
  if (keyDown('KeyZ')) held.add('z');
  return held;
}

/** Required modifiers all held, and nothing held beyond required+optional. */
function modifiersMatch(held: Set<Modifier>, required: Modifier[], optional: Modifier[]) {
  if (!required.every((modifier) => held.has(modifier))) return false;
  const allowed = new Set([...required, ...optional, 'space' as Modifier]);
  return [...held].every((modifier) => allowed.has(modifier));
}

const BUTTONS: Record<number, PressBinding['button']> = { 0: 'left', 1: 'middle', 2: 'right' };

/** What a pointer press means. The most specific match (most required
 *  modifiers, then an exact target over `any`) wins; null = nothing. */
export function resolvePress(
  button: number,
  held: Set<Modifier>,
  target: PressTarget,
  table: Bindings = active,
): PressAction | null {
  let best: { action: PressAction; score: number } | null = null;
  for (const [action, binding] of Object.entries(table.press) as [PressAction, PressBinding][]) {
    if (BUTTONS[button] !== binding.button) continue;
    const exact = binding.targets.includes(target);
    if (!exact && !binding.targets.includes('any')) continue;
    if (!modifiersMatch(held, binding.modifiers, binding.optional)) continue;
    const score = binding.modifiers.length * 2 + (exact ? 1 : 0);
    if (!best || score > best.score) best = { action, score };
  }
  return best?.action ?? null;
}

/** The keyboard action for a keydown, or null. */
export function resolveKey(
  event: ModifierEvent & { key: string },
  table: Bindings = active,
): KeyAction | null {
  const held = heldModifiers(event);
  let best: { action: KeyAction; score: number } | null = null;
  for (const [action, binding] of Object.entries(table.keys) as [KeyAction, KeyBinding][]) {
    const keyMatches = binding.keys.some(
      (key) =>
        key === event.key || (key.length === 1 && key.toLowerCase() === event.key.toLowerCase()),
    );
    if (!keyMatches || !modifiersMatch(held, binding.modifiers, binding.optional)) continue;
    // Exact-case single keys ("Z" = Shift+z) beat case-insensitive ones.
    const score = binding.modifiers.length * 2 + (binding.keys.includes(event.key) ? 1 : 0);
    if (!best || score > best.score) best = { action, score };
  }
  return best?.action ?? null;
}

/** Gesture roles for a pointer sample (see transform.ts Modifiers). */
export function gestureRoles(
  event: ModifierEvent,
  keyDown: KeyProbe = noKeys,
  table: Bindings = active,
): { constrain: boolean; center: boolean; snap: boolean } {
  const held = heldModifiers(event, keyDown);
  const on = (keys: Modifier[]) => keys.length > 0 && keys.every((key) => held.has(key));
  const snap = on(table.gesture.snapMove);
  return { constrain: on(table.gesture.constrain), center: on(table.gesture.center), snap };
}
