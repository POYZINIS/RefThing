import { Texture } from 'pixi.js';
import { blobUrl } from '@/api/client';
import { closeGif, decodeGif, type GifDecode, gifDecodingSupported } from '../gif';
import type { TextureSource } from './TextureSource';
import type { SpriteNode } from './types';

/**
 * Animated GIF frames decoded from the original blob bytes (the pyramid only
 * carries a first-frame poster). Decodes and frame clocks are keyed by blob
 * hash, so two items sharing a blob share one decode; `sync` tells the source
 * which hashes are still alive and which back visible items. Anything
 * undecodable falls back to the static pyramid.
 */
export class GifTextureSource implements TextureSource {
  private readonly decoded = new Map<string, GifDecode | null>();
  private readonly loading = new Set<string>();
  private readonly time = new Map<string, number>();
  private readonly textures = new Map<string, Texture>();
  private referenced = new Set<string>();
  private lastTick: number | null = null;

  constructor(
    private readonly fallback: TextureSource,
    private readonly onChange: () => void,
  ) {}

  texture(node: SpriteNode, level: string): Texture {
    const decode = this.decoded.get(node.blobHash);
    if (!decode) return this.fallback.texture(node, level);
    const frameIndex = this.frameIndex(node.blobHash, decode);
    const key = `gif:${node.blobHash}:${frameIndex}`;
    const existing = this.textures.get(key);
    if (existing) return existing;
    const frame = decode.frames[frameIndex] ?? decode.frames[0];
    if (!frame) return Texture.WHITE;
    const texture = Texture.from(frame.bitmap);
    this.textures.set(key, texture);
    return texture;
  }

  /**
   * Reconcile with the latest board state: drop decodes whose hash is no
   * longer a GIF blob, start decodes for referenced hashes. Clocks only
   * advance for referenced hashes, so a filtered-out GIF resumes from the
   * frame it was hidden on.
   */
  sync(activeHashes: ReadonlySet<string>, referencedHashes: ReadonlySet<string>): void {
    for (const hash of [...this.decoded.keys()]) {
      if (!activeHashes.has(hash)) this.forget(hash);
    }
    this.referenced = new Set(referencedHashes);
    for (const hash of this.referenced) {
      if (activeHashes.has(hash)) this.ensure(hash);
    }
  }

  tick(nowMs: number): boolean {
    if (!gifDecodingSupported()) return false;
    if (this.decoded.size === 0) return false;
    const dt = Math.min(nowMs - (this.lastTick ?? nowMs), 100);
    this.lastTick = nowMs;
    if (dt <= 0) return false;
    let changed = false;
    for (const hash of this.referenced) {
      const decode = this.decoded.get(hash);
      if (!decode || decode.frames.length < 2) continue;
      const before = this.frameIndex(hash, decode);
      this.time.set(hash, (this.time.get(hash) ?? 0) + dt);
      if (this.frameIndex(hash, decode) !== before) changed = true;
    }
    return changed;
  }

  dispose(): void {
    for (const decode of this.decoded.values()) if (decode) closeGif(decode);
    this.decoded.clear();
    this.time.clear();
    this.textures.clear();
  }

  /** Which frame a GIF is currently on, derived from its accumulated time. */
  private frameIndex(hash: string, decode: GifDecode): number {
    const elapsed = this.time.get(hash) ?? 0;
    let accumulator = elapsed % decode.totalMs;
    for (let i = 0; i < decode.frames.length; i += 1) {
      const frame = decode.frames[i];
      if (!frame) return Math.min(i, decode.frames.length - 1);
      if (accumulator < frame.durationMs) return Math.min(i, decode.frames.length - 1);
      accumulator -= frame.durationMs;
    }
    return decode.frames.length - 1;
  }

  /**
   * Start decoding a GIF's frames once per hash. `decodeGif` returns `null`
   * when unsupported/failed, which is cached as "static fallback" so we don't
   * hammer the endpoint on every frame tick.
   */
  private ensure(hash: string): void {
    if (this.decoded.has(hash) || this.loading.has(hash)) return;
    this.loading.add(hash);
    void decodeGif(blobUrl(hash, 'full')).then((decode) => {
      this.loading.delete(hash);
      this.decoded.set(hash, decode);
      this.time.set(hash, 0);
      this.onChange();
    });
  }

  /** Drop a GIF's frames and any textures derived from them. */
  private forget(hash: string): void {
    const decode = this.decoded.get(hash);
    if (decode) closeGif(decode);
    this.decoded.delete(hash);
    this.time.delete(hash);
    for (const key of [...this.textures.keys()]) {
      if (key.startsWith(`gif:${hash}:`)) this.textures.delete(key);
    }
    this.onChange();
  }
}
