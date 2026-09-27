import { Texture } from 'pixi.js';
import type { FromWorker, ToWorker } from '../model/protocol';
import { type ModelSettings, modelSettings, settingsKey } from './modelView';

import type { TextureSource } from './TextureSource';
import type { SpriteNode } from './types';

export { modelTextureScale } from './modelView';

/** Longest edge of a model render, device px. */
const MAX_RENDER_PX = 2048;
/** Smallest render edge worth asking for. */
const MIN_RENDER_PX = 16;
/** Off-screen models whose last render is kept (panning back is instant). */
const KEEP_OFFSCREEN = 24;

/** Where a model item's bytes are: GLB / glTF / FBX as stored, a .blend
 *  converted to GLB by the server. */
export const modelUrl = (hash: string) => `/blob/${hash}/model`;

type Entry = {
  texture: Texture | null;
  /** Key of the render on screen, and of the newest one asked for. */
  shownKey: string | null;
  wantedKey: string | null;
  reqId: number;
  error: string | null;
  lastUsed: number;
};

/**
 * Model items' textures: renders from the model worker (three.js on an
 * OffscreenCanvas), keyed by view settings and render size. While a new
 * render is on its way the previous one stays up; before the first, the
 * canvas draws the item's card. The worker (and three.js with it) loads
 * only when a board first shows a model.
 */
export class ModelTextureSource implements TextureSource {
  private worker: Worker | null = null;
  private readonly entries = new Map<string, Entry>();
  /** Live orbit: settings shown instead of the stored ones, at exact size. */
  private readonly previews = new Map<string, ModelSettings>();
  /** Previews let go of, kept until the stored settings catch up (the
   *  commit reaches the node a render later) — or until the deadline. */
  private readonly releasing = new Map<string, number>();
  private nextReqId = 1;
  private frame = 0;
  /** One-off renders on their way (sampling colours), by request id. */
  private readonly snapshots = new Map<number, (bitmap: ImageBitmap | null) => void>();

  constructor(private readonly onChange: () => void) {}

  /**
   * The model's current render, or null while there is none yet (the
   * caller draws a card). `scale` is render px per world px; a live orbit
   * preview renders at `exactScale` instead so it stays sharp.
   */
  texture(node: SpriteNode, level: string): Texture;
  texture(node: SpriteNode, level: string, exactScale?: number): Texture | null;
  texture(node: SpriteNode, level: string, exactScale?: number): Texture | null {
    const stored = node.model ?? modelSettings(undefined);
    let preview = this.previews.get(node.id);
    const deadline = this.releasing.get(node.id);
    if (
      preview &&
      deadline !== undefined &&
      (settingsKey(preview) === settingsKey(stored) || performance.now() > deadline)
    ) {
      this.previews.delete(node.id);
      this.releasing.delete(node.id);
      preview = undefined;
    }
    const settings = preview ?? stored;
    let scale = preview && exactScale ? exactScale : Number.parseFloat(level) || 1;
    const longEdge = Math.max(node.width, node.height) * scale;
    if (longEdge > MAX_RENDER_PX) scale *= MAX_RENDER_PX / longEdge;
    const width = Math.max(MIN_RENDER_PX, Math.round(node.width * scale));
    const height = Math.max(MIN_RENDER_PX, Math.round(node.height * scale));
    const key = `${settingsKey(settings)}|${width}x${height}`;

    let entry = this.entries.get(node.id);
    if (!entry) {
      entry = {
        texture: null,
        shownKey: null,
        wantedKey: null,
        reqId: 0,
        error: null,
        lastUsed: 0,
      };
      this.entries.set(node.id, entry);
    }
    entry.lastUsed = this.frame;
    if (entry.error) return null;
    if (entry.shownKey !== key && entry.wantedKey !== key) {
      entry.wantedKey = key;
      entry.reqId = this.nextReqId++;
      this.post({
        type: 'render',
        id: node.id,
        reqId: entry.reqId,
        url: modelUrl(node.blobHash),
        width,
        height,
        settings,
        live: !!preview,
      });
    }
    return entry.texture;
  }

  /**
   * A one-off render of a model that isn't shown (sampling its colours):
   * its own settings with the sky off, so the transparent background
   * filters out and only the model's pixels remain.
   */
  snapshot(node: SpriteNode, width: number, height: number): Promise<ImageBitmap | null> {
    const settings = { ...(node.model ?? modelSettings(undefined)), background: false };
    const reqId = this.nextReqId++;
    return new Promise((resolve) => {
      this.snapshots.set(reqId, resolve);
      this.post({
        type: 'render',
        id: `${node.id}#snapshot`,
        reqId,
        url: modelUrl(node.blobHash),
        width: Math.max(MIN_RENDER_PX, Math.round(width)),
        height: Math.max(MIN_RENDER_PX, Math.round(height)),
        settings,
        // Jumps the queue and never becomes a cached poster.
        live: true,
      });
      setTimeout(() => {
        if (this.snapshots.delete(reqId)) resolve(null);
      }, 30_000);
    });
  }

  /** Test/debug hook: what a model item shows right now. */
  status(id: string): 'card' | 'cached' | 'rendered' | `error: ${string}` {
    const entry = this.entries.get(id);
    if (entry?.error) return `error: ${entry.error}`;
    if (!entry?.texture) return 'card';
    return entry.shownKey?.startsWith('cached:') ? 'cached' : 'rendered';
  }

  /** Why the model couldn't be shown, if it couldn't. */
  error(id: string): string | null {
    return this.entries.get(id)?.error ?? null;
  }

  /** Show `settings` for a model while its view is being dragged (null =
   *  back to its stored settings, once they match). */
  setPreview(id: string, settings: ModelSettings | null): void {
    if (settings) {
      this.previews.set(id, settings);
      this.releasing.delete(id);
    } else if (this.previews.has(id)) {
      this.releasing.set(id, performance.now() + 1500);
    }
    this.onChange();
  }

  /** Keep renders for visible models (and a few recent others). */
  retain(ids: ReadonlySet<string>): void {
    const offscreen = [...this.entries.entries()]
      .filter(([id]) => !ids.has(id))
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed);
    for (const [id, entry] of offscreen.slice(KEEP_OFFSCREEN)) {
      entry.texture?.destroy(true);
      this.entries.delete(id);
      this.post({ type: 'cancel', id });
    }
    for (const [id, entry] of offscreen.slice(0, KEEP_OFFSCREEN)) {
      // Nothing to wait for off screen.
      if (entry.wantedKey !== entry.shownKey) {
        entry.wantedKey = entry.shownKey;
        this.post({ type: 'cancel', id });
      }
    }
  }

  tick(): boolean {
    this.frame += 1;
    return false;
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.texture?.destroy(true);
    this.entries.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private post(message: ToWorker): void {
    if (!this.worker) {
      this.worker = new Worker(new URL('../model/modelWorker.ts', import.meta.url), {
        type: 'module',
        name: 'refthing-model',
      });
      this.worker.addEventListener('message', (event: MessageEvent<FromWorker>) =>
        this.receive(event.data),
      );
    }
    this.worker.postMessage(message);
  }

  private receive(message: FromWorker): void {
    const snapshot = this.snapshots.get(message.reqId);
    if (snapshot) {
      this.snapshots.delete(message.reqId);
      snapshot(message.type === 'frame' ? message.bitmap : null);
      return;
    }
    const entry = this.entries.get(message.id);
    if (message.type === 'error') {
      if (entry && message.reqId === entry.reqId) {
        entry.error = message.message;
        this.onChange();
      }
      return;
    }
    // Stale (a newer render was asked for) or the item is gone: drop it —
    // except a first picture, which beats a card while the newer one comes.
    const current = !!entry && message.reqId === entry.reqId;
    if (!entry || (!current && entry.texture)) {
      message.bitmap.close();
      return;
    }
    const previous = entry.texture;
    entry.texture = Texture.from(message.bitmap);
    if (current && !message.cached) entry.shownKey = entry.wantedKey;
    else if (current) entry.shownKey = `cached:${entry.wantedKey}`;
    previous?.destroy(true);
    this.onChange();
  }
}
