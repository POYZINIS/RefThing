/** Keyboard bindings are data so another control preset can reuse the dispatcher. */
export const keyboardBindings = [
  { action: 'delete', keys: ['Delete', 'Backspace'] },
  { action: 'group', keys: ['g'], primary: true },
  { action: 'ungroup', keys: ['g'], primary: true, shift: true },
  { action: 'selectAll', keys: ['a'], primary: true },
  { action: 'undo', keys: ['z'], primary: true },
  { action: 'redo', keys: ['z'], primary: true, shift: true },
  { action: 'redo', keys: ['y'], primary: true },
  { action: 'nudgeLeft', keys: ['ArrowLeft'], shift: 'either' },
  { action: 'nudgeRight', keys: ['ArrowRight'], shift: 'either' },
  { action: 'nudgeUp', keys: ['ArrowUp'], shift: 'either' },
  { action: 'nudgeDown', keys: ['ArrowDown'], shift: 'either' },
  { action: 'escape', keys: ['Escape'] },
] as const;

type Binding = {
  action: string;
  keys: readonly string[];
  primary?: boolean;
  shift?: boolean | 'either';
};

export function keyboardAction(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): string | null {
  if (event.altKey) return null;
  const binding = (keyboardBindings as readonly Binding[]).find(
    (binding) =>
      binding.keys.some((key) => key.toLowerCase() === event.key.toLowerCase()) &&
      !!binding.primary === (event.ctrlKey || event.metaKey) &&
      (binding.shift === 'either' || !!binding.shift === event.shiftKey),
  );
  return binding?.action ?? null;
}
