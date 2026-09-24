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
/** 1:1 aspect reset target (§3 RESET ASPECT RATIO). */
export const ACCENT = '#d6ff76';
