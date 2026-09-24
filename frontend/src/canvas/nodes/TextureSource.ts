import type { Texture } from 'pixi.js';
import type { SpriteNode } from './types';

export interface TextureSource {
  /** Resolve the node's texture at a pyramid level; never rejects (Texture.WHITE fallback). */
  texture(node: SpriteNode, level: string): Texture;
  /** Advance animation clocks; true when a frame changed and a re-render is due. */
  tick(nowMs: number): boolean;
  dispose(): void;
}
