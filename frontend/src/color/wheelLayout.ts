/**
 * The colour wheel item's layout, in its own units (0…width, 0…height),
 * shared by the canvas painting (unselected) and the live DOM controls
 * (selected) so selecting it never shifts a thing:
 *
 *   [slider] (    wheel    )
 *   [harmony ▾] [HSV|HSL] [⚄]
 *   [■][■][■][■][■]           the current palette
 *   Palettes
 *   [■■■■■] …                 the saved ones, newest first (scrolls)
 */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * How much of the wheel shows at a size on screen (CSS px wide): everything;
 * the colour alone — the wheel with its handles as dots, the slider, the
 * palettes, no text or buttons; the same, painted only (nothing takes the
 * pointer, a press anywhere moves the item).
 */
export type WheelDetail = 'full' | 'compact' | 'minimal';
export const WHEEL_DETAIL_PX = { full: 300, compact: 170 };

export function wheelDetail(screenWidth: number): WheelDetail {
  if (screenWidth >= WHEEL_DETAIL_PX.full) return 'full';
  return screenWidth >= WHEEL_DETAIL_PX.compact ? 'compact' : 'minimal';
}

/** A handle drawn as a plain dot (compact and minimal detail), screen px. */
export const WHEEL_DOT_PX = 3.5;

export type WheelLayout = {
  slider: Rect;
  wheel: Rect;
  controls: Rect;
  /** The controls row's parts: the harmony picker, the HSV|HSL switch, the
   *  Random button (Lucide dice). */
  harmony: Rect;
  mode: Rect;
  random: Rect;
  swatches: Rect;
  libraryTitle: Rect;
  library: Rect;
  /** A saved palette row's height and the gap between rows. */
  rowHeight: number;
  rowGap: number;
  padding: number;
};

/** Corner radii as fractions of a strip's height (both faces use them). */
export const STRIP_RADIUS = 0.14;
export const ROW_RADIUS = 0.3;
export const FIELD_RADIUS = 0.28;
/** The panel's corner radius, a fraction of its width. */
export const PANEL_RADIUS = 0.04;

export function wheelLayout(width: number, height: number): WheelLayout {
  const padding = width * 0.05;
  const inner = width - padding * 2;
  const sliderWidth = inner * 0.07;
  const gap = inner * 0.05;
  const wheelSize = Math.min(inner - sliderWidth - gap, height * 0.46);
  const top = padding;
  const wheelX = padding + sliderWidth + gap + (inner - sliderWidth - gap - wheelSize) / 2;
  const controlsY = top + wheelSize + padding * 0.8;
  const controlsHeight = width * 0.085;
  const swatchesY = controlsY + controlsHeight + padding * 0.6;
  const swatchesHeight = width * 0.14;
  const titleY = swatchesY + swatchesHeight + padding * 0.7;
  const titleHeight = width * 0.055;
  const libraryY = titleY + titleHeight + padding * 0.3;
  const part = (from: number, share: number): Rect => ({
    x: padding + inner * from,
    y: controlsY,
    width: inner * share,
    height: controlsHeight,
  });
  return {
    padding,
    slider: { x: padding, y: top, width: sliderWidth, height: wheelSize },
    wheel: { x: wheelX, y: top, width: wheelSize, height: wheelSize },
    controls: { x: padding, y: controlsY, width: inner, height: controlsHeight },
    harmony: part(0, 0.56),
    mode: part(0.59, 0.27),
    random: part(0.89, 0.11),
    swatches: { x: padding, y: swatchesY, width: inner, height: swatchesHeight },
    libraryTitle: { x: padding, y: titleY, width: inner, height: titleHeight },
    library: {
      x: padding,
      y: libraryY,
      width: inner,
      height: Math.max(0, height - libraryY - padding),
    },
    rowHeight: width * 0.075,
    rowGap: width * 0.025,
  };
}
