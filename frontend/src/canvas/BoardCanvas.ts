import { Application, Container, Graphics, type Texture } from 'pixi.js';
import type { Item, Note } from '@/api/client';
import { screenToWorld } from './coordinates';
import { NodeInteractionController } from './NodeInteractionController';
import { itemToNode, noteToNode } from './nodes/adapters';
import type { GifTextureSource } from './nodes/GifTextureSource';
import type { NodeRenderer } from './nodes/NodeRenderer';
import { type NoteTextureSource, noteTextureScale } from './nodes/NoteTextureSource';
import { type PyramidTextureSource, pyramidLevel } from './nodes/PyramidTextureSource';
import { nodeKindRegistry } from './nodes/registry';
import type { CanvasNode, NodeChange } from './nodes/types';

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
  /** Native dblclick on the canvas, with the topmost node under it. */
  onDoubleClick?: (nodeId: string | null, event: MouseEvent) => void;
  onDragPreview?: (changes: NodeChange[]) => void;
  onNodesChange?: (changes: NodeChange[]) => void;
  snapToGrid?: boolean;
};

/**
 * Renders every board node (images, GIFs, notes) as a sprite in ONE scene
 * graph sorted by zIndex — notes and images interleave freely, and the
 * topmost painted node is the topmost hit. Owns the board's pointer input.
 * Only the note being edited leaves the canvas (hidden here, edited in DOM).
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
  private readonly noteTextures: NoteTextureSource = nodeKindRegistry.note.textureSourceFactory();
  private readonly options: CanvasOptions;
  private readonly controller: NodeInteractionController;
  private readonly grid = new Map<string, CanvasNode[]>();
  private nodes: CanvasNode[] = [];
  /** The note being edited: its DOM editor stands in for the sprite. */
  private hiddenNodeId: string | null = null;
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
        candidates: () => this.visibleNodes(),
        allNodes: () => this.nodes,
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
    this.app.canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.app.ticker.add(this.onTick);
    this.renderVisible();
  }

  update(items: Item[], gifHashes: ReadonlySet<string> = new Set(), notes: Note[] = []): void {
    // If a node is mid-drag, React re-renders (selection change etc.) with
    // the *server* snapshot which still has the pre-drag position. Merge the
    // in-flight drag position back in so the node doesn't snap to the old
    // spot between pointermove and pointerup.
    //
    // The live nodes are reused BY REFERENCE (never copied): the controller's
    // drag state and release read x/y from that same object, so it must stay
    // the object painted from. Only zIndex (a bring-to-front fired on press
    // applies optimistically) and kind (a blob's MIME — hence gif-ness — can
    // arrive late) are adopted from the incoming snapshot.
    const liveById = this.controller.isDragging
      ? new Map(this.nodes.map((node) => [node.id, node]))
      : null;
    const next: CanvasNode[] = [
      ...items
        .filter(
          (item): item is Item & { blob_hash: string } => item.type === 'image' && !!item.blob_hash,
        )
        .map((item) => itemToNode(item, gifHashes.has(item.blob_hash))),
      ...notes.map(noteToNode),
    ];
    this.nodes = liveById
      ? next.map((node) => {
          const inFlight = liveById.get(node.id);
          if (!inFlight || inFlight.kind === 'note' || node.kind === 'note') return node;
          inFlight.zIndex = node.zIndex;
          inFlight.kind = node.kind;
          return inFlight;
        })
      : next;
    // One strict paint order shared by the renderer and the hit test: model
    // z first; items and notes may share a z value, so ties break by kind
    // (notes above) and then id — never by whatever order Pixi mounted them.
    const rank = [...this.nodes].sort(
      (a, b) =>
        a.zIndex - b.zIndex ||
        Number(a.kind === 'note') - Number(b.kind === 'note') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    rank.forEach((node, index) => {
      node.zIndex = index;
    });
    this.grid.clear();
    for (const node of this.nodes) {
      for (const key of this.coveredCells(node)) {
        const cell = this.grid.get(key) ?? [];
        cell.push(node);
        this.grid.set(key, cell);
      }
    }
    this.gifTextures.sync(
      gifHashes,
      new Set(this.nodes.flatMap((node) => (node.kind === 'gif' ? [node.blobHash] : []))),
    );
    this.renderVisible();
  }

  /** Hide one node's sprite while a DOM surface stands in for it (editing). */
  setHiddenNode(nodeId: string | null): void {
    if (this.hiddenNodeId === nodeId) return;
    this.hiddenNodeId = nodeId;
    this.renderVisible();
  }

  setViewport(viewport: ViewportState): void {
    this.viewport = { ...viewport, zoom: Math.max(0.1, Math.min(4, viewport.zoom)) };
    this.renderedViewport = { ...this.viewport };
    this.applyViewport();
    this.renderVisible();
    this.publishRenderedViewport();
  }

  /** Ease the camera to `viewport` (zoom to fit, double-click zoom) — the
   *  render loop animates there exactly like a wheel zoom. */
  flyTo(viewport: ViewportState): void {
    this.viewport = { ...viewport, zoom: Math.max(0.1, Math.min(4, viewport.zoom)) };
    this.renderVisible();
    this.options.onViewportChange?.(this.getViewport(), 'zoom');
  }

  /** Canvas size in CSS px (0×0 before mount). */
  size(): { width: number; height: number } {
    return this.initialized
      ? { width: this.app.screen.width, height: this.app.screen.height }
      : { width: 0, height: 0 };
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
    this.app.canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.app.ticker.remove(this.onTick);
    this.gifTextures.dispose();
    this.pyramidTextures.dispose();
    this.noteTextures.dispose();
    this.app.destroy(true, { children: true, texture: false });
  }

  private renderVisible(): void {
    if (!this.initialized) return;
    const visibleNodes = this.visibleNodes();
    const nextIds = new Set(visibleNodes.map((node) => node.id));
    for (const [id, renderer] of this.renderers) {
      if (!nextIds.has(id)) {
        renderer.destroy();
        this.renderers.delete(id);
      }
    }
    const visibleNotes = new Set<string>();
    for (const node of visibleNodes) {
      let renderer = this.renderers.get(node.id);
      if (!renderer) {
        renderer = nodeKindRegistry[node.kind].rendererFactory();
        renderer.mount(this.scene);
        this.renderers.set(node.id, renderer);
      }
      let texture: Texture;
      if (node.kind === 'note') {
        visibleNotes.add(node.id);
        texture = this.noteTextures.texture(node, this.levelFor(node));
      } else {
        const source = node.kind === 'gif' ? this.gifTextures : this.pyramidTextures;
        texture = source.texture(node, this.levelFor(node));
      }
      renderer.sync(node, {
        texture,
        grayscale: this.grayscale,
        alpha: node.kind === 'note' ? node.opacity : 1,
        hidden: node.id === this.hiddenNodeId,
      });
    }
    this.noteTextures.retain(visibleNotes);
    this.scene.sortableChildren = true;
  }

  private levelFor(node: CanvasNode): string {
    if (node.kind === 'note') {
      return String(noteTextureScale(this.renderedViewport.zoom, window.devicePixelRatio));
    }
    const displayEdge = Math.max(node.width, node.height) * this.renderedViewport.zoom;
    return pyramidLevel(displayEdge);
  }

  private visibleNodes(): CanvasNode[] {
    const width = this.app.screen.width / this.renderedViewport.zoom;
    const height = this.app.screen.height / this.renderedViewport.zoom;
    const left = -this.renderedViewport.x / this.renderedViewport.zoom - 256;
    const top = -this.renderedViewport.y / this.renderedViewport.zoom - 256;
    const right = left + width + 512;
    const bottom = top + height + 512;
    const candidates = new Map<string, CanvasNode>();
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

  private coveredCells(node: CanvasNode): string[] {
    // Rotated bounds: a rotated node can reach cells its unrotated rect
    // doesn't, and must not be culled while its corner is on screen.
    const bounds = node.rotatedBounds();
    const cellSize = 512;
    const cells: string[] = [];
    for (
      let x = Math.floor(bounds.left / cellSize);
      x <= Math.floor(bounds.right / cellSize);
      x += 1
    ) {
      for (
        let y = Math.floor(bounds.top / cellSize);
        y <= Math.floor(bounds.bottom / cellSize);
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

  // Native dblclick only — no hand-rolled timing (§7).
  private readonly onDoubleClick = (event: MouseEvent): void => {
    this.options.onDoubleClick?.(this.nodeIdAt(event.clientX, event.clientY), event);
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
