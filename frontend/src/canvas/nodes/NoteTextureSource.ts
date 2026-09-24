import { Texture } from 'pixi.js';
import {
  layoutNoteText,
  NOTE_BORDER_COLOR,
  NOTE_BORDER_PX,
  NOTE_DEFAULT_BG,
  NOTE_FONT_PX,
  NOTE_LINE_HEIGHT_PX,
  NOTE_TEXT_COLOR,
  NOTE_TEXT_INSET_PX,
  noteFont,
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
    const key = `${scale}|${node.width}|${node.height}|${node.bgColor}|${node.text}`;
    const existing = this.entries.get(node.id);
    if (existing?.key === key) return existing.texture;
    const texture = Texture.from(paintNote(node, scale));
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

function paintNote(node: NoteNode, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(node.width * scale));
  canvas.height = Math.max(1, Math.round(node.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.scale(scale, scale);
  const radius = 4;
  context.beginPath();
  context.roundRect(0.5, 0.5, node.width - 1, node.height - 1, radius);
  context.fillStyle = node.bgColor ?? NOTE_DEFAULT_BG;
  context.fill();
  context.lineWidth = NOTE_BORDER_PX;
  context.strokeStyle = NOTE_BORDER_COLOR;
  context.stroke();
  // Text clips to the note: overflow scrolls only in the editor (§4 RULE 6).
  context.save();
  context.beginPath();
  context.rect(0, 0, node.width, node.height);
  context.clip();
  context.font = noteFont(NOTE_FONT_PX);
  context.fillStyle = NOTE_TEXT_COLOR;
  // CSS centers glyphs vertically inside each line box; 'middle' at the line
  // box's center matches the textarea to within a pixel.
  context.textBaseline = 'middle';
  const { lines } = layoutNoteText(node.text, node.width);
  lines.forEach((line, index) => {
    const y = NOTE_TEXT_INSET_PX + index * NOTE_LINE_HEIGHT_PX + NOTE_LINE_HEIGHT_PX / 2;
    if (y - NOTE_LINE_HEIGHT_PX / 2 > node.height) return;
    context.fillText(line, NOTE_TEXT_INSET_PX, y);
  });
  context.restore();
  return canvas;
}
