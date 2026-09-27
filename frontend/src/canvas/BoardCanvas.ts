import { Application, Container, Graphics, type Texture } from 'pixi.js';
import type { BlobInfo, Group, Item, Note } from '@/api/client';
import { isBoardItem } from '@/color/items';
import { clampZoom, screenToWorld, wheelZoomFactor } from './coordinates';
import { NodeInteractionController } from './NodeInteractionController';
import { itemToNode, noteToNode } from './nodes/adapters';
import type { CardTextureSource } from './nodes/CardTextureSource';
import type { PaletteTextureSource, WheelTextureSource } from './nodes/ColorTextureSources';
import type { GifTextureSource } from './nodes/GifTextureSource';
import { type ModelTextureSource, modelTextureScale } from './nodes/ModelTextureSource';
import type { ModelSettings } from './nodes/modelView';
import type { NodeRenderer } from './nodes/NodeRenderer';
import { type NoteTextureSource, noteTextureScale } from './nodes/NoteTextureSource';
import { type PyramidTextureSource, pyramidLevel } from './nodes/PyramidTextureSource';
import { nodeKindRegistry } from './nodes/registry';
import type { CanvasNode, NodeChange, SpriteNode } from './nodes/types';
import { themeColor } from './theme';
import type { Guide, Rect } from './transform';
import {
  type CropSample,
  cropShift,
  readWindowFrame,
  sampleCropCurve,
  type WindowFrame,
} from './windowCrop';

export type ViewportState = { x: number; y: number; zoom: number };

/** An origin change held this long with no resize is a window move. */
const WINDOW_MOVE_SETTLE_MS = 150;
/** Smooth window resize: this long after the last edge step, settle. */
const WINDOW_RESIZE_SETTLE_MS = 120;
/** The crop curve is drawn this far behind the latest step (~a step or
 *  two), so each segment has the point after it to curve toward. */
const CROP_CURVE_DELAY_MS = 40;
/** Steps kept for the curve (only the last few shape the current segment). */
const CROP_SAMPLES_KEPT = 8;

/** Numeric spatial-grid key (no string per cell per node per update). */
const cellKey = (x: number, y: number) => (x + 1_048_576) * 2_097_152 + (y + 1_048_576);

type CanvasOptions = {
  initialViewport?: ViewportState;
  onViewportChange?: (viewport: ViewportState, source?: 'pan' | 'zoom' | 'release') => void;
  /** The eased camera Pixi actually painted this frame. DOM overlays (notes,
   *  selection shell, outlines) must position from THIS, not the target
   *  viewport, or they run ahead of the canvas while easing. */
  onRenderedViewportChange?: (viewport: ViewportState) => void;
  onSelectionChange?: (nodeId: string | null) => void;
  /** A click (press and release without a move) on a node. */
  onNodeClick?: (nodeId: string, clientX: number, clientY: number) => void;
  /** A press on bare canvas or an unselected node, before the bindings:
   *  true when it was taken (a palette swatch pulled out). */
  onSwatchPress?: (event: PointerEvent) => boolean;
  onSelectionToggle?: (nodeId: string) => void;
  onMultiSelectChange?: (nodeIds: string[]) => void;
  onBoxSelect?: (worldRect: { x1: number; y1: number; x2: number; y2: number }) => void;
  onClearSelection?: () => void;
  onHoverChange?: (nodeId: string | null) => void;
  /** Native dblclick on the canvas, with the topmost node under it. */
  onDoubleClick?: (nodeId: string | null, event: MouseEvent) => void;
  onDragPreview?: (changes: NodeChange[]) => void;
  onGuides?: (guides: Guide[]) => void;
  onNodesChange?: (changes: NodeChange[]) => void;
  /** A right press bound to `move_window` (desktop shell drags the window). */
  onMoveWindow?: (event: PointerEvent) => void;
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
  private readonly cardTextures: CardTextureSource = nodeKindRegistry.file.textureSourceFactory();
  private readonly paletteTextures: PaletteTextureSource =
    nodeKindRegistry.palette.textureSourceFactory();
  private readonly wheelTextures: WheelTextureSource =
    nodeKindRegistry.colorwheel.textureSourceFactory();
  private readonly modelTextures: ModelTextureSource = nodeKindRegistry.model.textureSourceFactory({
    onChange: () => this.renderVisible(),
  });
  private readonly options: CanvasOptions;
  private readonly controller: NodeInteractionController;
  private readonly grid = new Map<number, CanvasNode[]>();
  /** Nodes cached by the snapshot object they came from: an update that
   *  changes one item (select-to-front, a drag commit) rebuilds one node, not
   *  20k. Flags that live outside the item are part of the cache check. */
  private readonly nodeCache = new WeakMap<
    object,
    { node: CanvasNode; blob: BlobInfo | undefined; locked: boolean }
  >();
  private nodes: CanvasNode[] = [];
  /** Group backgrounds (plan Phase 5): drawn under every node. */
  private readonly groupBackdrop = new Graphics();
  private styledGroups = new Map<string, { color: string; opacity: number }>();
  private groupMembers = new Map<string, CanvasNode[]>();
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
  /** Wheel zoom speed multiplier (Settings → Scroll zoom speed). */
  private zoomSpeed = 1;

  constructor(options: CanvasOptions = {}) {
    this.options = options;
    this.viewport = options.initialViewport ?? { x: 0, y: 0, zoom: 1 };
    this.renderedViewport = { ...this.viewport };
    this.controller = new NodeInteractionController(
      {
        candidates: () => this.visibleNodes(),
        allNodes: () => this.nodes,
        zoom: () => this.renderedViewport.zoom,
        worldPoint: (clientX, clientY) => this.worldPoint(clientX, clientY),
        drawBoxSelect: (origin, current) => this.drawBoxSelect(origin, current),
      },
      {
        onSelectionChange: (nodeId) => this.options.onSelectionChange?.(nodeId),
        onNodeClick: (nodeId, clientX, clientY) =>
          this.options.onNodeClick?.(nodeId, clientX, clientY),
        onSelectionToggle: (nodeId) => this.options.onSelectionToggle?.(nodeId),
        onMultiSelectChange: (nodeIds) => this.options.onMultiSelectChange?.(nodeIds),
        onClearSelection: () => this.options.onClearSelection?.(),
        onHoverChange: (nodeId) => this.options.onHoverChange?.(nodeId),
        onBoxSelect: (worldRect) => this.options.onBoxSelect?.(worldRect),
        onDragPreview: (changes) => this.options.onDragPreview?.(changes),
        onGuides: (guides) => this.options.onGuides?.(guides),
        onNodesChange: (changes) => this.options.onNodesChange?.(changes),
      },
      options.snapToGrid ?? false,
    );
  }

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({
      // Transparent: the workspace colour, grain and (desktop) glass backdrop
      // are the page behind the canvas, so a theme switch never repaints it.
      backgroundAlpha: 0,
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
    // Paint ranks are 0…n, so -1 keeps every group background under all nodes.
    this.groupBackdrop.zIndex = -1;
    this.scene.addChild(this.groupBackdrop);
    this.applyViewport();
    this.app.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.app.canvas.addEventListener('pointermove', this.onPointerMove);
    // The wheel zooms over everything laid on the board too (the selection
    // shell, media controls, the model gizmo), not just bare canvas — those
    // overlays sit beside the canvas, so listen on the frame holding both.
    this.wheelRoot = host.parentElement ?? this.app.canvas;
    this.wheelRoot.addEventListener('wheel', this.onWheel, { passive: false });
    this.app.canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('resize', this.onWindowResize);
    this.windowFrame = readWindowFrame();
    this.app.ticker.add(this.onTick);
    // The canvas draws at the end of our own tick instead of on Pixi's, so
    // a frame can be thrown away (onTick: pulled frames during a window
    // edge drag keep showing the last good one) or capped (Settings →
    // Frame rate). Sizing too: Pixi's own resize listener would redraw on
    // every window resize, past both.
    this.app.ticker.remove(this.app.render, this.app);
    this.host = host;
    this.app.resizeTo = null as unknown as HTMLElement;
    this.renderVisible();
  }

  update(
    items: Item[],
    blobs: ReadonlyMap<string, BlobInfo> = new Map(),
    notes: Note[] = [],
    groups: readonly Group[] = [],
  ): void {
    const lockedGroups = new Set(groups.filter((group) => group.locked).map((group) => group.id));
    this.styledGroups = new Map(
      groups
        .filter((group) => group.bg_color)
        .map((group) => [group.id, { color: group.bg_color as string, opacity: group.opacity }]),
    );
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
    // Model z per node; the nodes' own zIndex holds the paint RANK (below),
    // which a cached node carries over from the previous update.
    const modelZ = new Map<string, number>();
    const cached = (
      source: Item | Note,
      blob: BlobInfo | undefined,
      locked: boolean,
      build: () => CanvasNode,
    ) => {
      modelZ.set(source.id, source.z_index);
      const hit = this.nodeCache.get(source);
      if (hit && hit.blob === blob && hit.locked === locked) return hit.node;
      const node = build();
      this.nodeCache.set(source, { node, blob, locked });
      return node;
    };
    const next: CanvasNode[] = [];
    for (const item of items) {
      if (!isBoardItem(item)) continue;
      const blob = item.blob_hash ? blobs.get(item.blob_hash) : undefined;
      const locked = item.group_id !== null && lockedGroups.has(item.group_id);
      next.push(cached(item, blob, locked, () => itemToNode(item, blob, locked)));
    }
    for (const note of notes) next.push(cached(note, undefined, false, () => noteToNode(note)));
    this.nodes = liveById
      ? next.map((node) => {
          const inFlight = liveById.get(node.id);
          if (!inFlight || inFlight.kind === 'note' || node.kind === 'note') return node;
          inFlight.kind = node.kind;
          return inFlight;
        })
      : next;
    // One strict paint order shared by the renderer and the hit test: model
    // z first; items and notes may share a z value, so ties break by kind
    // (notes above) and then id — never by whatever order Pixi mounted them.
    // Sort keys precomputed once (not two Map lookups per comparison: this
    // runs on every snapshot change of a 20k-node board).
    const keyed = this.nodes.map((node) => ({
      node,
      z: modelZ.get(node.id) ?? 0,
      note: node.kind === 'note' ? 1 : 0,
    }));
    keyed.sort(
      (a, b) =>
        a.z - b.z ||
        a.note - b.note ||
        (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
    );
    for (let index = 0; index < keyed.length; index += 1) {
      const entry = keyed[index];
      if (entry) entry.node.zIndex = index;
    }
    this.groupMembers = new Map();
    for (const node of this.nodes) {
      if (!node.groupId || !this.styledGroups.has(node.groupId)) continue;
      const members = this.groupMembers.get(node.groupId) ?? [];
      members.push(node);
      this.groupMembers.set(node.groupId, members);
    }
    this.grid.clear();
    for (const node of this.nodes) this.addToGrid(node);
    const gifHashes = new Set<string>();
    for (const blob of blobs.values()) if (blob.mime_type === 'image/gif') gifHashes.add(blob.hash);
    this.gifTextures.sync(
      gifHashes,
      new Set(this.nodes.flatMap((node) => (node.kind === 'gif' ? [node.blobHash] : []))),
    );
    this.renderVisible();
  }

  /** §6 RULE 2: while drilled into a group, its members act individually. */
  setDrillGroup(groupId: string | null): void {
    this.controller.drillGroupId = groupId;
  }

  /** Hide one node's sprite while a DOM surface stands in for it (editing). */
  setHiddenNode(nodeId: string | null): void {
    if (this.hiddenNodeId === nodeId) return;
    this.hiddenNodeId = nodeId;
    this.renderVisible();
  }

  setViewport(viewport: ViewportState): void {
    this.viewport = { ...viewport, zoom: clampZoom(viewport.zoom) };
    this.renderedViewport = { ...this.viewport };
    this.applyViewport();
    this.renderVisible();
    this.publishRenderedViewport();
  }

  /** Ease the camera to `viewport` (zoom to fit, double-click zoom) — the
   *  render loop animates there exactly like a wheel zoom. */
  flyTo(viewport: ViewportState): void {
    this.viewport = { ...viewport, zoom: clampZoom(viewport.zoom) };
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

  /** Repaint what's on screen (theme change: unfilled notes' text follows
   *  the theme, and note textures key on it). */
  redraw(): void {
    this.renderVisible();
  }

  /** Show a model at `settings` while its view is dragged (orbit mode);
   *  null returns it to its stored settings. */
  setModelPreview(nodeId: string, settings: ModelSettings | null): void {
    this.modelTextures.setPreview(nodeId, settings);
  }

  setZoomSpeed(speed: number): void {
    this.zoomSpeed = speed;
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
  chromePointerDown(
    event: PointerEvent,
    action: 'pan' | 'drag_zoom' | 'move_window' = 'pan',
  ): void {
    // The shell already resolved this press via the bindings.
    if (action === 'move_window') {
      this.options.onMoveWindow?.(event);
      return;
    }
    this.capturePress(event);
    if (action === 'drag_zoom') this.startDragZoom(event);
    else this.startPan();
  }

  /** Plan: Z + drag zooms around the press point (right/up = in). */
  private startDragZoom(event: PointerEvent): void {
    this.controller.clearHover();
    this.zoomDrag = {
      startClient: { x: event.clientX, y: event.clientY },
      anchor: this.worldPoint(event.clientX, event.clientY),
      startZoom: this.viewport.zoom,
    };
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

  private zoomDrag: {
    startClient: { x: number; y: number };
    anchor: { x: number; y: number };
    startZoom: number;
  } | null = null;

  private startPan(): void {
    this.controller.clearHover();
    this.panning = true;
  }

  /**
   * Press the selection shell couldn't place (clicked outside the selection
   * box). Only structural empty-area targets are forwarded — the frame
   * itself or the hit-zone strips past the canvas overflow; interactive
   * chrome (search bar, toolbars, popovers) keeps its own behavior and
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

  /** What a node shows right now (a GIF's current frame, an image's
   *  loaded level), for sampling its colours. */
  nodeImage(nodeId: string): CanvasImageSource | null {
    return this.renderers.get(nodeId)?.currentImage?.() ?? null;
  }

  /** A model rendered without its sky, for sampling its colours. */
  modelSnapshot(node: SpriteNode, width: number, height: number): Promise<ImageBitmap | null> {
    return this.modelTextures.snapshot(node, width, height);
  }

  /** What a model item shows (dev/test hook). */
  modelStatus(nodeId: string): string {
    return this.modelTextures.status(nodeId);
  }

  /** Bounds of the visible nodes other than `exclude` (snap-move targets). */
  snapTargets(exclude: ReadonlySet<string>): Rect[] {
    return this.visibleNodes()
      .filter((node) => !exclude.has(node.id))
      .map((node) => node.rotatedBounds());
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
    this.wheelRoot?.removeEventListener('wheel', this.onWheel);
    this.app.canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('resize', this.onWindowResize);
    this.app.ticker.remove(this.onTick);
    this.gifTextures.dispose();
    this.pyramidTextures.dispose();
    this.noteTextures.dispose();
    this.cardTextures.dispose();
    this.modelTextures.dispose();
    this.paletteTextures.dispose();
    this.wheelTextures.dispose();
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
    const visibleCards = new Set<string>();
    const visibleModels = new Set<string>();
    const visibleTools = new Set<string>();
    const zoom = this.renderedViewport.zoom;
    const dpr = window.devicePixelRatio;
    const modelScale = String(modelTextureScale(zoom, dpr));
    const cardScale = String(noteTextureScale(this.renderedViewport.zoom, window.devicePixelRatio));
    const card = (node: SpriteNode) => {
      visibleCards.add(node.id);
      return this.cardTextures.texture(node, cardScale);
    };
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
      } else if (node.kind === 'file') {
        texture = card(node);
      } else if (node.kind === 'palette') {
        visibleTools.add(node.id);
        texture = this.paletteTextures.texture(node, cardScale);
      } else if (node.kind === 'colorwheel') {
        visibleTools.add(node.id);
        texture = this.wheelTextures.texture(node, cardScale, zoom);
      } else if (node.kind === 'model') {
        // The rendered view once it arrives; the card until then, and with
        // the reason when the model can't be opened.
        visibleModels.add(node.id);
        const view = this.modelTextures.texture(node, modelScale, zoom * dpr);
        const error = view ? null : this.modelTextures.error(node.id);
        texture = view ?? card(error ? { ...node, detail: `Can't open · ${error}` } : node);
      } else if (node.kind === 'video' || node.kind === 'audio') {
        // The poster once it's resident; the card until then (or forever
        // without ffmpeg).
        const poster = node.poster ? this.pyramidTextures.poster(node, this.levelFor(node)) : null;
        texture = poster ?? card(node);
      } else {
        const source = node.kind === 'gif' ? this.gifTextures : this.pyramidTextures;
        texture = source.texture(node, this.levelFor(node));
      }
      renderer.sync(node, {
        texture,
        grayscale: this.grayscale,
        hidden: node.id === this.hiddenNodeId,
      });
    }
    this.noteTextures.retain(visibleNotes);
    this.cardTextures.retain(visibleCards);
    this.modelTextures.retain(visibleModels);
    this.paletteTextures.retain(visibleTools);
    this.wheelTextures.retain(visibleTools);
    this.drawGroupBackdrops();
    this.scene.sortableChildren = true;
  }

  /** Padded rounded rect behind each styled group, from its members' live
   *  (possibly mid-drag) bounds. */
  private drawGroupBackdrops(): void {
    const backdrop = this.groupBackdrop;
    backdrop.clear();
    const pad = 12;
    for (const [groupId, style] of this.styledGroups) {
      const members = this.groupMembers.get(groupId);
      if (!members || members.length === 0) continue;
      const bounds = members.map((node) => node.rotatedBounds());
      const left = Math.min(...bounds.map((rect) => rect.left)) - pad;
      const top = Math.min(...bounds.map((rect) => rect.top)) - pad;
      const right = Math.max(...bounds.map((rect) => rect.right)) + pad;
      const bottom = Math.max(...bounds.map((rect) => rect.bottom)) + pad;
      backdrop.roundRect(left, top, right - left, bottom - top, 10);
      backdrop.fill({ color: style.color, alpha: style.opacity });
    }
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
        for (const node of this.grid.get(cellKey(x, y)) ?? []) candidates.set(node.id, node);
      }
    }
    return [...candidates.values()].filter((node) => {
      const bounds = node.rotatedBounds();
      return (
        bounds.left < right && bounds.right > left && bounds.top < bottom && bounds.bottom > top
      );
    });
  }

  private addToGrid(node: CanvasNode): void {
    // Rotated bounds: a rotated node can reach cells its unrotated rect
    // doesn't, and must not be culled while its corner is on screen.
    const bounds = node.rotatedBounds();
    const cellSize = 512;
    const x1 = Math.floor(bounds.right / cellSize);
    const y1 = Math.floor(bounds.bottom / cellSize);
    for (let x = Math.floor(bounds.left / cellSize); x <= x1; x += 1) {
      for (let y = Math.floor(bounds.top / cellSize); y <= y1; y += 1) {
        const key = cellKey(x, y);
        const cell = this.grid.get(key);
        if (cell) cell.push(node);
        else this.grid.set(key, [node]);
      }
    }
  }

  private applyViewport(): void {
    this.scene.position.set(this.renderedViewport.x, this.renderedViewport.y);
    this.scene.scale.set(this.renderedViewport.zoom);
  }

  /** The window's client area as of the last resize (or settled move). */
  private windowFrame: WindowFrame | null = null;
  /** When the window's origin started differing from `windowFrame` at the
   *  same size — a move, unless a resize follows (then it was an edge). */
  private originMovedAt: number | null = null;
  /** Settings → Window edge drag. */
  private windowResizeMode: 'exact' | 'smooth' = 'exact';
  /** Smooth mode, during an edge drag: the crop owed so far (sampled per
   *  resize step, on a timeline) and how much of it the camera has taken. */
  private cropSamples: CropSample[] = [];
  private cropApplied = { x: 0, y: 0 };

  setWindowResizeMode(mode: 'exact' | 'smooth'): void {
    this.windowResizeMode = mode;
  }

  /**
   * A resize that moved the window's top-left corner crops the board rather
   * than dragging it (windowCrop.ts): the camera takes the opposite shift,
   * so what's on screen stays where it is.
   */
  private readonly onWindowResize = (): void => {
    const next = readWindowFrame();
    const last = this.windowFrame;
    this.windowFrame = next;
    this.originMovedAt = null;
    let shift = last ? cropShift(last, next, window.screen) : null;
    if (shift && this.windowResizeMode === 'smooth') {
      // Sample the step; the tick follows a smooth curve through the steps
      // (and settles once they stop) instead of taking each one raw.
      const now = performance.now();
      const owed = this.cropSamples[this.cropSamples.length - 1] ?? {
        time: now,
        x: this.cropApplied.x,
        y: this.cropApplied.y,
      };
      if (this.cropSamples.length === 0) {
        // The curve starts where the camera is, one step-interval back.
        this.cropSamples.push({ ...owed, time: now - CROP_CURVE_DELAY_MS });
      }
      this.cropSamples.push({ time: now, x: owed.x + shift.dx, y: owed.y + shift.dy });
      if (this.cropSamples.length > CROP_SAMPLES_KEPT) this.cropSamples.shift();
      shift = null;
    }
    if (shift) {
      this.viewport.x -= shift.dx;
      this.viewport.y -= shift.dy;
      this.renderedViewport.x -= shift.dx;
      this.renderedViewport.y -= shift.dy;
      this.applyViewport();
    }
    // Redraw NOW, at the new size and camera, inside the resize event: the
    // window has already moved on screen, and waiting for the next frame
    // (Pixi queues its resize to one) showed the old picture shifted for a
    // frame on every step of an edge drag — a jitter.
    this.renderVisible();
    if (this.frameCap > 0) {
      // Testing cap: the resize waits for the next allowed frame too.
      this.resizePending = true;
    } else {
      this.resizeCanvas();
      this.app.render();
      this.lastDrawAt = performance.now();
    }
    if (shift) {
      this.publishRenderedViewport();
      this.options.onViewportChange?.(this.getViewport(), 'pan');
    }
  };

  /**
   * Smooth edge drag, per frame. While steps keep coming, the camera takes
   * the owed crop along a Bézier curve through them, drawn a little in the
   * past so the curve always has its next point. Once they stop, the rest
   * is planted with the camera's own easing, exactly where it belongs.
   */
  private followCrop(now: number): void {
    const last = this.cropSamples[this.cropSamples.length - 1];
    if (!last) return;
    const move = (x: number, y: number, eased: boolean) => {
      const dx = x - this.cropApplied.x;
      const dy = y - this.cropApplied.y;
      if (dx === 0 && dy === 0) return;
      this.cropApplied = { x, y };
      this.viewport.x -= dx;
      this.viewport.y -= dy;
      if (!eased) {
        this.renderedViewport.x -= dx;
        this.renderedViewport.y -= dy;
      }
    };
    if (now - last.time <= WINDOW_RESIZE_SETTLE_MS) {
      const point = sampleCropCurve(this.cropSamples, now - CROP_CURVE_DELAY_MS);
      move(point.x, point.y, false);
      return;
    }
    // Settle: the remainder eases in (renderedViewport follows viewport).
    move(last.x, last.y, true);
    this.cropSamples = [];
    this.cropApplied = { x: 0, y: 0 };
    this.options.onViewportChange?.(this.getViewport(), 'pan');
  }

  /** Whether the previous tick drew (frames are only ever skipped singly). */
  private drewLastTick = true;

  private readonly onTick = (): void => {
    const frame = performance.now();
    this.followCrop(frame);
    // The window during a drag, as this frame sees it.
    let pulled = false;
    const current = this.windowFrame;
    if (current) {
      const sized = window.innerWidth !== current.width || window.innerHeight !== current.height;
      const moved = window.screenX !== current.x || window.screenY !== current.y;
      if (sized) {
        // The resize reached the page before its event: correct it now
        // rather than draw one frame uncorrected (the event then finds
        // nothing left to do).
        this.onWindowResize();
      } else if (moved) {
        // The origin moved but the size hasn't (yet): a window move, or the
        // first half of an edge step. In "hold the board still" mode, drawn
        // now it may show the board pulled by the window — throw it away
        // and keep the last frame. (Smooth mode rides with the window on
        // purpose, so it draws every frame.)
        pulled = this.windowResizeMode === 'exact';
        // Follow window moves between resizes (a move fires no event). An
        // edge drag can report the new origin a moment before the new
        // size, so an origin change only counts as a move once it has held
        // without a resize for a moment.
        if (this.originMovedAt === null) {
          this.originMovedAt = frame;
        } else if (frame - this.originMovedAt > WINDOW_MOVE_SETTLE_MS) {
          this.windowFrame = readWindowFrame();
          this.originMovedAt = null;
        }
      } else {
        this.originMovedAt = null;
      }
    }
    if (this.gifTextures.tick(frame)) this.renderVisible();
    this.pyramidTextures.tick(); // frame clock for texture eviction
    this.modelTextures.tick();
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
    // A pulled frame isn't drawn — the canvas keeps the last good one — but
    // never twice running (at worst half the frame rate while dragging, and
    // a plain window move keeps animating).
    if (pulled && this.drewLastTick) {
      this.drewLastTick = false;
      return;
    }
    this.drewLastTick = this.draw(frame);
  };

  /** The canvas's host element (sized with the window). */
  private host: HTMLElement | null = null;
  /** Settings → Frame rate (testing): draws per second, 0 = every frame. */
  private frameCap = 0;
  private lastDrawAt = 0;
  /** A window resize waiting for the next (capped) draw. */
  private resizePending = false;

  setFrameCap(fps: number): void {
    this.frameCap = fps > 0 ? fps : 0;
    if (this.frameCap === 0 && this.resizePending) {
      this.resizeCanvas();
      this.resizePending = false;
    }
  }

  private resizeCanvas(): void {
    const host = this.host;
    if (host) this.app.renderer.resize(host.clientWidth, host.clientHeight);
  }

  /** Draw the frame, unless the frame-rate cap says it's too soon. */
  private draw(now: number): boolean {
    if (this.frameCap > 0 && now - this.lastDrawAt < 1000 / this.frameCap) return false;
    if (this.resizePending) {
      this.resizeCanvas();
      this.resizePending = false;
    }
    this.app.render();
    this.lastDrawAt = now;
    return true;
  }

  private publishRenderedViewport(): void {
    const next = this.renderedViewport;
    const last = this.publishedViewport;
    if (last && last.x === next.x && last.y === next.y && last.zoom === next.zoom) return;
    this.publishedViewport = { ...next };
    this.options.onRenderedViewportChange?.({ ...next });
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.options.onSwatchPress?.(event)) return;
    // The bindings table decides what this press means.
    const action = this.controller.resolve(event);
    if (action === null) return; // e.g. right button: the context menu
    if (action === 'move_window') {
      // The desktop shell moves the window; a press that never travels is
      // still a click, and the context menu owns it.
      this.options.onMoveWindow?.(event);
      return;
    }
    this.capturePress(event);
    if (action === 'pan') {
      this.startPan();
      return;
    }
    if (action === 'drag_zoom') {
      this.startDragZoom(event);
      return;
    }
    this.controller.press(event, action);
  };

  // Native dblclick only — no hand-rolled timing (§7).
  private readonly onDoubleClick = (event: MouseEvent): void => {
    this.options.onDoubleClick?.(this.nodeIdAt(event.clientX, event.clientY), event);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.zoomDrag) {
      const { startClient, anchor, startZoom } = this.zoomDrag;
      const travel = event.clientX - startClient.x - (event.clientY - startClient.y);
      const zoom = clampZoom(startZoom * Math.exp(travel * 0.005));
      const rect = this.app.canvas.getBoundingClientRect();
      // Keep the pressed world point under the press position.
      this.viewport = {
        zoom,
        x: startClient.x - rect.left - anchor.x * zoom,
        y: startClient.y - rect.top - anchor.y * zoom,
      };
      this.options.onViewportChange?.(this.getViewport(), 'zoom');
      return;
    }
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
    this.zoomDrag = null;
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
      const accent = themeColor('--color-accent', '#527966');
      this.boxSelectGraphic.fill({ color: accent, alpha: 0.15 });
      this.boxSelectGraphic.stroke({ color: accent, alpha: 0.6, width: 1 });
    }
  }

  private worldPoint(clientX: number, clientY: number): { x: number; y: number } {
    return screenToWorld(
      { clientX, clientY },
      this.renderedViewport,
      this.app.canvas.getBoundingClientRect(),
    );
  }

  private wheelRoot: HTMLElement | null = null;

  private readonly onWheel = (event: WheelEvent): void => {
    // Text (a note being edited, a field) scrolls instead; a surface with a
    // wheel of its own (orbit mode) stops the event before it gets here.
    if ((event.target as Element | null)?.closest?.('textarea, input, select, [data-wheel-scroll]'))
      return;
    event.preventDefault();
    // Multiply the TARGET zoom, so notches spun faster than the camera eases
    // all add up; anchor on the world point under the pointer as painted.
    const nextZoom = clampZoom(
      this.viewport.zoom * wheelZoomFactor(event.deltaY, event.deltaMode, this.zoomSpeed),
    );
    const rect = this.app.canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const worldX = (pointerX - this.renderedViewport.x) / this.renderedViewport.zoom;
    const worldY = (pointerY - this.renderedViewport.y) / this.renderedViewport.zoom;
    this.viewport.zoom = nextZoom;
    this.viewport.x = pointerX - worldX * nextZoom;
    this.viewport.y = pointerY - worldY * nextZoom;
    this.renderVisible();
    this.options.onViewportChange?.(this.getViewport(), 'zoom');
  };
}
