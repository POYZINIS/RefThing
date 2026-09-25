import { Texture } from 'pixi.js';
import {
  currentTheme,
  layoutNoteDocument,
  NOTE_BORDER_PX,
  type NoteColors,
  noteColors,
  type PaintLine,
} from './noteText';
import type { TextureSource } from './TextureSource';
import type { NoteNode } from './types';

/** Texture px per world px, bucketed to powers of two so zooming re-renders a
 *  note only when it crosses a bucket, never every frame. */
export function noteTextureScale(zoom: number, devicePixelRatio: number): number {
  const exact = Math.max(zoom * devicePixelRatio, 1 / 64);
  return 2 ** Math.max(-2, Math.min(2, Math.ceil(Math.log2(exact))));
}

const MAX_TEXTURE_PX = 4096;

type Entry = { key: string; texture: Texture };

/**
 * Paints notes into textures (background, border, pretext-laid-out text) so
 * they render as ordinary sprites: same scene graph, same z-order, same
 * culling as images (§0.7 — only the content differs by kind). The editing
 * note is hidden on the canvas and edited through a DOM textarea that uses
 * the identical layout metrics.
 */
export class NoteTextureSource implements TextureSource<NoteNode> {
  private readonly entries = new Map<string, Entry>();

  texture(node: NoteNode, level: string): Texture {
    const requested = Number.parseFloat(level) || 1;
    const scale = Math.min(
      requested,
      MAX_TEXTURE_PX / Math.max(1, node.width),
      MAX_TEXTURE_PX / Math.max(1, node.height),
    );
    // The theme is part of the key: an unfilled note's text follows it.
    const theme = currentTheme();
    const key = `${scale}|${node.width}|${node.height}|${node.bgColor}|${node.textScale}|${theme}|${JSON.stringify(node.style)}|${node.text}`;
    const existing = this.entries.get(node.id);
    if (existing?.key === key) return existing.texture;
    const texture = Texture.from(paintNote(node, scale, theme));
    existing?.texture.destroy(true);
    this.entries.set(node.id, { key, texture });
    return texture;
  }

  /** Drop textures for notes that are no longer mounted. */
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

function paintNote(node: NoteNode, scale: number, theme: 'light' | 'dark'): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(node.width * scale));
  canvas.height = Math.max(1, Math.round(node.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.scale(scale, scale);
  const colors = noteColors(node.bgColor, node.style.color, theme);
  // No fill: text only, blending into the board.
  if (colors.fill) {
    context.beginPath();
    context.roundRect(0.5, 0.5, node.width - 1, node.height - 1, 4);
    context.fillStyle = colors.fill;
    context.fill();
    if (colors.border) {
      context.lineWidth = NOTE_BORDER_PX;
      context.strokeStyle = colors.border;
      context.stroke();
    }
  }
  // Text clips to the note: overflow scrolls only in the editor (§4 RULE 6).
  context.save();
  context.beginPath();
  context.rect(0, 0, node.width, node.height);
  context.clip();
  // Laid out in note units, drawn through the note's text scale.
  const textScale = node.textScale;
  context.scale(textScale, textScale);
  const laid = layoutNoteDocument(node.text, node.width, textScale, node.style);
  const limit = node.height / textScale;
  for (const line of laid.lines) {
    if (line.y > limit) break;
    paintLine(context, line, laid.left, laid.width, colors);
  }
  context.restore();
  return canvas;
}

function paintLine(
  context: CanvasRenderingContext2D,
  line: PaintLine,
  left: number,
  width: number,
  colors: NoteColors,
): void {
  const middle = line.y + line.height / 2;
  if (line.codeBand) {
    context.fillStyle = colors.codeFill;
    context.fillRect(left, line.y, width, line.height);
  }
  if (line.rule) {
    context.fillStyle = colors.rule;
    context.fillRect(left, middle - 0.5, width, 1);
  }
  if (line.quoteBar !== undefined) {
    context.fillStyle = colors.rule;
    context.fillRect(line.quoteBar, line.y, Math.max(2, line.px * 0.14), line.height);
  }
  const marker = line.marker;
  if (marker) {
    context.fillStyle = colors.text;
    context.strokeStyle = colors.text;
    if (marker.kind === 'bullet') {
      context.beginPath();
      context.arc(marker.x + line.px * 0.35, middle, line.px * 0.14, 0, Math.PI * 2);
      context.fill();
    } else if (marker.kind === 'ordered') {
      context.font = marker.font;
      context.textBaseline = 'middle';
      context.fillText(marker.text, marker.x, middle);
    } else {
      const size = line.px * 0.78;
      const top = middle - size / 2;
      context.lineWidth = Math.max(1, line.px * 0.08);
      context.beginPath();
      context.roundRect(marker.x, top, size, size, size * 0.18);
      context.stroke();
      if (marker.checked) {
        context.beginPath();
        context.moveTo(marker.x + size * 0.22, top + size * 0.52);
        context.lineTo(marker.x + size * 0.42, top + size * 0.72);
        context.lineTo(marker.x + size * 0.8, top + size * 0.28);
        context.stroke();
      }
    }
  }
  // CSS centers glyphs vertically inside each line box; 'middle' at the line
  // box's center matches the textarea to within a pixel.
  context.textBaseline = 'middle';
  for (const run of line.runs) {
    const pad = run.code?.pad ?? 0;
    if (run.code) {
      context.fillStyle = colors.codeFill;
      context.beginPath();
      context.roundRect(run.x, line.y + line.height * 0.12, run.width, line.height * 0.76, 3);
      context.fill();
    }
    context.font = run.font;
    context.fillStyle = run.muted ? colors.muted : colors.text;
    context.fillText(run.text, run.x + pad, middle);
    if (run.strike || run.underline) {
      const textWidth = run.width - pad * 2;
      const thickness = Math.max(1, line.px * 0.07);
      const at = run.strike ? middle : middle + line.px * 0.55;
      context.fillRect(run.x + pad, at - thickness / 2, textWidth, thickness);
    }
  }
}
