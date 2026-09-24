import { Application, Container, Graphics } from 'pixi.js';
import type { Item, Note } from '@/api/client';
import { screenToWorld } from './coordinates';
import { NodeInteractionController } from './NodeInteractionController';
import { itemToNode, noteToNode } from './nodes/adapters';
import type { GifTextureSource } from './nodes/GifTextureSource';
import type { NodeRenderer } from './nodes/NodeRenderer';
import { type PyramidTextureSource, pyramidLevel } from './nodes/PyramidTextureSource';
import { nodeKindRegistry } from './nodes/registry';
import type { BoardNode, NodeChange, SpriteNode } from './nodes/types';

export type ViewportState = { x: number; y: number; zoom: number };

type CanvasOptions = {
  initialViewport?: ViewportState;
  onViewportChange?: (viewport: ViewportState, source?: 'pan' | 'zoom' | 'release') => void;
  /** The eased camera Pixi actually painted this frame. DOM overlays (notes,
   *  selection shell, outlines) must position from THIS, not the target
   *  viewport, or they run ahead of the canvas while easing. */
  onRenderedViewportChange?: (viewport: ViewportState) => void;
  onSelectionChange?: (nodeId: string | null) => void;
  onSelectionToggle?: (nodeId: string) => void;
  onMultiSelectChange?: (nodeIds: string[]) => void;
  onBoxSelect?: (worldRect: { x1: number; y1: number; x2: number; y2: number }) => void;
  onClearSelection?: () => void;
  onHoverChange?: (nodeId: string | null) => void;
  onDragPreview?: (changes: NodeChange[]) => void;
  onNodesChange?: (changes: NodeChange[]) => void;
  snapToGrid?: boolean;
};

/**
 * Renders sprite-kind nodes (images, gifs) and owns the board's pointer
 * input. Notes arrive as geometry-only nodes for hit-testing and box
 * select — they render through the DOM NoteOverlay.
 *
 * LIMITATION: the notes DOM layer paints above the Pixi canvas layer, so a
 * note always visually covers an item of higher item-z. The interaction
 * layer mirrors that order (notes win hit tests). Full interleave requires
 * Pixi-rendered notes.
 */
export class BoardCanvas {
  private readonly app = new Application();
  private readonly scene = new Container();
  private readonly renderers = new Map<string, NodeRenderer>();
  private readonly pyramidTextures: PyramidTextureSource =
    nodeKindRegistry.image.textureSourceFactory({
      onChange: () => this.renderVisible(),
    });
  private readonly gifTextures: GifTextureSource = nodeKindRegistry.gif.textureSourceFactory({
    onChange: () => this.renderVisible(),
    fallback: this.pyramidTextures,
  });
  private readonly options: CanvasOptions;
  private readonly controller: NodeInteractionController;
  private readonly grid = new Map<string, SpriteNode[]>();
  private spriteNodes: SpriteNode[] = [];
  private noteNodes: BoardNode[] = [];
  private panning = false;
  private lastPointer = { x: 0, y: 0 };
  /** Last native pointerdown the controller handled — the selection shell's
   *  window-level listener forwards presses it can't place, and event
   *  identity is how it avoids double-processing canvas/note presses. */
  private handledPress: PointerEvent | null = null;
  private boxSelectGraphic: Graphics | null = null;
  private viewport: ViewportState;
  private renderedViewport: ViewportState;
  private publishedViewport: ViewportState | null = null;
  private initialized = false;
  private destroyed = false;
  private grayscale = false;

  constructor(options: CanvasOptions = {}) {
    this.options = options;
    this.viewport = options.initialViewport ?? { x: 0, y: 0, zoom: 1 };
    this.renderedViewport = { ...this.viewport };
    this.controller = new NodeInteractionController(
      {
        spriteCandidates: () => this.visibleSpriteNodes(),
        noteNodes: () => this.noteNodes,
        allNodes: () => [...this.spriteNodes, ...this.noteNodes],
        worldPoint: (clientX, clientY) => this.worldPoint(clientX, clientY),
        drawBoxSelect: (origin, current) => this.drawBoxSelect(origin, current),
      },
      {
        onSelectionChange: (nodeId) => this.options.onSelectionChange?.(nodeId),
        onSelectionToggle: (nodeId) => this.options.onSelectionToggle?.(nodeId),
        onMultiSelectChange: (nodeIds) => this.options.onMultiSelectChange?.(nodeIds),
        onClearSelection: () => this.options.onClearSelection?.(),
        onHoverChange: (nodeId) => this.options.onHoverChange?.(nodeId),
        onBoxSelect: (worldRect) => this.options.onBoxSelect?.(worldRect),
        onDragPreview: (changes) => this.options.onDragPreview?.(changes),
        onNodesChange: (changes) => this.options.onNodesChange?.(changes),
      },
      options.snapToGrid ?? false,
    );
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
    window.addEventListener('pointercancel', this.onPointerUp);
    this.app.ticker.add(this.onTick);
    this.renderVisible();
  }

  update(items: Item[], gifHashes: ReadonlySet<string> = new Set(), notes: Note[] = []): void {
    // If a node is mid-drag, React re-renders (selection change etc.) with
    // the *server* snapshot which still has the pre-drag position. Merge the
    // in-flight drag position back in so the sprite doesn't snap to the old
    // spot between pointermove and pointerup.
    //
    // The live nodes are reused BY REFERENCE (never copied): the controller's
    // drag state and release read x/y from that same object, so it must stay
    // the object painted from. The only fields the live node may have stale
    // are zIndex (a bring-to-front fired on pointerdown applies
    // optimistically, so adopt the incoming zIndex onto the live node to
    // make it paint on press instead of release) and kind (a blob's MIME —
    // hence gif-ness — can arrive after the node was created).
    const live = this.controller.isDragging;
    const liveSprites = live ? this.spriteNodes : null;
    const liveNotes = live ? this.noteNodes : null;
    this.spriteNodes = items
      .filter(
        (item): item is Item & { blob_hash: string } => item.type === 'image' && !!item.blob_hash,
      )
      .map((item) => itemToNode(item, gifHashes.has(item.blob_hash)));
    this.noteNodes = notes.map(noteToNode);
    if (liveSprites && liveNotes) {
      const spriteById = new Map(liveSprites.map((node) => [node.id, node]));
      this.spriteNodes = this.spriteNodes.map((node) => {
        const inFlight = spriteById.get(node.id);
        if (!inFlight) return node;
        inFlight.zIndex = node.zIndex;
        inFlight.kind = node.kind;
        return inFlight;
      });
      const noteById = new Map(liveNotes.map((node) => [node.id, node]));
      this.noteNodes = this.noteNodes.map((node) => {
        const inFlight = noteById.get(node.id);
        if (!inFlight) return node;
        inFlight.zIndex = node.zIndex;
        return inFlight;
      });
    }
    this.grid.clear();
    for (const node of this.spriteNodes) {
      for (const key of this.coveredCells(node)) {
        const cell = this.grid.get(key) ?? [];
        cell.push(node);
        this.grid.set(key, cell);
      }
    }
    this.gifTextures.sync(
      gifHashes,
      new Set(this.spriteNodes.filter((node) => node.kind === 'gif').map((node) => node.blobHash)),
    );
    this.renderVisible();
  }

  setViewport(viewport: ViewportState): void {
    this.viewport = { ...viewport, zoom: Math.max(0.1, Math.min(4, viewport.zoom)) };
    this.renderedViewport = { ...this.viewport };
    this.applyViewport();
    this.renderVisible();
    this.publishRenderedViewport();
  }

  getViewport(): ViewportState {
    return { ...this.viewport };
  }

  clearTextureFailures(): void {
    this.pyramidTextures.clearFailures();
    this.renderVisible();
  }

  setGrayscale(enabled: boolean): void {
    this.grayscale = enabled;
    for (const renderer of this.renderers.values()) {
      renderer.setGrayscale(enabled);
    }
  }

  /**
   * A note article's pointerdown, forwarded by the DOM overlay: the note's
   * own node id skips the hit test, then everything (select, drag, pan)
   * runs through the same controller path as a canvas press.
   */
  notePointerDown(nodeId: string, event: PointerEvent): void {
    if (event.button === 2) return;
    this.capturePress(event);
    // §0.4 MIDDLE-CLICK PAN: middle button always pans, even over items.
    if (event.button === 1) {
      this.startPan();
      return;
    }
    this.controller.pressNodeById(nodeId, event);
  }

  /**
   * A non-left press on DOM chrome layered over the canvas (the selection
   * shell). Middle-drag pans exactly as it would on bare canvas; the right
   * button is left to the contextmenu event.
   */
  chromePointerDown(event: PointerEvent): void {
    if (event.button !== 1) return;
    this.capturePress(event);
    this.startPan();
  }

  /** Capture on the canvas so the gesture keeps receiving moves after the
   *  pressed DOM element goes inert or the pointer leaves it. */
  private capturePress(event: PointerEvent): void {
    this.handledPress = event;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    try {
      this.app.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Drag still works via explicit pointermove/up on the canvas.
    }
  }

  private startPan(): void {
    this.controller.clearHover();
    this.panning = true;
  }

  /**
   * Press the selection shell couldn't place (clicked outside the selection
   * box). Only structural empty-area targets are forwarded — the frame
   * itself or the hit-zone strips past the canvas overflow; interactive
   * chrome (search bar, sidebar, drawing layer) keeps its own behavior and
   * never clears the selection from here. Runs through the same controller
   * path as any canvas press, so out-of-box clicks clear the selection — or
   * hit another node and select it. Events the controller already handled
   * (canvas element or note article presses) are deduped by identity.
   */
  overlayPointerDown(event: PointerEvent): void {
    if (event === this.handledPress) return;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    const emptyArea =
      target !== null &&
      (target === document.body ||
        target.id === 'canvas-host' ||
        target.classList.contains('canvas-frame'));
    if (!emptyArea) return;
    this.handledPress = event;
    this.controller.press(event);
  }

  /** Where Pixi actually painted a node, in client px (AABB), or null when
   *  it isn't mounted. Dev/test hook: lets browser tests assert DOM chrome
   *  against the real render, not against the same math that placed it. */
  paintedClientRect(
    nodeId: string,
  ): { x: number; y: number; width: number; height: number } | null {
    const bounds = this.renderers.get(nodeId)?.paintedBounds();
    if (!bounds || !this.initialized) return null;
    const rect = this.app.canvas.getBoundingClientRect();
    return { ...bounds, x: bounds.x + rect.left, y: bounds.y + rect.top };
  }

  /** Id of the topmost node under a client point, or null. */
  nodeIdAt(clientX: number, clientY: number): string | null {
    return this.controller.nodeAt(clientX, clientY)?.id ?? null;
  }

  destroy(): void {
    this.destroyed = true;
    this.controller.clearHover();
    if (!this.initialized) return;
    this.app.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.app.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.app.ticker.remove(this.onTick);
    this.gifTextures.dispose();
    this.pyramidTextures.dispose();
    this.app.destroy(true, { children: true, texture: false });
  }

  private renderVisible(): void {
    if (!this.initialized) return;
    const visibleNodes = this.visibleSpriteNodes();
    const nextIds = new Set(visibleNodes.map((node) => node.id));
    for (const [id, renderer] of this.renderers) {
      if (!nextIds.has(id)) {
        renderer.destroy();
        this.renderers.delete(id);
      }
    }
    for (const node of visibleNodes) {
      let renderer = this.renderers.get(node.id);
      if (!renderer) {
        renderer = nodeKindRegistry[node.kind].rendererFactory();
        renderer.mount(this.scene);
        this.renderers.set(node.id, renderer);
      }
      const source = node.kind === 'gif' ? this.gifTextures : this.pyramidTextures;
      renderer.sync(node, {
        texture: source.texture(node, this.levelFor(node)),
        grayscale: this.grayscale,
      });
    }
    this.scene.sortableChildren = true;
  }

  private levelFor(node: SpriteNode): string {
    const displayEdge = Math.max(node.width, node.height) * this.renderedViewport.zoom;
    return pyramidLevel(displayEdge);
  }

  private visibleSpriteNodes(): SpriteNode[] {
    const width = this.app.screen.width / this.renderedViewport.zoom;
    const height = this.app.screen.height / this.renderedViewport.zoom;
    const left = -this.renderedViewport.x / this.renderedViewport.zoom - 256;
    const top = -this.renderedViewport.y / this.renderedViewport.zoom - 256;
    const right = left + width + 512;
    const bottom = top + height + 512;
    const candidates = new Map<string, SpriteNode>();
    const cellSize = 512;
    for (let x = Math.floor(left / cellSize); x <= Math.floor(right / cellSize); x += 1) {
      for (let y = Math.floor(top / cellSize); y <= Math.floor(bottom / cellSize); y += 1) {
        for (const node of this.grid.get(`${x}:${y}`) ?? []) candidates.set(node.id, node);
      }
    }
    return [...candidates.values()].filter((node) => {
      const bounds = node.rotatedBounds();
      return (
        bounds.left < right && bounds.right > left && bounds.top < bottom && bounds.bottom > top
      );
    });
  }

  private coveredCells(node: SpriteNode): string[] {
    const cellSize = 512;
    const cells: string[] = [];
    for (
      let x = Math.floor(node.x / cellSize);
      x <= Math.floor((node.x + node.width) / cellSize);
      x += 1
    ) {
      for (
        let y = Math.floor(node.y / cellSize);
        y <= Math.floor((node.y + node.height) / cellSize);
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
    if (this.gifTextures.tick(frame)) this.renderVisible();
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
    this.publishRenderedViewport();
  };

  private publishRenderedViewport(): void {
    const next = this.renderedViewport;
    const last = this.publishedViewport;
    if (last && last.x === next.x && last.y === next.y && last.zoom === next.zoom) return;
    this.publishedViewport = { ...next };
    this.options.onRenderedViewportChange?.({ ...next });
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Ignore right-click (context menu reserved for §14).
    if (event.button === 2) return;

    this.capturePress(event);

    // §0.4 MIDDLE-CLICK PAN: middle button always pans, even over items.
    if (event.button === 1) {
      this.startPan();
      return;
    }

    this.controller.press(event);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.panning) {
      this.viewport.x += event.clientX - this.lastPointer.x;
      this.viewport.y += event.clientY - this.lastPointer.y;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      // Notify React during pan so DOM overlays (notes) track the viewport
      // in real time instead of snapping to the final position on release.
      this.options.onViewportChange?.(this.getViewport(), 'pan');
      return;
    }
    this.controller.move(event);
  };

  private readonly onPointerUp = (): void => {
    this.controller.release();
    this.panning = false;
    this.options.onViewportChange?.(this.getViewport(), 'release');
  };

  /** Client coords → canvas-local coords (the Graphics lives on the stage,
   *  whose origin is the canvas top-left, NOT the window). */
  private canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private drawBoxSelect(
    origin: { x: number; y: number } | null,
    current: { x: number; y: number } | null,
  ): void {
    if (!origin || !current) {
      this.boxSelectGraphic?.clear();
      return;
    }
    if (!this.boxSelectGraphic) {
      this.boxSelectGraphic = new Graphics();
      this.app.stage.addChild(this.boxSelectGraphic);
    }
    const from = this.canvasPoint(origin.x, origin.y);
    const to = this.canvasPoint(current.x, current.y);
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const w = Math.abs(to.x - from.x);
    const h = Math.abs(to.y - from.y);
    this.boxSelectGraphic.clear();
    if (w > 0 && h > 0) {
      this.boxSelectGraphic.rect(x, y, w, h);
      this.boxSelectGraphic.fill({ color: 0xd6ff76, alpha: 0.15 });
      this.boxSelectGraphic.stroke({ color: 0xd6ff76, alpha: 0.6, width: 1 });
    }
  }

  private worldPoint(clientX: number, clientY: number): { x: number; y: number } {
    return screenToWorld(
      { clientX, clientY },
      this.renderedViewport,
      this.app.canvas.getBoundingClientRect(),
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
