import { layoutWithLines, measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { Texture } from 'pixi.js';
import { NOTE_FONT_FAMILY } from './noteText';
import type { TextureSource } from './TextureSource';
import type { SpriteNode } from './types';

const MAX_TEXTURE_PX = 4096;
const PAD = 12;
const LABEL_PX = 13;
const LABEL_LINE_PX = 17;
const DETAIL_PX = 11;
const MAX_LABEL_LINES = 2;

// Board content, so one fixed face in both themes (like a note's paper): the
// dark blue-slate of the palette, readable on either workspace.
export const CARD_BG = '#262c38';
const CARD_BORDER = '#454c48';
const CARD_TEXT = '#e2e8e2';
const CARD_MUTED = '#a3ada5';
const CARD_ACCENT = '#8fb4ec';

const font = (px: number, weight = 400) => `${weight} ${px}px ${NOTE_FONT_FAMILY}`;

/** The glyph a card shows for its kind (media without a poster yet). */
function cardGlyph(node: SpriteNode): string | null {
  if (node.kind === 'video') return '▶';
  if (node.kind === 'audio') return '♪';
  return null;
}

/** A single line's width, measured by pretext (every card string is laid
 *  out by pretext, like note text — never by the canvas's own measuring). */
const measureText = (text: string, fontSpec: string) =>
  measureNaturalWidth(prepareWithSegments(text, fontSpec));

/** `text` on one line within `width`: as is, or cut and ellipsized. */
export function fitLine(text: string, fontSpec: string, width: number): string {
  if (measureText(text, fontSpec) <= width) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureText(`${text.slice(0, mid).trimEnd()}…`, fontSpec) <= width) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${text.slice(0, low).trimEnd()}…` : '…';
}

/** Filename lines: wrapped by pretext (breaks inside long names too), at
 *  most two, the last ellipsized when the name runs on. */
export function cardLabelLines(
  label: string,
  width: number,
  measure: (text: string) => number = (text) => measureText(text, font(LABEL_PX, 600)),
) {
  const prepared = prepareWithSegments(label, font(LABEL_PX, 600));
  const { lines } = layoutWithLines(prepared, Math.max(1, width), LABEL_LINE_PX);
  const texts = lines.map((line) => line.text.trimEnd());
  if (texts.length <= MAX_LABEL_LINES) return texts;
  const kept = texts.slice(0, MAX_LABEL_LINES);
  let last = `${kept[MAX_LABEL_LINES - 1] ?? ''}…`;
  while (last.length > 1 && measure(last) > width) last = `${last.slice(0, -2)}…`;
  kept[MAX_LABEL_LINES - 1] = last;
  return kept;
}

type Entry = { key: string; texture: Texture };

/**
 * Paints generic cards (plan Phase 11): files always, and video/audio until
 * their poster exists (or when none can be made). A card is a sprite
 * like any other node — same scene graph, z-order and culling — whose
 * texture is drawn from the filename and a detail line.
 */
export class CardTextureSource implements TextureSource {
  private readonly entries = new Map<string, Entry>();

  /** `level` is a texture scale (as for notes), not a pyramid level. */
  texture(node: SpriteNode, level: string): Texture {
    const requested = Number.parseFloat(level) || 1;
    const scale = Math.min(
      requested,
      MAX_TEXTURE_PX / Math.max(1, node.width),
      MAX_TEXTURE_PX / Math.max(1, node.height),
    );
    const key = `${scale}|${node.kind}|${node.width}|${node.height}|${node.label}|${node.detail}`;
    const existing = this.entries.get(node.id);
    if (existing?.key === key) return existing.texture;
    const texture = Texture.from(paintCard(node, scale));
    existing?.texture.destroy(true);
    this.entries.set(node.id, { key, texture });
    return texture;
  }

  /** Drop textures for cards no longer mounted. */
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

function paintCard(node: SpriteNode, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(node.width * scale));
  canvas.height = Math.max(1, Math.round(node.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  const { width, height } = node;
  context.scale(scale, scale);
  context.beginPath();
  context.roundRect(0.5, 0.5, width - 1, height - 1, 8);
  context.fillStyle = CARD_BG;
  context.fill();
  context.lineWidth = 1;
  context.strokeStyle = CARD_BORDER;
  context.stroke();
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();

  // Text block pinned to the bottom: filename lines, then the detail line.
  const textWidth = Math.max(1, width - PAD * 2);
  context.font = font(LABEL_PX, 600);
  const labelLines = cardLabelLines(node.label, textWidth);
  const textHeight = labelLines.length * LABEL_LINE_PX + (node.detail ? DETAIL_PX + 6 : 0);
  let y = height - PAD - textHeight;
  context.textBaseline = 'top';
  context.fillStyle = CARD_TEXT;
  for (const line of labelLines) {
    context.fillText(line, PAD, y + (LABEL_LINE_PX - LABEL_PX) / 2);
    y += LABEL_LINE_PX;
  }
  if (node.detail) {
    context.font = font(DETAIL_PX);
    context.fillStyle = CARD_MUTED;
    context.fillText(fitLine(node.detail, font(DETAIL_PX), textWidth), PAD, y + 4);
  }

  // The badge fills the space above: a play/note glyph for media, else the
  // file's extension (the detail line's first word).
  const room = height - PAD * 2 - textHeight - 8;
  if (room > 14) {
    const glyph = cardGlyph(node);
    const badge = glyph ?? node.detail.split(' ')[0] ?? '';
    let size = Math.min(room * (glyph ? 0.7 : 0.45), width * (glyph ? 0.35 : 0.22));
    // Shrunk to fit the card's width when a long extension would overrun.
    const badgeWidth = measureText(badge, font(size, 700));
    if (badgeWidth > textWidth) size *= textWidth / badgeWidth;
    context.font = font(size, 700);
    context.fillStyle = CARD_ACCENT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(badge, width / 2, PAD + room / 2);
  }
  context.restore();
  return canvas;
}
