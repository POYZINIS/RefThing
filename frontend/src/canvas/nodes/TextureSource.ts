import type { Texture } from 'pixi.js';
import type { CanvasNode, SpriteNode } from './types';

export interface TextureSource<N extends CanvasNode = SpriteNode> {
  /** Resolve the node's texture at a level (a pyramid level for images, a
   *  texture scale for notes); never rejects (Texture.WHITE fallback). */
  texture(node: N, level: string): Texture;
  /** Advance animation clocks; true when a frame changed and a re-render is due. */
  tick(nowMs: number): boolean;
  dispose(): void;
}
