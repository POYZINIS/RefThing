import { animate } from 'animejs/animation';

/**
 * UI-chrome motion (plan Phase 10: anime.js transitions). Chrome only — menus,
 * dialogs, banners. The board and its selection shell never animate: they
 * must track the pointer exactly (interaction conventions §1). Short, and off
 * entirely when the OS asks for reduced motion.
 */
type Kind = 'pop' | 'rise';

const presets: Record<Kind, Parameters<typeof animate>[1]> = {
  // Context menus: grow from the pointer corner.
  pop: { opacity: [0, 1], scale: [0.96, 1], duration: 120, ease: 'outQuad' },
  // Dialogs and banners: settle in from slightly below.
  rise: { opacity: [0, 1], translateY: [6, 0], duration: 180, ease: 'outCubic' },
};

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Play an enter transition on an element (use as / from a ref callback). */
export function enter(element: Element | null, kind: Kind): void {
  if (!element || reducedMotion()) return;
  animate(element, presets[kind]);
}
