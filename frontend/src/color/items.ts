/**
 * The colour items (pure, unit-tested): palettes and the colour wheel are
 * board items with no blob — everything they are lives in their metadata,
 * merge-patched like any item's:
 * - `palette`:    `{ palette: { colors: ['#rrggbb', …] } }`
 * - `colorwheel`: `{ colorwheel: { base, harmony, mode, library } }` — the
 *   picker's state and the saved palettes (newest first), so they save and
 *   export with the board.
 * They're created with `restore_item` ops (an item with its identity), so
 * adding one is an undo step like any other.
 */
import type { Item } from '@/api/client';
import {
  BASE_INDEX,
  HARMONIES,
  type Harmony,
  type Hsv,
  harmonize,
  hexToHsv,
  hsvToHex,
} from './harmony';

export const PALETTE_TYPE = 'palette';
export const WHEEL_TYPE = 'colorwheel';
const TOOL_TYPES = new Set([PALETTE_TYPE, WHEEL_TYPE]);

/** Items the board draws: anything with a blob, and the blob-less tools. */
export const isBoardItem = (item: Pick<Item, 'blob_hash' | 'type'>) =>
  !!item.blob_hash || TOOL_TYPES.has(item.type);

/** A palette swatch's size at arrival, screen px; its height is 7/9 of
 *  that — the proportions of the colour wheel's own palette strip. */
export const SWATCH_PX = 64;
export const PALETTE_ASPECT = 7 / 9;
/** The colour wheel's size at arrival, screen px. */
export const WHEEL_SIZE = { width: 340, height: 520 };

export type WheelMode = 'hsv' | 'hsl';
export type WheelState = {
  /** The base colour (the harmony's middle swatch). */
  base: string;
  harmony: Harmony;
  /** The brightness slider: HSV value, or HSL lightness (extends to white). */
  mode: WheelMode;
  /** The current five (the harmony of `base`, or a random palette). */
  colors: string[];
  /** The same five as exact HSV — where the handles sit. Hex can't carry
   *  that (near black, 8-bit channels make hue and saturation jump), so
   *  the wheel keeps both; points that no longer match `colors` (an older
   *  save, or a patch that set only colours) are rebuilt from them. */
  points: Hsv[];
  /** Saved palettes, newest first. */
  library: string[][];
};

const DEFAULT_POINTS = harmonize(hexToHsv('#3b82c4'), 'analogous');

export const DEFAULT_WHEEL: WheelState = {
  base: '#3b82c4',
  harmony: 'analogous',
  mode: 'hsv',
  colors: DEFAULT_POINTS.map(hsvToHex),
  points: DEFAULT_POINTS,
  library: [],
};

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Stored points, when they're five valid HSV points that still match
 *  `colors`; otherwise the colours' own. */
function wheelPoints(raw: unknown, colors: string[]): Hsv[] {
  if (Array.isArray(raw) && raw.length === colors.length) {
    const points = raw.map((point) => {
      const { h, s, v } = (point ?? {}) as Record<string, unknown>;
      return typeof h === 'number' && Number.isFinite(h) && isUnit(s) && isUnit(v)
        ? { h: ((h % 360) + 360) % 360, s, v }
        : null;
    });
    if (points.every((point, index) => point && hsvToHex(point) === colors[index])) {
      return points as Hsv[];
    }
  }
  return colors.map(hexToHsv);
}

/** The wheel's base as exact HSV. */
export const wheelBase = (wheel: WheelState): Hsv =>
  wheel.points[BASE_INDEX] ?? hexToHsv(wheel.base);

const HEX = /^#[0-9a-f]{6}$/;
const isHex = (value: unknown): value is string =>
  typeof value === 'string' && HEX.test(value.toLowerCase());
const hexList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(isHex).map((hex) => hex.toLowerCase()) : [];

/** A palette item's colours (validated; none when malformed). */
export function paletteColors(metadata: Record<string, unknown>): string[] {
  const palette = metadata.palette as { colors?: unknown } | undefined;
  return hexList(palette?.colors);
}

/** A colour wheel item's state (validated field by field). */
export function wheelState(metadata: Record<string, unknown>): WheelState {
  const raw = (metadata.colorwheel ?? {}) as Record<string, unknown>;
  const base = isHex(raw.base) ? raw.base.toLowerCase() : DEFAULT_WHEEL.base;
  const harmony = HARMONIES.includes(raw.harmony as Harmony)
    ? (raw.harmony as Harmony)
    : DEFAULT_WHEEL.harmony;
  const stored = hexList(raw.colors);
  const colors = stored.length === 5 ? stored : harmonize(hexToHsv(base), harmony).map(hsvToHex);
  return {
    base,
    harmony,
    mode: raw.mode === 'hsl' ? 'hsl' : 'hsv',
    colors,
    points: wheelPoints(raw.points, colors),
    library: Array.isArray(raw.library)
      ? raw.library.map(hexList).filter((colors) => colors.length > 0)
      : [],
  };
}

/** A new blob-less item, ready for a `restore_item` op. */
export function toolItem(fields: {
  id: string;
  boardId: string;
  type: typeof PALETTE_TYPE | typeof WHEEL_TYPE;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  metadata: Record<string, unknown>;
  now?: number;
}): Item {
  const now = fields.now ?? Date.now();
  return {
    id: fields.id,
    board_id: fields.boardId,
    type: fields.type,
    blob_hash: null,
    x: fields.x,
    y: fields.y,
    width: fields.width,
    height: fields.height,
    rotation: 0,
    z_index: fields.zIndex,
    group_id: null,
    metadata: fields.metadata,
    created_at: now,
    updated_at: now,
  };
}

/** World size of a palette of `count` swatches at `zoom` (camera-relative:
 *  the same size on screen at any zoom). */
export function paletteSize(count: number, zoom: number): { width: number; height: number } {
  const swatch = SWATCH_PX / (zoom > 0 ? zoom : 1);
  return { width: swatch * Math.max(1, count), height: swatch * PALETTE_ASPECT };
}

type Box = { x: number; y: number; width: number; height: number; rotation: number };

/** Which swatch of a palette box a world point is on (null: outside). */
export function swatchAt(box: Box, count: number, point: { x: number; y: number }): number | null {
  if (count <= 0) return null;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radians = (-box.rotation * Math.PI) / 180;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians) + box.width / 2;
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians) + box.height / 2;
  if (localX < 0 || localY < 0 || localX > box.width || localY > box.height) return null;
  return Math.min(count - 1, Math.floor((localX / box.width) * count));
}

/** Where a swatch's centre is, in world coordinates. */
export function swatchCenter(box: Box, count: number, index: number): { x: number; y: number } {
  const localX = ((index + 0.5) / count - 0.5) * box.width;
  const radians = (box.rotation * Math.PI) / 180;
  return {
    x: box.x + box.width / 2 + localX * Math.cos(radians),
    y: box.y + box.height / 2 + localX * Math.sin(radians),
  };
}

export type PaletteBox = Box & { id: string; colors: string[] };

/**
 * Palettes join end to end: a palette released with an end near another's
 * (its left edge on the other's right, or its right on the other's left,
 * rows overlapping) joins it. Returns the palette that grows, the side
 * the moved colours land on, and its new box — or null.
 */
export function joinTarget(
  moved: PaletteBox,
  others: readonly PaletteBox[],
  tolerance: number,
): { target: PaletteBox; side: 'left' | 'right'; box: Box; colors: string[] } | null {
  if (moved.rotation !== 0) return null;
  let best: { target: PaletteBox; side: 'left' | 'right'; gap: number } | null = null;
  for (const other of others) {
    if (other.id === moved.id || other.rotation !== 0 || other.colors.length === 0) continue;
    const overlap =
      Math.min(moved.y + moved.height, other.y + other.height) - Math.max(moved.y, other.y);
    if (overlap < Math.min(moved.height, other.height) * 0.5) continue;
    const rightGap = Math.abs(moved.x - (other.x + other.width));
    const leftGap = Math.abs(moved.x + moved.width - other.x);
    if (rightGap <= tolerance && (!best || rightGap < best.gap)) {
      best = { target: other, side: 'right', gap: rightGap };
    }
    if (leftGap <= tolerance && (!best || leftGap < best.gap)) {
      best = { target: other, side: 'left', gap: leftGap };
    }
  }
  if (!best) return null;
  const { target, side } = best;
  // The joined palette keeps the target's swatch size.
  const swatch = target.width / target.colors.length;
  const colors =
    side === 'right' ? [...target.colors, ...moved.colors] : [...moved.colors, ...target.colors];
  const width = swatch * colors.length;
  const x = side === 'right' ? target.x : target.x - swatch * moved.colors.length;
  return {
    target,
    side,
    colors,
    box: { x, y: target.y, width, height: target.height, rotation: 0 },
  };
}
