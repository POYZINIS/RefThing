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

const LEVELS = ['thumb', 'small', 'medium', 'full'] as const;

/** Textures kept resident beyond the ones in use (least recently used go). */
const MAX_TEXTURES = 1500;
/** A texture untouched for this many frames is no longer on screen. */
const IDLE_FRAMES = 120;

type Entry = { texture: Texture; lastUsed: number };

/** Fetch + decode to an ImageBitmap, off the main thread. */
async function decodeImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob());
}

/**
 * Static image pyramid (thumb/small/medium/full).
 *
 * - Bytes decode off the main thread: fetch + createImageBitmap, which the
 *   browser decodes on its own threads (measured: a dedicated worker pool
 *   added nothing on top — docs/perf-baseline.md).
 * - While a level loads, the node shows the nearest level ALREADY resident —
 *   it never downloads the full original just as a placeholder (that fetched
 *   and decoded every original on a zoomed-out board).
 * - `full` is requested in place of a smaller level only when that level
 *   failed (its derivative is still pending on the server).
 * - Least-recently-used textures beyond MAX_TEXTURES are freed once they've
 *   been off screen for a while, so browsing a big board doesn't grow GPU
 *   memory without bound.
 */
export class PyramidTextureSource implements TextureSource {
  private readonly textures = new Map<string, Entry>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  private frame = 0;

  constructor(private readonly onChange: () => void) {}

  texture(node: SpriteNode, level: string): Texture {
    const wanted = this.failed.has(`${node.blobHash}-${level}`) ? 'full' : level;
    const key = `${node.blobHash}-${wanted}`;
    const existing = this.textures.get(key);
    if (existing) {
      existing.lastUsed = this.frame;
      return existing.texture;
    }
    if (this.failed.has(key)) return this.nearestResident(node.blobHash, wanted);
    if (!this.loading.has(key)) this.load(key, blobUrl(node.blobHash, wanted));
    return this.nearestResident(node.blobHash, wanted);
  }

  /** The closest level of this blob already on the GPU (smaller first), or
   *  a blank placeholder while nothing is. */
  private nearestResident(hash: string, level: string): Texture {
    const index = LEVELS.indexOf(level as (typeof LEVELS)[number]);
    const order = [...LEVELS.slice(0, index).reverse(), ...LEVELS.slice(index + 1)];
    for (const candidate of order) {
      const entry = this.textures.get(`${hash}-${candidate}`);
      if (entry) {
        entry.lastUsed = this.frame;
        return entry.texture;
      }
    }
    return Texture.WHITE;
  }

  private load(key: string, url: string): void {
    this.loading.add(key);
    decodeImage(url).then(
      (bitmap) => {
        this.loading.delete(key);
        this.textures.set(key, { texture: Texture.from(bitmap), lastUsed: this.frame });
        this.onChange();
      },
      () => {
        this.loading.delete(key);
        this.failed.add(key);
        this.onChange();
      },
    );
  }

  tick(): boolean {
    this.frame += 1;
    if (this.textures.size > MAX_TEXTURES && this.frame % 30 === 0) this.evict();
    return false;
  }

  private evict(): void {
    const idle = [...this.textures.entries()]
      .filter(([, entry]) => this.frame - entry.lastUsed > IDLE_FRAMES)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let excess = this.textures.size - MAX_TEXTURES;
    for (const [key, entry] of idle) {
      if (excess <= 0) break;
      entry.texture.destroy(true);
      this.textures.delete(key);
      excess -= 1;
    }
  }

  /** Poster regeneration makes a previously-failed level worth retrying. */
  clearFailures(): void {
    this.failed.clear();
  }

  dispose(): void {
    for (const entry of this.textures.values()) entry.texture.destroy(true);
    this.textures.clear();
    this.loading.clear();
    this.failed.clear();
  }
}
