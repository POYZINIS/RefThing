import { Application, ColorMatrixFilter, Container, Sprite, Texture } from 'pixi.js';
import { blobUrl, type Item, type ItemPatch } from '@/api/client';

export type ViewportState = { x: number; y: number; zoom: number };

type CanvasOptions = {
  initialViewport?: ViewportState;
  onViewportChange?: (viewport: ViewportState) => void;
  onSelectionChange?: (itemId: string | null) => void;
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
  private readonly options: CanvasOptions;
  private readonly grid = new Map<string, Item[]>();
  private items: Item[] = [];
  private dragging = false;
  private draggingItem: { item: Item; startX: number; startY: number } | null = null;
  private activeItem: Item | null = null;
  private lastPointer = { x: 0, y: 0 };
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

  update(items: Item[]): void {
    this.items = items.filter((item) => item.type === 'image' && item.blob_hash);
    this.grid.clear();
    for (const item of this.items) {
      for (const key of this.coveredCells(item)) {
        const cell = this.grid.get(key) ?? [];
        cell.push(item);
        this.grid.set(key, cell);
      }
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
    if (!this.initialized) return;
    this.app.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.app.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.app.ticker.remove(this.onTick);
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
        sprite.cursor = 'pointer';
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
    const point = this.worldPoint(event);
    const item = this.hitTest(point.x, point.y);
    this.options.onSelectionChange?.(item?.id ?? null);
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.app.canvas.setPointerCapture(event.pointerId);
    if (item) {
      this.activeItem = item;
      this.draggingItem = { item, startX: point.x, startY: point.y };
    } else {
      this.dragging = true;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.draggingItem) {
      const point = this.worldPoint(event);
      const { item, startX, startY } = this.draggingItem;
      const rawX = item.x + point.x - startX;
      const rawY = item.y + point.y - startY;
      const grid = this.options.snapToGrid ? 24 : 1;
      const nextX = Math.round(rawX / grid) * grid;
      const nextY = Math.round(rawY / grid) * grid;
      const deltaX = nextX - item.x;
      const deltaY = nextY - item.y;
      const moving = item.group_id
        ? this.items.filter((candidate) => candidate.group_id === item.group_id)
        : [item];
      for (const candidate of moving) {
        this.sprites
          .get(candidate.id)
          ?.position.set(
            candidate.x + candidate.width / 2 + deltaX,
            candidate.y + candidate.height / 2 + deltaY,
          );
      }
      return;
    }
    if (!this.dragging) return;
    this.viewport.x += event.clientX - this.lastPointer.x;
    this.viewport.y += event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };
  };

  private readonly onPointerUp = (): void => {
    if (this.draggingItem && this.activeItem) {
      const moving = this.activeItem.group_id
        ? this.items.filter((candidate) => candidate.group_id === this.activeItem?.group_id)
        : [this.activeItem];
      const changes = moving.flatMap((item) => {
        const sprite = this.sprites.get(item.id);
        return sprite
          ? [
              {
                itemId: item.id,
                patch: { x: sprite.x - item.width / 2, y: sprite.y - item.height / 2 },
              },
            ]
          : [];
      });
      if (changes.length > 1) this.options.onItemsChange?.(changes);
      else if (changes[0]) this.options.onItemChange?.(changes[0].itemId, changes[0].patch);
    }
    this.draggingItem = null;
    this.activeItem = null;
    this.dragging = false;
    this.options.onViewportChange?.(this.getViewport());
  };

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
    this.options.onViewportChange?.(this.getViewport());
  };
}
