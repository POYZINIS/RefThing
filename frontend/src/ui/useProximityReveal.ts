import { type RefObject, useEffect, useState } from 'react';

/** How close (px) the pointer must come to a hidden group to reveal it. */
export const REVEAL_DISTANCE_PX = 56;
/** Grace before a revealed control fades once the pointer leaves: just
 *  enough to ride out a pointer skimming the edge of its zone. */
const HIDE_DELAY_MS = 90;

const canHover = () =>
  typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

/**
 * Auto-hiding chrome: true while the pointer is within `REVEAL_DISTANCE_PX`
 * of `element` (or `pinned` holds — an open panel, keyboard focus inside).
 * While a button is held (a drag on the board) nothing new reveals, so a
 * gesture passing the corner doesn't flash the chrome. Devices without
 * hover always show it.
 */
export function useProximityReveal(
  element: RefObject<HTMLElement | null>,
  pinned: boolean,
  distance = REVEAL_DISTANCE_PX,
): boolean {
  const [near, setNear] = useState(false);
  const hoverless = !canHover();

  useEffect(() => {
    if (hoverless) return;
    let frame = 0;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let last: PointerEvent | null = null;
    let current = false;
    const set = (next: boolean) => {
      if (next) {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = null;
        if (!current) setNear(true);
        current = true;
      } else if (current && !hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          current = false;
          setNear(false);
        }, HIDE_DELAY_MS);
      }
    };
    const check = () => {
      frame = 0;
      const rect = element.current?.getBoundingClientRect();
      if (!rect || !last) return;
      const dx = Math.max(rect.left - last.clientX, 0, last.clientX - rect.right);
      const dy = Math.max(rect.top - last.clientY, 0, last.clientY - rect.bottom);
      const inside = Math.hypot(dx, dy) <= distance;
      // Mid-drag: keep what's showing, reveal nothing new.
      if (last.buttons !== 0 && !current) return;
      set(inside);
    };
    const onMove = (event: PointerEvent) => {
      last = event;
      if (!frame) frame = requestAnimationFrame(check);
    };
    // Leaving the window (or the webview) hides everything.
    const onLeave = () => set(false);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [element, hoverless, distance]);

  return hoverless || pinned || near;
}
