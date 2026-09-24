import { Texture } from 'pixi.js';
import { blobUrl } from '@/api/client';
import type { TextureSource } from './TextureSource';
import type { SpriteNode } from './types';

/** Pyramid level thresholds, in on-screen pixels of the node's longest edge. */
export function pyramidLevel(displayEdge: number): string {
  if (displayEdge <= 64) return 'thumb';
  if (displayEdge <= 256) return 'small';
  if (displayEdge <= 1024) return 'medium';
  return 'full';
}

/** Static image pyramid (thumb/small/medium/full) with failure caching. */
export class PyramidTextureSource implements TextureSource {
  private readonly textures = new Map<string, Texture>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();

  constructor(private readonly onChange: () => void) {}

  texture(node: SpriteNode, level: string): Texture {
    const key = `${node.blobHash}-${level}`;
    const existing = this.textures.get(key);
    if (existing) return existing;
    if (this.failed.has(key)) {
      return level === 'full' ? Texture.WHITE : this.texture(node, 'full');
    }
    if (!this.loading.has(key)) {
      this.loading.add(key);
      const image = new Image();
      image.onload = () => {
        this.textures.set(key, Texture.from(image));
        this.loading.delete(key);
        this.onChange();
      };
      image.onerror = () => {
        this.loading.delete(key);
        this.failed.add(key);
        this.onChange();
      };
      image.src = blobUrl(node.blobHash, level);
    }
    return level === 'full' ? Texture.WHITE : this.texture(node, 'full');
  }

  tick(): boolean {
    return false;
  }

  /** Poster regeneration makes a previously-failed level worth retrying. */
  clearFailures(): void {
    this.failed.clear();
  }

  dispose(): void {
    this.textures.clear();
    this.loading.clear();
    this.failed.clear();
  }
}
