/**
 * Colour harmony (pure, unit-tested): conversions between hex / HSV / HSL
 * and the rules the colour wheel offers, after Adobe Color. A harmony is
 * five colours with the base in the middle (index 2), as Adobe shows it.
 * Hues are degrees (0–360); saturation, value and lightness are 0–1.
 */

export type Hsv = { h: number; s: number; v: number };
export type Hsl = { h: number; s: number; l: number };

export const HARMONIES = [
  'analogous',
  'monochromatic',
  'triad',
  'complementary',
  'split-complementary',
  'square',
  'compound',
  'shades',
  'tetrad',
] as const;
export type Harmony = (typeof HARMONIES)[number];

export const HARMONY_LABELS: Record<Harmony, string> = {
  analogous: 'Analogous',
  monochromatic: 'Monochromatic',
  triad: 'Triad',
  complementary: 'Complementary',
  'split-complementary': 'Split complementary',
  square: 'Square',
  compound: 'Compound',
  shades: 'Shades',
  tetrad: 'Tetrad',
};

/** The base colour's slot in a five-colour harmony. */
export const BASE_INDEX = 2;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const wrapHue = (hue: number) => ((hue % 360) + 360) % 360;

// ------------------------------------------------------------ conversions

/** `#rrggbb` (or `#rgb`) → 0–255 channels; null when not a colour. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1] ?? '';
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  const value = Number.parseInt(digits, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const byte = (channel: number) =>
    Math.round(Math.min(255, Math.max(0, channel)))
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = wrapHue(h) / 60;
  const chroma = clamp01(v) * clamp01(s);
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = clamp01(v) - chroma;
  const [r, g, b] =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

export function hexToHsv(hex: string): Hsv {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h: wrapHue(h), s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHsl({ h, s, v }: Hsv): Hsl {
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s: clamp01(sl), l: clamp01(l) };
}

export function hslToHsv({ h, s, l }: Hsl): Hsv {
  const v = l + s * Math.min(l, 1 - l);
  return { h, s: v === 0 ? 0 : clamp01(2 * (1 - l / v)), v: clamp01(v) };
}

/** Relative luminance (sRGB), 0–1: for picking readable text on a swatch. */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

// --------------------------------------------------------------- harmonies

/** A hue turned by `degrees`, with an optional saturation / value tweak. */
function turn(base: Hsv, degrees: number, sScale = 1, vScale = 1): Hsv {
  return { h: wrapHue(base.h + degrees), s: clamp01(base.s * sScale), v: clamp01(base.v * vScale) };
}

/** A lighter-or-darker sibling that stays inside the range (never clips to
 *  black or white): darker when the colour is bright, lighter when dark. */
function sibling(base: Hsv, degrees: number): Hsv {
  const v = base.v > 0.5 ? base.v * 0.62 : Math.min(1, base.v + 0.35);
  return { h: wrapHue(base.h + degrees), s: clamp01(base.s * 0.85), v: clamp01(v) };
}

/**
 * Five colours for `harmony` around `base`, base at index 2:
 * - analogous: neighbours at ±30° and ±60°;
 * - monochromatic: the base hue at other saturations / values;
 * - triad: the hues a third of the wheel apart (0°, 120°, 240°);
 * - complementary: the base and its opposite (180°), with siblings;
 * - split complementary: the base and the two hues beside its opposite
 *   (150°, 210°);
 * - square: four hues a quarter apart (0°, 90°, 180°, 270°);
 * - compound: an analogous neighbour (30°) and a near-complement pair
 *   (165°, 195°);
 * - shades: the base hue and saturation at five values;
 * - tetrad (rectangle): two complementary pairs, 60° apart (0°, 60°, 180°,
 *   240°).
 */
export function harmonize(base: Hsv, harmony: Harmony): Hsv[] {
  switch (harmony) {
    case 'analogous':
      return [turn(base, -60), turn(base, -30), base, turn(base, 30), turn(base, 60)];
    case 'monochromatic':
      return [
        turn(base, 0, 1, 0.45),
        turn(base, 0, 0.45, 1.1),
        base,
        turn(base, 0, 0.7, 0.72),
        turn(base, 0, 0.25, 1.15),
      ];
    case 'triad':
      return [sibling(base, 120), turn(base, 120), base, turn(base, 240), sibling(base, 240)];
    case 'complementary':
      return [
        sibling(base, 0),
        turn(base, 0, 0.55, 1.1),
        base,
        turn(base, 180),
        sibling(base, 180),
      ];
    case 'split-complementary':
      return [sibling(base, 150), turn(base, 150), base, turn(base, 210), sibling(base, 210)];
    case 'square':
      return [turn(base, 90), turn(base, 180), base, turn(base, 270), sibling(base, 0)];
    case 'compound':
      return [sibling(base, 30), turn(base, 30), base, turn(base, 165), sibling(base, 195)];
    case 'shades':
      return [
        turn(base, 0, 1, 0.3),
        turn(base, 0, 1, 0.55),
        base,
        turn(base, 0, 1, 0.8),
        { h: base.h, s: base.s, v: clamp01(base.v * 0.8 + 0.2) },
      ];
    case 'tetrad':
      return [turn(base, 60), turn(base, 180), base, turn(base, 240), sibling(base, 60)];
  }
}

export const harmonyHexes = (base: Hsv, harmony: Harmony) => harmonize(base, harmony).map(hsvToHex);

/** The colour at `index` moved to `moved` re-bases the harmony (dragging
 *  any handle turns the whole set, as in Adobe Color). */
export function rebase(base: Hsv, harmony: Harmony, index: number, moved: Hsv): Hsv {
  if (index === BASE_INDEX) return moved;
  const before = harmonize(base, harmony)[index];
  if (!before) return moved;
  // Keep the dragged colour's offset from the base; carry its saturation
  // and value change over to the base proportionally.
  const hueOffset = before.h - base.h;
  return {
    h: wrapHue(moved.h - hueOffset),
    s: before.s > 0 ? clamp01((moved.s / before.s) * base.s) : moved.s,
    v: before.v > 0 ? clamp01((moved.v / before.v) * base.v) : moved.v,
  };
}

// ------------------------------------------------------------------ random

/** A random palette: a random harmony around a random base, kept inside
 *  pleasant saturation / value bands, with one dark and one light anchor
 *  so the five read as a usable set (not five mid-tones). */
export function randomPalette(random: () => number = Math.random): {
  base: Hsv;
  harmony: Harmony;
  colors: string[];
} {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const harmony = pick(HARMONIES);
  const base: Hsv = { h: random() * 360, s: 0.4 + random() * 0.4, v: 0.45 + random() * 0.45 };
  const colors = harmonize(base, harmony).map((color) => ({
    h: color.h,
    s: Math.min(0.85, Math.max(0.3, color.s)),
    v: Math.min(0.92, Math.max(0.3, color.v)),
  }));
  // Anchors on the outer slots: a deep one and a pale one.
  const dark = colors[0];
  if (dark) colors[0] = { h: dark.h, s: Math.min(0.9, dark.s + 0.1), v: 0.18 + random() * 0.12 };
  const light = colors[4];
  if (light) colors[4] = { h: light.h, s: 0.08 + random() * 0.12, v: 0.9 + random() * 0.07 };
  return { base, harmony, colors: colors.map(hsvToHex) };
}
