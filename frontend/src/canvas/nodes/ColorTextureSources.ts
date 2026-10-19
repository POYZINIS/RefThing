import { Texture } from 'pixi.js';
import { BASE_INDEX, HARMONY_LABELS, hsvToHex, hsvToHsl } from '@/color/harmony';
import { type WheelState, wheelBase } from '@/color/items';
import {
  FIELD_RADIUS,
  PANEL_RADIUS,
  type Rect,
  ROW_RADIUS,
  STRIP_RADIUS,
  WHEEL_DOT_PX,
  type WheelDetail,
  wheelDetail,
  wheelLayout,
} from '@/color/wheelLayout';
import { fitLine } from './CardTextureSource';
import { NOTE_FONT_FAMILY } from './noteText';
import type { TextureSource } from './TextureSource';
import type { SpriteNode } from './types';

const MAX_TEXTURE_PX = 4096;
const font = (px: number, weight = 500) => `${weight} ${px}px ${NOTE_FONT_FAMILY}`;

/** How opaque the wheel's glass is (index.css `--tool-bg` mixes the same). */
export const TOOL_GLASS_ALPHA = 0.76;

/**
 * The wheel's face is chrome glass, like the menus and corner groups: the
 * theme's panel tint, rim and text. Unselected, the canvas paints it
 * translucent over the board; selected, the live panel adds the real blur.
 */
type ToolTheme = {
  key: string;
  panel: string;
  alpha: number;
  edge: string;
  text: string;
  muted: string;
  field: string;
  accent: string;
  /** The raised shadow pair: highlight up-left (--tool-hi), shadow down-right. */
  shadeHi: string;
  shadeLo: string;
  /** A recessed well's inner light (the chrome's own, fainter). */
  wellHi: string;
};

let theme: ToolTheme | null = null;
function toolTheme(): ToolTheme {
  const root = document.documentElement;
  const key = `${root.dataset.theme ?? ''}|${root.dataset.glass ?? ''}`;
  if (theme?.key === key) return theme;
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  theme = {
    key,
    panel: read('--panel-solid', '#262c38'),
    alpha: root.dataset.glass === 'off' ? 1 : TOOL_GLASS_ALPHA,
    edge: read('--panel-edge', 'rgb(255 255 255 / 18%)'),
    text: read('--color-text', '#cfd8e6'),
    muted: read('--color-text-muted', '#a3aec2'),
    field: read('--field-bg', 'rgb(0 0 0 / 20%)'),
    accent: read('--color-accent', '#8fb4ec'),
    shadeHi: read('--tool-hi', 'rgb(255 255 255 / 11%)'),
    shadeLo: read('--shade-lo', 'rgb(0 0 0 / 42%)'),
    wellHi: read('--shade-hi', 'rgb(255 255 255 / 4%)'),
  };
  return theme;
}

type Entry = { key: string; texture: Texture };

/** Shared caching: one texture per node, repainted when its key changes. */
abstract class PaintedSource implements TextureSource {
  private readonly entries = new Map<string, Entry>();

  protected abstract keyOf(node: SpriteNode, scale: number, zoom: number): string;
  protected abstract paint(node: SpriteNode, scale: number, zoom: number): HTMLCanvasElement;

  /** `level` is a texture scale (as for cards and notes); `zoom` the
   *  camera's, for what shows at this size on screen. */
  texture(node: SpriteNode, level: string, zoom = 1): Texture {
    const requested = Number.parseFloat(level) || 1;
    const scale = Math.min(
      requested,
      MAX_TEXTURE_PX / Math.max(1, node.width),
      MAX_TEXTURE_PX / Math.max(1, node.height),
    );
    const key = `${scale}|${node.width}|${node.height}|${this.keyOf(node, scale, zoom)}`;
    const existing = this.entries.get(node.id);
    if (existing?.key === key) return existing.texture;
    const texture = Texture.from(this.paint(node, scale, zoom));
    existing?.texture.destroy(true);
    this.entries.set(node.id, { key, texture });
    return texture;
  }

  retain(ids: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) continue;
      entry.texture.destroy(true);
      this.entries.delete(id);
    }
  }

  tick(): boolean {
    return false;
  }

  dispose(): void {
    this.retain(new Set());
  }
}

function canvasFor(node: SpriteNode, scale: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(node.width * scale));
  canvas.height = Math.max(1, Math.round(node.height * scale));
  const context = canvas.getContext('2d');
  context?.scale(scale, scale);
  return { canvas, context };
}

/** Contiguous swatches in a rounded strip (palettes, wheel rows). */
function paintStrip(
  context: CanvasRenderingContext2D,
  colors: readonly string[],
  rect: Rect,
  radius: number,
): void {
  if (colors.length === 0) return;
  context.save();
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  context.clip();
  const step = rect.width / colors.length;
  colors.forEach((hex, index) => {
    context.fillStyle = hex;
    // Overlap a hair so no seam shows between swatches.
    context.fillRect(rect.x + index * step, rect.y, step + 0.6, rect.height);
  });
  context.restore();
}

/*
 * Depth, the chrome's neumorphism (index.css mirrors every number). The
 * wheel's colours stay flat — colour accuracy — and their depth is all
 * outside them: raised parts cast a dark shadow down-right and a highlight
 * up-left. Recessed wells (the fields) shade their inner edges. Only
 * palettes on the board are dipped in, shaded over their colours with
 * blends that keep them honest. Sizes are in the wheel's em (the live
 * panel's font size: 0.42 x the controls row's height). Canvas shadows
 * ignore the transform, so they're scaled to texture pixels here.
 */

/** Soft outer shadows under whatever `draw` fills, all at 45°: a shadow
 *  down-right, a highlight up-left — and with `boost`, a second, wider
 *  highlight (the colour disc). Never anything inside the shape. */
function raised(
  context: CanvasRenderingContext2D,
  look: ToolTheme,
  unit: number,
  draw: () => void,
  boost = false,
): void {
  context.save();
  context.shadowColor = look.shadeLo;
  context.shadowOffsetX = 0.26 * unit;
  context.shadowOffsetY = 0.26 * unit;
  context.shadowBlur = 0.7 * unit;
  draw();
  context.shadowColor = look.shadeHi;
  context.shadowOffsetX = -0.22 * unit;
  context.shadowOffsetY = -0.22 * unit;
  context.shadowBlur = 0.6 * unit;
  draw();
  if (boost) {
    context.shadowOffsetX = -0.4 * unit;
    context.shadowOffsetY = -0.4 * unit;
    context.shadowBlur = 1.1 * unit;
    draw();
  }
  context.restore();
}

/** An opaque stand-in a flat shape's shadows are cast from (a strip clips
 *  itself, which would clip its shadow too); inset a hair so no edge of it
 *  shows around what's painted over it. */
function caster(
  context: CanvasRenderingContext2D,
  rect: Rect,
  radius: number,
  scale: number,
): void {
  const hair = 0.6 / scale;
  context.beginPath();
  context.roundRect(
    rect.x + hair,
    rect.y + hair,
    rect.width - hair * 2,
    rect.height - hair * 2,
    radius,
  );
  context.fillStyle = '#808080';
  context.fill();
}

type Shade = { color: string; blend: GlobalCompositeOperation };

/** Shading inside a rounded rect — only ever dipped: `shade` along the
 *  inner top (and left, when `dx`), `light` along the inner bottom (and
 *  right), each in its own blend. */
function inner(
  context: CanvasRenderingContext2D,
  rect: Rect,
  radius: number,
  shade: Shade,
  light: Shade,
  dx: number,
  dy: number,
  blur: number,
): void {
  const shape = () => context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  context.save();
  context.beginPath();
  shape();
  context.clip();
  // A frame around the shape, drawn far off the canvas: only its shadow,
  // offset back, lands (inside the clip; composited in the blend). Drawn in
  // place, its edge would show through the clip's anti-aliasing.
  const scale = context.getTransform().a;
  const margin = Math.max(rect.width, rect.height) + (Math.max(dx, dy) + blur) / scale;
  const far = context.canvas.width / scale + rect.width + margin * 2;
  const device = far * scale;
  const ring = (pass: Shade, x: number, y: number) => {
    context.globalCompositeOperation = pass.blend;
    context.shadowColor = pass.color;
    context.shadowOffsetX = x - device;
    context.shadowOffsetY = y;
    context.save();
    context.translate(far, 0);
    context.beginPath();
    context.rect(
      rect.x - margin,
      rect.y - margin,
      rect.width + margin * 2,
      rect.height + margin * 2,
    );
    shape();
    context.fill('evenodd');
    context.restore();
  };
  context.fillStyle = '#000';
  context.shadowBlur = blur;
  ring(shade, dx, dy);
  ring(light, -dx, -dy);
  context.restore();
}

/** A palette on the board, dipped into it: a shadow along the inner top
 *  and left (multiply), light along the inner bottom and right (lighten) —
 *  at 45°, like all the shading. */
function dip(context: CanvasRenderingContext2D, rect: Rect, radius: number, scale: number): void {
  const depth = rect.height * 0.05 * scale;
  inner(
    context,
    rect,
    radius,
    { color: 'rgb(0 0 0 / 34%)', blend: 'multiply' },
    { color: 'rgb(255 255 255 / 40%)', blend: 'lighten' },
    depth,
    depth,
    depth * 2,
  );
}

/** A recessed well (fields, the switch). */
function recessed(
  context: CanvasRenderingContext2D,
  look: ToolTheme,
  unit: number,
  rect: Rect,
  radius: number,
): void {
  inner(
    context,
    rect,
    radius,
    { color: look.shadeLo, blend: 'source-over' },
    { color: look.wellHi, blend: 'source-over' },
    0.13 * unit,
    0.13 * unit,
    0.35 * unit,
  );
}

/**
 * Palette items: the colour wheel's palette strip, on its own — contiguous
 * swatches in one rounded strip, nothing printed on them (a hovered
 * swatch's hex shows in a tip; a click copies it).
 */
export class PaletteTextureSource extends PaintedSource {
  protected keyOf(node: SpriteNode): string {
    return (node.colors ?? []).join(',');
  }

  protected paint(node: SpriteNode, scale: number): HTMLCanvasElement {
    const { canvas, context } = canvasFor(node, scale);
    const colors = node.colors ?? [];
    if (!context || colors.length === 0) return canvas;
    const { width, height } = node;
    const rect = { x: 0, y: 0, width, height };
    paintStrip(context, colors, rect, height * STRIP_RADIUS);
    dip(context, rect, height * STRIP_RADIUS, scale);
    return canvas;
  }
}

/**
 * Where a line of text centred on `y` sits, the way the live panel's CSS
 * centres it (the line box: ascent + descent, centred) — not canvas
 * 'middle', which centres the em box and sits it higher, so the text
 * jumped on select. Sets the alphabetic baseline; call after the font.
 */
function centeredBaseline(context: CanvasRenderingContext2D, y: number): number {
  context.textBaseline = 'alphabetic';
  const metrics = context.measureText('Hg');
  return y + (metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
}

// Lucide paths (24-unit box) for the two icons the wheel paints.
const CHEVRON_DOWN = ['m6 9 6 6 6-6'];
// Lucide "dices" (its rect as a path).
const DICES = [
  'M4 10h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
  'm17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6',
  'M6 18h.01',
  'M10 14h.01',
  'M15 6h.01',
  'M18 9h.01',
];

function paintIcon(
  context: CanvasRenderingContext2D,
  paths: readonly string[],
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  context.save();
  context.translate(cx - size / 2, cy - size / 2);
  context.scale(size / 24, size / 24);
  context.strokeStyle = color;
  context.lineWidth = 1.75;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const d of paths) context.stroke(new Path2D(d));
  context.restore();
}

/**
 * The colour wheel item while it isn't live: its picture, painted from the
 * same layout the live controls use (wheelLayout.ts) — the wheel at the
 * base colour's brightness with a handle per colour, the brightness
 * slider, the harmony, the mode switch and Random, the current palette and
 * the saved ones. Zoomed out, only the colour (handles become dots).
 */
export class WheelTextureSource extends PaintedSource {
  protected keyOf(node: SpriteNode, _scale: number, zoom: number): string {
    const wheel = node.wheel;
    if (!wheel) return '';
    const detail = wheelDetail(node.width * zoom);
    // Dots are a screen size: repaint with the zoom while they show.
    const dots = detail === 'full' ? '' : zoom.toFixed(3);
    return `${toolTheme().key}|${detail}|${dots}|${wheel.base}|${wheel.harmony}|${wheel.mode}|${wheel.points.map(({ h, s, v }) => `${h},${s},${v}`).join(';')}|${wheel.library
      .map((row) => row.join(','))
      .join(';')}`;
  }

  protected paint(node: SpriteNode, scale: number, zoom: number): HTMLCanvasElement {
    const { canvas, context } = canvasFor(node, scale);
    const wheel = node.wheel;
    if (!context || !wheel) return canvas;
    const look = toolTheme();
    const detail = wheelDetail(node.width * zoom);
    const { width, height } = node;
    const layout = wheelLayout(width, height);
    const hairline = 1 / Math.max(zoom, 0.01);

    // The glass: tint and rim (no bright top edge: nothing lights the
    // inside of a colour tool).
    const radius = width * PANEL_RADIUS;
    context.beginPath();
    context.roundRect(0, 0, width, height, radius);
    context.globalAlpha = look.alpha;
    context.fillStyle = look.panel;
    context.fill();
    context.globalAlpha = 1;
    context.beginPath();
    context.roundRect(hairline / 2, hairline / 2, width - hairline, height - hairline, radius);
    context.strokeStyle = look.edge;
    context.lineWidth = hairline;
    context.stroke();

    // One em of the live panel, in texture pixels (for the shadows).
    const unit = layout.controls.height * 0.42 * scale;
    const track = layout.slider;
    raised(context, look, unit * 0.5, () => caster(context, track, track.width / 2, scale));
    paintSlider(context, track, wheel, zoom);
    const disc = layout.wheel;
    raised(
      context,
      look,
      unit,
      () => {
        context.beginPath();
        context.arc(
          disc.x + disc.width / 2,
          disc.y + disc.height / 2,
          disc.width / 2,
          0,
          Math.PI * 2,
        );
        context.fillStyle = look.panel;
        context.fill();
      },
      true,
    );
    paintWheel(context, layout.wheel, wheel, detail, zoom);
    if (detail === 'full') paintControls(context, layout, wheel, look, unit);

    const strip = layout.swatches;
    const stripRadius = strip.height * STRIP_RADIUS;
    raised(context, look, unit, () => caster(context, strip, stripRadius, scale));
    paintStrip(context, wheel.colors, strip, stripRadius);

    if (detail === 'full') {
      const title = layout.libraryTitle;
      context.fillStyle = look.muted;
      context.font = font(layout.controls.height * 0.42 * 0.9, 600);
      context.textAlign = 'left';
      const text = wheel.library.length > 0 ? `Palettes · ${wheel.library.length}` : 'Palettes';
      context.fillText(text, title.x, centeredBaseline(context, title.y + title.height / 2));
    }
    const { library, rowHeight, rowGap } = layout;
    let y = library.y;
    for (const row of wheel.library) {
      if (y + rowHeight > library.y + library.height) break;
      const rect = { x: library.x, y, width: library.width, height: rowHeight };
      raised(context, look, unit * 0.5, () => caster(context, rect, rowHeight * ROW_RADIUS, scale));
      paintStrip(context, row, rect, rowHeight * ROW_RADIUS);
      y += rowHeight + rowGap;
    }
    return canvas;
  }
}

/** The controls row: the harmony field, the HSV|HSL switch, Random. */
function paintControls(
  context: CanvasRenderingContext2D,
  layout: ReturnType<typeof wheelLayout>,
  wheel: WheelState,
  look: ToolTheme,
  unit: number,
): void {
  const h = layout.controls.height;
  const px = h * 0.42;
  const shape =
    (rect: Rect, radius = h * FIELD_RADIUS) =>
    () =>
      context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  /** A recessed field (the harmony picker, the switch's well). */
  const field = (rect: Rect) => {
    context.beginPath();
    shape(rect)();
    context.fillStyle = look.field;
    context.fill();
    recessed(context, look, unit, rect, h * FIELD_RADIUS);
  };
  /** A raised part (the switch's chosen side, the Random button). */
  const lifted = (rect: Rect, radius: number, amount: number) => {
    raised(context, look, unit * amount, () => {
      context.beginPath();
      shape(rect, radius)();
      context.fillStyle = look.panel;
      context.fill();
    });
  };
  const label = (text: string, x: number, y: number, maxWidth: number, color: string) => {
    context.fillStyle = color;
    context.font = font(px, 400);
    context.fillText(fitLine(text, font(px, 400), maxWidth), x, centeredBaseline(context, y));
  };

  const { harmony, mode, random } = layout;
  const middle = harmony.y + h / 2;
  field(harmony);
  context.textAlign = 'left';
  label(
    HARMONY_LABELS[wheel.harmony],
    harmony.x + h * 0.4,
    middle,
    harmony.width - h * 1.4,
    look.text,
  );
  paintIcon(
    context,
    CHEVRON_DOWN,
    harmony.x + harmony.width - h * 0.5,
    middle,
    h * 0.5,
    look.muted,
  );

  // The switch: a well with the chosen side raised.
  field(mode);
  const inset = h * 0.1;
  const half = (mode.width - inset * 2) / 2;
  const chosen = wheel.mode === 'hsv' ? 0 : 1;
  lifted(
    { x: mode.x + inset + chosen * half, y: mode.y + inset, width: half, height: h - inset * 2 },
    (h - inset * 2) * FIELD_RADIUS,
    0.4,
  );
  context.textAlign = 'center';
  (['hsv', 'hsl'] as const).forEach((side, index) => {
    label(
      side.toUpperCase(),
      mode.x + inset + half * (index + 0.5),
      middle,
      half - inset,
      side === wheel.mode ? look.accent : look.muted,
    );
  });

  lifted(random, h * FIELD_RADIUS, 0.5);
  paintIcon(context, DICES, random.x + random.width / 2, middle, h * 0.55, look.text);
}

function paintSlider(
  context: CanvasRenderingContext2D,
  rect: Rect,
  wheel: WheelState,
  zoom: number,
): void {
  const px = 1 / Math.max(zoom, 0.01);
  const base = wheelBase(wheel);
  const gradient = context.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
  if (wheel.mode === 'hsl') {
    const pure = hsvToHex({ h: base.h, s: hsvToHsl(base).s > 0 ? 1 : 0, v: 1 });
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.5, pure);
    gradient.addColorStop(1, '#000000');
  } else {
    gradient.addColorStop(0, hsvToHex({ h: base.h, s: base.s, v: 1 }));
    gradient.addColorStop(1, '#000000');
  }
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, rect.width / 2);
  context.fillStyle = gradient;
  context.fill();
  const level = wheel.mode === 'hsl' ? hsvToHsl(base).l : base.v;
  const thumbY = rect.y + (1 - level) * rect.height;
  context.beginPath();
  // As the live thumb: 124% of the track, a 2px white border outside it.
  context.arc(rect.x + rect.width / 2, thumbY, rect.width * 0.62 + px, 0, Math.PI * 2);
  context.fillStyle = wheel.base;
  context.fill();
  context.lineWidth = 2 * px;
  context.strokeStyle = '#ffffff';
  context.stroke();
}

function paintWheel(
  context: CanvasRenderingContext2D,
  rect: Rect,
  wheel: WheelState,
  detail: WheelDetail,
  zoom: number,
): void {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const radius = rect.width / 2;
  // Hue around (0° at 3 o'clock, anticlockwise — as the live wheel draws
  // it), saturation outward from a white centre, darkened to the base's
  // brightness.
  const hues = context.createConicGradient(0, cx, cy);
  for (let step = 0; step <= 12; step += 1) {
    hues.addColorStop(step / 12, hsvToHex({ h: 360 - step * 30, s: 1, v: 1 }));
  }
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.fillStyle = hues;
  context.fill();
  const white = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
  white.addColorStop(0, '#ffffff');
  white.addColorStop(1, 'rgb(255 255 255 / 0%)');
  context.fillStyle = white;
  context.fill();
  const value = wheelBase(wheel).v;
  context.fillStyle = `rgb(0 0 0 / ${Math.round((1 - value) * 100)}%)`;
  context.fill();

  // Handles: rings (as the live wheel draws them), or dots zoomed out.
  // The live wheel's geometry (ColorWheelPanel: handleRadius, no padding):
  // a handle is a ring of radius R (a faint dark rim, the colour inside a
  // 2px white ring at R − 2), kept inside the disc by R.
  const px = 1 / Math.max(zoom, 0.01);
  const ringRadius = Math.max(5 * px, rect.width * 0.04);
  const reach = radius - ringRadius;
  // Exact points, as the live wheel places its handles.
  wheel.points.forEach((color, index) => {
    const hex = hsvToHex(color);
    const angle = (color.h * Math.PI) / 180;
    const x = cx + Math.cos(angle) * color.s * reach;
    const y = cy - Math.sin(angle) * color.s * reach;
    const base = index === BASE_INDEX;
    context.beginPath();
    if (detail === 'full') {
      const r = ringRadius * (base ? 1.25 : 1);
      context.arc(x, y, r - 2 * px, 0, Math.PI * 2);
      context.fillStyle = hex;
      context.fill();
      context.lineWidth = 2 * px;
      context.strokeStyle = '#ffffff';
      context.stroke();
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.lineWidth = px;
      context.strokeStyle = 'rgb(0 0 0 / 28%)';
      context.stroke();
    } else {
      context.arc(x, y, WHEEL_DOT_PX * px * (base ? 1.3 : 1), 0, Math.PI * 2);
      context.fillStyle = hex;
      context.fill();
      context.lineWidth = 1.25 * px;
      context.strokeStyle = '#ffffff';
      context.stroke();
    }
  });
}
