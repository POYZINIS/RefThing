import { Application, ColorMatrixFilter, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { blobUrl, type Item, type ItemPatch } from '@/api/client';
import { closeGif, decodeGif, type GifDecode, gifDecodingSupported } from './gif';

export type ViewportState = { x: number; y: number; zoom: number };

type CanvasOptions = {
  initialViewport?: ViewportState;
  onViewportChange?: (viewport: ViewportState, source?: 'pan' | 'zoom' | 'release') => void;
  onSelectionChange?: (itemId: string | null) => void;
  onMultiSelectChange?: (itemIds: string[]) => void;
  onBoxSelect?: (worldRect: { x1: number; y1: number; x2: number; y2: number }) => void;
  onClearSelection?: () => void;
  onHoverChange?: (itemId: string | null) => void;
  onItemChange?: (itemId: string, patch: ItemPatch) => void;
  onItemsChange?: (changes: Array<{ itemId: string; patch: ItemPatch }>) => void;
  snapToGrid?: boolean;
};

export class BoardCanvas {
  private readonly app = new Application();
  private readonly scene = new Container();
  private readonly sprites = new Map<string, Sprite>();
  private readonly textures = new Map<string, Texture>();
  private readonly loadingTextures = new Set<string>();
  private readonly failedTextures = new Set<string>();
  // Animated GIF state, keyed by blob hash.
  private readonly gifFrames = new Map<string, GifDecode | null>();
  private readonly gifLoading = new Set<string>();
  private readonly gifTime = new Map<string, number>();
  private gifHashes = new Set<string>();
  private lastGifTick: number | null = null;
  private readonly options: CanvasOptions;
  private readonly grid = new Map<string, Item[]>();
  private items: Item[] = [];
  private dragging = false;
  private draggingItem: {
    item: Item;
    startX: number;
    startY: number;
    // Item positions at drag start — the anchor the delta is applied to.
    // NEVER recompute from the mutated in-progress position, or every
    // pointermove double-counts the delta.
    originX: number;
    originY: number;
  } | null = null;
  private activeItem: Item | null = null;
  private lastPointer = { x: 0, y: 0 };
  private hoveredItem: Item | null = null;
  private boxSelectOrigin: { x: number; y: number } | null = null;
  private boxSelectCurrent: { x: number; y: number } | null = null;
  private boxSelectGraphic: Graphics | null = null;
  private viewport: ViewportState;
  private renderedViewport: ViewportState;
  private initialized = false;
  private destroyed = false;
  private grayscale = false;

  constructor(options: CanvasOptions = {}) {
    this.options = options;
    this.viewport = options.initialViewport ?? { x: 0, y: 0, zoom: 1 };
    this.renderedViewport = { ...this.viewport };
  }

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({
      background: '#111318',
      resizeTo: host,
      antialias: true,
      resolution: window.devicePixelRatio,
      autoDensity: true,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.initialized = true;
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.scene);
    this.applyViewport();
    this.app.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.app.canvas.addEventListener('pointermove', this.onPointerMove);
    this.app.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    this.app.ticker.add(this.onTick);
    this.renderVisible();
  }

  update(items: Item[], gifHashes: ReadonlySet<string> = new Set()): void {
    this.gifHashes = new Set(gifHashes);
    // If an item is mid-drag, React re-renders (selection change etc.) with
    // the *server* snapshot which still has the pre-drag position. Merge the
    // in-flight drag position back in so the sprite doesn't snap to the old
    // spot between pointermove and pointerup.
    //
    // The live objects are reused BY REFERENCE (never copied): draggingItem
    // and onPointerUp read x/y from that same object, so it must stay the
    // object painted in this.items. The only field the live object may have
    // stale is z_index — a bring-to-front fired on pointerdown applies
    // optimistically, so adopt the incoming z_index onto the live object to
    // make it paint on press instead of release.
    const live = this.draggingItem ? this.items : null;
    this.items = items.filter((item) => item.type === 'image' && item.blob_hash);
    if (live) {
      const byId = new Map(live.map((item) => [item.id, item]));
      this.items = this.items.map((item) => {
        const inFlight = byId.get(item.id);
        if (!inFlight) return item;
        inFlight.z_index = item.z_index;
        return inFlight;
      });
    }
    this.grid.clear();
    for (const item of this.items) {
      for (const key of this.coveredCells(item)) {
        const cell = this.grid.get(key) ?? [];
        cell.push(item);
        this.grid.set(key, cell);
      }
    }
    for (const hash of this.gifFrames.keys()) {
      if (!this.gifHashes.has(hash)) this.forgetGif(hash);
    }
    for (const item of this.items) {
      const hash = item.blob_hash;
      if (hash && this.gifHashes.has(hash)) this.ensureGif(hash);
    }
    this.renderVisible();
  }

  setViewport(viewport: ViewportState): void {
    this.viewport = { ...viewport, zoom: Math.max(0.1, Math.min(4, viewport.zoom)) };
    this.renderedViewport = { ...this.viewport };
    this.applyViewport();
    this.renderVisible();
  }

  getViewport(): ViewportState {
    return { ...this.viewport };
  }

  clearTextureFailures(): void {
    this.failedTextures.clear();
    this.renderVisible();
  }

  setGrayscale(enabled: boolean): void {
    this.grayscale = enabled;
    for (const sprite of this.sprites.values()) {
      sprite.filters = enabled ? [new ColorMatrixFilter()] : [];
      if (enabled) (sprite.filters[0] as ColorMatrixFilter).grayscale(1, false);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.updateHover(null);
    if (!this.initialized) return;
    this.app.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.app.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.app.ticker.remove(this.onTick);
    for (const decode of this.gifFrames.values()) if (decode) closeGif(decode);
    this.gifFrames.clear();
    this.app.destroy(true, { children: true, texture: false });
  }

  private renderVisible(): void {
    if (!this.initialized) return;
    const visibleItems = this.visibleItems();
    const nextIds = new Set(visibleItems.map((item) => item.id));
    for (const [id, sprite] of this.sprites) {
      if (!nextIds.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
    for (const item of visibleItems) {
      if (!item.blob_hash) continue;
      let sprite = this.sprites.get(item.id);
      if (!sprite) {
        sprite = new Sprite(this.textureFor(item, this.levelFor(item)));
        sprite.anchor.set(0.5);
        sprite.eventMode = 'static';
        // §5: hover over an unselected item body = grab (open hand / four-way
        // move icon), not the default pointer arrow.
        sprite.cursor = 'grab';
        this.scene.addChild(sprite);
        this.sprites.set(item.id, sprite);
      }
      sprite.texture = this.textureFor(item, this.levelFor(item));
      sprite.position.set(item.x + item.width / 2, item.y + item.height / 2);
      sprite.width = item.width;
      sprite.height = item.height;
      sprite.rotation = (item.rotation * Math.PI) / 180;
      sprite.zIndex = item.z_index;
      if (this.grayscale) {
        const filter = new ColorMatrixFilter();
        filter.grayscale(1, false);
        sprite.filters = [filter];
      } else {
        sprite.filters = [];
      }
    }
    this.scene.sortableChildren = true;
  }

  private textureFor(item: Item, level: string): Texture {
    const animated = item.blob_hash && this.gifFrames.get(item.blob_hash);
    if (animated) return this.gifTextureFor(item, animated);
    const key = `${item.blob_hash}-${level}`;
    const existing = this.textures.get(key);
    if (existing) return existing;
    if (this.failedTextures.has(key)) {
      return level === 'full' ? Texture.WHITE : this.textureFor(item, 'full');
    }
    if (!this.loadingTextures.has(key)) {
      this.loadingTextures.add(key);
      const image = new Image();
      image.onload = () => {
        this.textures.set(key, Texture.from(image));
        this.loadingTextures.delete(key);
        this.renderVisible();
      };
      image.onerror = () => {
        this.loadingTextures.delete(key);
        this.failedTextures.add(key);
        this.renderVisible();
      };
      image.src = blobUrl(item.blob_hash ?? '', level);
    }
    return level === 'full' ? Texture.WHITE : this.textureFor(item, 'full');
  }

  /** Current frame texture for a decoded GIF, falling back to the first frame. */
  private gifTextureFor(item: Item, decode: GifDecode): Texture {
    const hash = item.blob_hash ?? '';
    const frameIndex = this.gifFrameIndex(hash, decode);
    const key = `gif:${hash}:${frameIndex}`;
    const existing = this.textures.get(key);
    if (existing) return existing;
    const frame = decode.frames[frameIndex] ?? decode.frames[0];
    if (!frame) return Texture.WHITE;
    const texture = Texture.from(frame.bitmap);
    this.textures.set(key, texture);
    return texture;
  }

  /** Which frame a GIF is currently on, derived from its accumulated time. */
  private gifFrameIndex(hash: string, decode: GifDecode): number {
    const elapsed = this.gifTime.get(hash) ?? 0;
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
  private ensureGif(hash: string): void {
    if (this.gifFrames.has(hash) || this.gifLoading.has(hash)) return;
    this.gifLoading.add(hash);
    void decodeGif(blobUrl(hash, 'full')).then((decode) => {
      this.gifLoading.delete(hash);
      this.gifFrames.set(hash, decode);
      this.gifTime.set(hash, 0);
      this.renderVisible();
    });
  }

  /** Drop a GIF's frames and any textures derived from them. */
  private forgetGif(hash: string): void {
    const decode = this.gifFrames.get(hash);
    if (decode) closeGif(decode);
    this.gifFrames.delete(hash);
    this.gifTime.delete(hash);
    for (const key of [...this.textures.keys()]) {
      if (key.startsWith(`gif:${hash}:`)) this.textures.delete(key);
    }
    this.renderVisible();
  }

  /**
   * Advance GIF frame clocks for currently-animated items, in render-loop
   * time. Only runs when the browser can actually decode GIFs; otherwise the
   * items render as static posters from the pyramid pipeline.
   */
  private advanceGifs(position: number): void {
    if (!gifDecodingSupported()) return;
    if (this.gifFrames.size === 0) return;
    const dt = Math.min(position - (this.lastGifTick ?? position), 100);
    this.lastGifTick = position;
    if (dt <= 0) return;
    for (const item of this.items) {
      const hash = item.blob_hash;
      if (!hash || !this.gifHashes.has(hash)) continue;
      const decode = this.gifFrames.get(hash);
      if (!decode || decode.frames.length < 2) continue;
      const before = this.gifFrameIndex(hash, decode);
      this.gifTime.set(hash, (this.gifTime.get(hash) ?? 0) + dt);
      const after = this.gifFrameIndex(hash, decode);
      if (after !== before) this.renderVisible();
    }
  }

  private levelFor(item: Item): string {
    const displayEdge = Math.max(item.width, item.height) * this.renderedViewport.zoom;
    if (displayEdge <= 64) return 'thumb';
    if (displayEdge <= 256) return 'small';
    if (displayEdge <= 1024) return 'medium';
    return 'full';
  }

  private visibleItems(): Item[] {
    const width = this.app.screen.width / this.renderedViewport.zoom;
    const height = this.app.screen.height / this.renderedViewport.zoom;
    const left = -this.renderedViewport.x / this.renderedViewport.zoom - 256;
    const top = -this.renderedViewport.y / this.renderedViewport.zoom - 256;
    const right = left + width + 512;
    const bottom = top + height + 512;
    const candidates = new Map<string, Item>();
    const cellSize = 512;
    for (let x = Math.floor(left / cellSize); x <= Math.floor(right / cellSize); x += 1) {
      for (let y = Math.floor(top / cellSize); y <= Math.floor(bottom / cellSize); y += 1) {
        for (const item of this.grid.get(`${x}:${y}`) ?? []) candidates.set(item.id, item);
      }
    }
    return [...candidates.values()].filter((item) => {
      const radians = (item.rotation * Math.PI) / 180;
      const halfWidth =
        (Math.abs(item.width * Math.cos(radians)) + Math.abs(item.height * Math.sin(radians))) / 2;
      const halfHeight =
        (Math.abs(item.width * Math.sin(radians)) + Math.abs(item.height * Math.cos(radians))) / 2;
      const centerX = item.x + item.width / 2;
      const centerY = item.y + item.height / 2;
      return (
        centerX - halfWidth < right &&
        centerX + halfWidth > left &&
        centerY - halfHeight < bottom &&
        centerY + halfHeight > top
      );
    });
  }

  private coveredCells(item: Item): string[] {
    const cellSize = 512;
    const cells: string[] = [];
    for (
      let x = Math.floor(item.x / cellSize);
      x <= Math.floor((item.x + item.width) / cellSize);
      x += 1
    ) {
      for (
        let y = Math.floor(item.y / cellSize);
        y <= Math.floor((item.y + item.height) / cellSize);
        y += 1
      )
        cells.push(`${x}:${y}`);
    }
    return cells;
  }

  private applyViewport(): void {
    this.scene.position.set(this.renderedViewport.x, this.renderedViewport.y);
    this.scene.scale.set(this.renderedViewport.zoom);
  }

  private readonly onTick = (): void => {
    const frame = performance.now();
    this.advanceGifs(frame);
    const easing = 0.18;
    this.renderedViewport.x += (this.viewport.x - this.renderedViewport.x) * easing;
    this.renderedViewport.y += (this.viewport.y - this.renderedViewport.y) * easing;
    this.renderedViewport.zoom += (this.viewport.zoom - this.renderedViewport.zoom) * easing;
    if (
      Math.abs(this.viewport.x - this.renderedViewport.x) < 0.05 &&
      Math.abs(this.viewport.y - this.renderedViewport.y) < 0.05 &&
      Math.abs(this.viewport.zoom - this.renderedViewport.zoom) < 0.0005
    )
      this.renderedViewport = { ...this.viewport };
    this.applyViewport();
    this.renderVisible();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Ignore right-click (context menu reserved for §14).
    if (event.button === 2) return;

    this.lastPointer = { x: event.clientX, y: event.clientY };
    try {
      this.app.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Drag still works via explicit pointermove/up on the canvas.
    }

    // §0.4 MIDDLE-CLICK PAN: middle button always pans, even over items.
    if (event.button === 1) {
      this.updateHover(null);
      this.dragging = true;
      return;
    }

    // Left button
    const point = this.worldPoint(event);
    const item = this.hitTest(point.x, point.y);

    if (item) {
      // Select + drag item
      this.options.onSelectionChange?.(item.id);
      this.updateHover(null);
      this.activeItem = item;
      this.draggingItem = {
        item,
        startX: point.x,
        startY: point.y,
        originX: item.x,
        originY: item.y,
      };
      return;
    }

    // §14 BOX SELECT: left-click on empty canvas starts box selection.
    this.options.onClearSelection?.();
    this.options.onSelectionChange?.(null);
    this.updateHover(null);
    this.boxSelectOrigin = { x: event.clientX, y: event.clientY };
    this.boxSelectCurrent = { x: event.clientX, y: event.clientY };
    if (!this.boxSelectGraphic) {
      this.boxSelectGraphic = new Graphics();
      this.app.stage.addChild(this.boxSelectGraphic);
    }
  };

  /**
   * Drag math (Phase 5 note in the plan): snapshot the pointer's world
   * position and the item's position at pointerdown; on every move compute
   * `delta = worldPoint(event) - startWorld` and set
   * `item.position = itemStart + delta` — NEVER assign the item's position
   * directly to the converted pointer position. The same worldPoint() is
   * used for hit-testing, dragging, and panning so the transforms never
   * drift.
   */
  private readonly onPointerMove = (event: PointerEvent): void => {
    // §14 BOX SELECT: drag draws the selection rectangle.
    if (this.boxSelectOrigin) {
      this.boxSelectCurrent = { x: event.clientX, y: event.clientY };
      this.drawBoxSelectRect();
      return;
    }
    if (this.draggingItem) {
      const point = this.worldPoint(event);
      const { item, startX, startY, originX, originY } = this.draggingItem;
      // PureRef delta contract: item = origin + (pointer - startPointer),
      // snapped to grid. origin never changes during the drag, so repeated
      // pointermove events don't accumulate.
      const grid = this.options.snapToGrid ? 24 : 1;
      const nextX = Math.round((originX + point.x - startX) / grid) * grid;
      const nextY = Math.round((originY + point.y - startY) / grid) * grid;
      const deltaX = nextX - item.x;
      const deltaY = nextY - item.y;
      const moving = item.group_id
        ? this.items.filter((candidate) => candidate.group_id === item.group_id)
        : [item];
      // Mutate in-place so renderVisible() (which repositions from
      // this.items) follows the drag each frame instead of snapping back.
      for (const candidate of moving) {
        candidate.x += deltaX;
        candidate.y += deltaY;
      }
      return;
    }
    if (this.dragging) {
      this.viewport.x += event.clientX - this.lastPointer.x;
      this.viewport.y += event.clientY - this.lastPointer.y;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      // Notify React during pan so DOM overlays (notes) track the viewport
      // in real time instead of snapping to the final position on release.
      this.options.onViewportChange?.(this.getViewport(), 'pan');
      return;
    }
    // §1 HOVERED: report the item under the cursor (or null) while idle so
    // the UI can draw the 1px 40% hover outline on unselected items.
    const point = this.worldPoint(event);
    this.updateHover(this.hitTest(point.x, point.y));
  };

  private updateHover(item: Item | null): void {
    if (item === this.hoveredItem) return;
    this.hoveredItem = item;
    this.options.onHoverChange?.(item?.id ?? null);
  }

  private readonly onPointerUp = (): void => {
    // §14 BOX SELECT: commit the selection rectangle.
    if (this.boxSelectOrigin) {
      this.commitBoxSelect();
      this.clearBoxSelect();
    } else if (this.draggingItem && this.activeItem) {
      // The items were already mutated in-place during the drag
      // (onPointerMove), so just read their current positions.
      const moving = this.activeItem.group_id
        ? this.items.filter((candidate) => candidate.group_id === this.activeItem?.group_id)
        : [this.activeItem];
      const changes = moving.map((item) => ({
        itemId: item.id,
        patch: { x: item.x, y: item.y },
      }));
      if (changes.length > 1) this.options.onItemsChange?.(changes);
      else if (changes[0]) this.options.onItemChange?.(changes[0].itemId, changes[0].patch);
    }
    this.draggingItem = null;
    this.activeItem = null;
    this.dragging = false;
    this.updateHover(null);
    this.options.onViewportChange?.(this.getViewport(), 'release');
  };

  // ── §14 BOX SELECT helpers ─────────────────────────────────────────

  /** Client coords → canvas-local coords (the Graphics lives on the stage,
   *  whose origin is the canvas top-left, NOT the window). */
  private canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private drawBoxSelectRect(): void {
    if (!this.boxSelectOrigin || !this.boxSelectCurrent || !this.boxSelectGraphic) return;
    const origin = this.canvasPoint(this.boxSelectOrigin.x, this.boxSelectOrigin.y);
    const current = this.canvasPoint(this.boxSelectCurrent.x, this.boxSelectCurrent.y);
    const x = Math.min(origin.x, current.x);
    const y = Math.min(origin.y, current.y);
    const w = Math.abs(current.x - origin.x);
    const h = Math.abs(current.y - origin.y);
    this.boxSelectGraphic.clear();
    if (w > 0 && h > 0) {
      this.boxSelectGraphic.rect(x, y, w, h);
      this.boxSelectGraphic.fill({ color: 0xd6ff76, alpha: 0.15 });
      this.boxSelectGraphic.stroke({ color: 0xd6ff76, alpha: 0.6, width: 1 });
    }
  }

  private commitBoxSelect(): void {
    if (!this.boxSelectOrigin || !this.boxSelectCurrent) return;
    const dx = Math.abs(this.boxSelectCurrent.x - this.boxSelectOrigin.x);
    const dy = Math.abs(this.boxSelectCurrent.y - this.boxSelectOrigin.y);
    // Too small to be intentional → treat as click (deselect all).
    if (dx < 3 && dy < 3) {
      this.options.onMultiSelectChange?.([]);
      return;
    }
    // Convert screen rect → world rect. Subtract the canvas's page offset
    // and the viewport translation, then divide by zoom — same transform
    // worldPoint() uses.
    const rect = this.app.canvas.getBoundingClientRect();
    const x1 = Math.min(this.boxSelectOrigin.x, this.boxSelectCurrent.x) - rect.left;
    const y1 = Math.min(this.boxSelectOrigin.y, this.boxSelectCurrent.y) - rect.top;
    const x2 = Math.max(this.boxSelectOrigin.x, this.boxSelectCurrent.x) - rect.left;
    const y2 = Math.max(this.boxSelectOrigin.y, this.boxSelectCurrent.y) - rect.top;
    const wx1 = (x1 - this.renderedViewport.x) / this.renderedViewport.zoom;
    const wy1 = (y1 - this.renderedViewport.y) / this.renderedViewport.zoom;
    const wx2 = (x2 - this.renderedViewport.x) / this.renderedViewport.zoom;
    const wy2 = (y2 - this.renderedViewport.y) / this.renderedViewport.zoom;
    const hit = this.items.filter((it) => {
      const r = it.x + it.width;
      const b = it.y + it.height;
      return it.x < wx2 && r > wx1 && it.y < wy2 && b > wy1;
    });
    this.options.onMultiSelectChange?.(hit.map((it) => it.id));
    this.options.onBoxSelect?.({ x1: wx1, y1: wy1, x2: wx2, y2: wy2 });
  }

  private clearBoxSelect(): void {
    this.boxSelectOrigin = null;
    this.boxSelectCurrent = null;
    this.boxSelectGraphic?.clear();
  }

  private worldPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.renderedViewport.x) / this.renderedViewport.zoom,
      y: (event.clientY - rect.top - this.renderedViewport.y) / this.renderedViewport.zoom,
    };
  }

  private hitTest(x: number, y: number): Item | null {
    return (
      [...this.visibleItems()]
        .sort((left, right) => right.z_index - left.z_index)
        .find((item) => {
          const centerX = item.x + item.width / 2;
          const centerY = item.y + item.height / 2;
          const radians = (-item.rotation * Math.PI) / 180;
          const localX = (x - centerX) * Math.cos(radians) - (y - centerY) * Math.sin(radians);
          const localY = (x - centerX) * Math.sin(radians) + (y - centerY) * Math.cos(radians);
          return Math.abs(localX) <= item.width / 2 && Math.abs(localY) <= item.height / 2;
        }) ?? null
    );
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const previousZoom = this.renderedViewport.zoom;
    const nextZoom = Math.max(0.1, Math.min(4, previousZoom * (event.deltaY < 0 ? 1.1 : 0.9)));
    const rect = this.app.canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const worldX = (pointerX - this.renderedViewport.x) / previousZoom;
    const worldY = (pointerY - this.renderedViewport.y) / previousZoom;
    this.viewport.zoom = nextZoom;
    this.viewport.x = pointerX - worldX * nextZoom;
    this.viewport.y = pointerY - worldY * nextZoom;
    this.renderVisible();
    this.options.onViewportChange?.(this.getViewport(), 'zoom');
  };
}
