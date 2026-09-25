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
/** §5 custom rotate cursor: a circular arrow, hotspot at its center. */
const ROTATE_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<g fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
  "<path d='M19 12a7 7 0 1 1-2.05-4.95' stroke='black' stroke-width='4'/>" +
  "<path d='M19 4v4h-4' stroke='black' stroke-width='4'/>" +
  "<path d='M19 12a7 7 0 1 1-2.05-4.95' stroke='white' stroke-width='2'/>" +
  "<path d='M19 4v4h-4' stroke='white' stroke-width='2'/></g></svg>";
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_CURSOR_SVG)}") 12 12, crosshair`;
