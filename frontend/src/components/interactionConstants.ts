/**
 * Interaction-conventions constants — Section 2 of
 * Refthing_interaction_conventions.txt. Canonical values, exactly one
 * source of truth. Never re-type these numbers in a component.
 *
 * All hit-zone sizes are screen-space px and must stay constant across
 * zoom levels (§0.6).
 */
export const EDGE_HIT_ZONE_PX = 8;
export const CORNER_HIT_ZONE_PX = 10;
export const CORNER_HANDLE_PX = 8;
export const HOVER_OUTLINE_OPACITY = 0.4;
export const HOVER_OUTLINE_PX = 1;
export const SELECTED_OUTLINE_PX = 1.5;
export const ACTIVE_EDGE_OUTLINE_PX = 2.5;
/** Minimum on-screen item size (either dimension) before the 8 transform
 * zones collapse to move/rotate-only (§2 minimum size collapse). */
export const MIN_SCREEN_SIZE_PX = 24;
/** Selection/hover accent colour — the design token (index.css @theme). */
export const ACCENT = 'var(--color-accent)';
/** §5 custom rotate cursor: Lucide's rotate-cw, white over a dark outline
 *  so it reads on any image; hotspot at its center. */
const ROTATE_PATHS = ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'];
const ROTATE_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='-2 -2 28 28'>" +
  "<g fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
  ROTATE_PATHS.map((d) => `<path d='${d}' stroke='black' stroke-width='4.5'/>`).join('') +
  ROTATE_PATHS.map((d) => `<path d='${d}' stroke='white' stroke-width='2'/>`).join('') +
  '</g></svg>';
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_CURSOR_SVG)}") 12 12, crosshair`;
