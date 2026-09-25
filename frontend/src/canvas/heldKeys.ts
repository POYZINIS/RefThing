/**
 * Keys that pointer gestures read as modifiers but PointerEvent doesn't carry
 * (plan: Shift+Space + drag = snap-move). Tracked once, window-wide.
 */
const held = new Set<string>();
const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest('input, textarea, [contenteditable="true"]');

window.addEventListener('keydown', (event) => {
  if (typingTarget(event.target)) return;
  held.add(event.code);
  // Space is a board modifier here: never let it scroll the page or click a
  // focused toolbar button.
  if (event.code === 'Space') event.preventDefault();
});
window.addEventListener('keyup', (event) => held.delete(event.code));
window.addEventListener('blur', () => held.clear());

export const isHeld = (code: string): boolean => held.has(code);
