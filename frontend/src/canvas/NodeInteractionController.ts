import { gestureRoles, heldModifiers, type PressAction, resolvePress } from './bindings';
import { isHeld } from './heldKeys';
import { type BoardNode, type NodeChange, nodeChangeKind } from './nodes/types';
import { type Guide, type Rect, SNAP_DISTANCE_PX, snapTranslate } from './transform';

export type InteractionCallbacks = {
  /** Press-selected a single node (replaces the selection), or null. */
  onSelectionChange?: (nodeId: string | null) => void;
  /** A press on a node released without moving it (a click). */
  onNodeClick?: (nodeId: string, clientX: number, clientY: number) => void;
  /** Shift-click: toggle one node's membership without starting a drag. */
  onSelectionToggle?: (nodeId: string) => void;
  /** Box-select committed a set of node ids (mixed kinds). */
  onMultiSelectChange?: (nodeIds: string[]) => void;
  onClearSelection?: () => void;
  onHoverChange?: (nodeId: string | null) => void;
  onBoxSelect?: (worldRect: { x1: number; y1: number; x2: number; y2: number }) => void;
  /** Live positions of every node a drag moves. Sprites already paint from
   *  the canvas-side mutation; this feeds DOM chrome (selection outline,
   *  notes) so it tracks the drag from the very first sample. */
  onDragPreview?: (changes: NodeChange[]) => void;
  /** Alignment guides while a Shift+Space snap-move is active ([] clears). */
  onGuides?: (guides: Guide[]) => void;
  /** Drag committed on release; positions already reflect the mutation. */
  onNodesChange?: (changes: NodeChange[]) => void;
};

export type InteractionHost = {
  /** Culled visible nodes of every kind — hit tests stay O(viewport) at 20k. */
  candidates(): BoardNode[];
  /** Every node (box select + group-mate lookup). */
  allNodes(): BoardNode[];
  /** Current rendered zoom (snap distance is screen px). */
  zoom(): number;
  /** Client coords → world coords through the rendered viewport. */
  worldPoint(clientX: number, clientY: number): { x: number; y: number };
  /** Draw the box-select rectangle (client coords); nulls clear it. */
  drawBoxSelect(
    origin: { x: number; y: number } | null,
    current: { x: number; y: number } | null,
  ): void;
};

type DragState = {
  node: BoardNode;
  startX: number;
  startY: number;
  // Node positions at drag start — the anchor the delta is applied to.
  // NEVER recompute from the mutated in-progress position, or every
  // pointermove double-counts the delta.
  originX: number;
  originY: number;
};

const toChange = (node: BoardNode): NodeChange => ({
  id: node.id,
  kind: nodeChangeKind(node),
  patch: { x: node.x, y: node.y },
});

/**
 * The ONE pointer state machine for node interaction (idle → hover /
 * pressed → dragging | box-select). Every node kind is a canvas node, so a
 * note and an image select, drag, and box-select through literally the same
 * path (§0.7, §4 RULE 1). Pan and wheel zoom stay with the canvas (they never touch
 * nodes); the transform shell (SelectionOverlay) owns resize/rotate of an
 * already-selected box.
 */
export class NodeInteractionController {
  private dragging: DragState | null = null;
  /** Where the current node press started (client px), for clicks. */
  private pressClient: { x: number; y: number } | null = null;
  private boxOrigin: { x: number; y: number } | null = null;
  private boxCurrent: { x: number; y: number } | null = null;
  private hovered: BoardNode | null = null;
  /** §6 RULE 2: the group drilled into — its members move individually. */
  drillGroupId: string | null = null;

  constructor(
    private readonly host: InteractionHost,
    private readonly callbacks: InteractionCallbacks,
    private readonly snapToGrid: boolean,
  ) {}

  get isDragging(): boolean {
    return this.dragging !== null;
  }

  /** What a canvas press means (bindings table), from what it lands on. */
  resolve(event: PointerEvent): PressAction | null {
    const node = this.hitTest(this.host.worldPoint(event.clientX, event.clientY));
    return resolvePress(event.button, heldModifiers(event, isHeld), node ? 'item' : 'empty');
  }

  /** Canvas press, already resolved to an action. */
  press(event: PointerEvent, action: PressAction | null = this.resolve(event)): void {
    const point = this.host.worldPoint(event.clientX, event.clientY);
    const node = this.hitTest(point);
    if (action === 'toggle_select' && node) {
      // Toggles membership without disturbing the rest of the selection —
      // and never starts a drag.
      this.callbacks.onSelectionToggle?.(node.id);
      return;
    }
    if (action === 'move_item' && node) {
      this.beginPress(node, point, event);
      return;
    }
    if (action === 'box_select' && !node) this.beginPress(null, point, event);
  }

  move(event: PointerEvent): void {
    if (this.boxOrigin) {
      this.boxCurrent = { x: event.clientX, y: event.clientY };
      this.host.drawBoxSelect(this.boxOrigin, this.boxCurrent);
      return;
    }
    if (this.dragging) {
      const point = this.host.worldPoint(event.clientX, event.clientY);
      const { node, startX, startY, originX, originY } = this.dragging;
      // PureRef delta contract: node = origin + (pointer - startPointer),
      // snapped to grid. origin never changes during the drag, so repeated
      // pointermove events don't accumulate.
      const grid = this.snapToGrid ? 24 : 1;
      let nextX = Math.round((originX + point.x - startX) / grid) * grid;
      let nextY = Math.round((originY + point.y - startY) / grid) * grid;
      const moving = this.moveSet(node);
      // Plan: Shift+Space + drag snaps the moving set to other nodes' edges
      // and centers (Shift pressed after the press — a Shift press toggles).
      if (gestureRoles(event, isHeld).snap) {
        const ids = new Set(moving.map((candidate) => candidate.id));
        const offsetX = node.x - originX;
        const offsetY = node.y - originY;
        const bounds = moving.map((candidate) => candidate.rotatedBounds());
        const atOrigin: Rect = {
          left: Math.min(...bounds.map((rect) => rect.left)) - offsetX,
          top: Math.min(...bounds.map((rect) => rect.top)) - offsetY,
          right: Math.max(...bounds.map((rect) => rect.right)) - offsetX,
          bottom: Math.max(...bounds.map((rect) => rect.bottom)) - offsetY,
        };
        const targets = this.host
          .candidates()
          .filter((candidate) => !ids.has(candidate.id))
          .map((candidate) => candidate.rotatedBounds());
        const snapped = snapTranslate(
          atOrigin,
          nextX - originX,
          nextY - originY,
          targets,
          SNAP_DISTANCE_PX / this.host.zoom(),
        );
        nextX = originX + snapped.dx;
        nextY = originY + snapped.dy;
        this.callbacks.onGuides?.(snapped.guides);
      } else {
        this.callbacks.onGuides?.([]);
      }
      const deltaX = nextX - node.x;
      const deltaY = nextY - node.y;
      // Mutate in-place so the canvas repaint (which repositions sprites
      // from these same objects) follows the drag each frame.
      for (const candidate of moving) {
        candidate.x += deltaX;
        candidate.y += deltaY;
      }
      this.callbacks.onDragPreview?.(moving.map(toChange));
      return;
    }
    // §1 HOVERED: report the node under the cursor (or null) while idle so
    // the UI can draw the 1px 40% hover outline on unselected nodes.
    this.updateHover(this.hitTest(this.host.worldPoint(event.clientX, event.clientY)));
  }

  release(): void {
    if (this.boxOrigin) {
      this.commitBoxSelect();
    } else if (this.dragging) {
      // The nodes were already mutated in-place during the drag (move), so
      // just read their current positions. Commit only when the drag
      // actually moved something — a plain click sends no op. Mates share
      // the dragged node's delta, so its origin decides for the whole set.
      const { node, originX, originY } = this.dragging;
      if (node.x !== originX || node.y !== originY) {
        this.callbacks.onNodesChange?.(this.moveSet(node).map(toChange));
      } else if (this.pressClient) {
        this.callbacks.onNodeClick?.(node.id, this.pressClient.x, this.pressClient.y);
      }
    }
    if (this.dragging) this.callbacks.onGuides?.([]);
    this.dragging = null;
    this.boxOrigin = null;
    this.boxCurrent = null;
    this.host.drawBoxSelect(null, null);
    this.updateHover(null);
  }

  /** Topmost node under a client point (the selection shell asks this for
   *  clicks that land on its body). */
  nodeAt(clientX: number, clientY: number): BoardNode | null {
    return this.hitTest(this.host.worldPoint(clientX, clientY));
  }

  clearHover(): void {
    this.updateHover(null);
  }

  /** Group-aware drag: a grouped node drags every group-mate with it —
   *  unless we're drilled into that group, where members move alone. */
  private moveSet(node: BoardNode): BoardNode[] {
    return node.groupId && node.groupId !== this.drillGroupId
      ? this.host.allNodes().filter((candidate) => candidate.groupId === node.groupId)
      : [node];
  }

  private beginPress(
    node: BoardNode | null,
    point: { x: number; y: number },
    event: PointerEvent,
  ): void {
    if (node) {
      // Select + drag node. Selecting happens on press, not release.
      this.callbacks.onSelectionChange?.(node.id);
      this.updateHover(null);
      // §6 RULE 3: a locked group is selectable but never moves as a group.
      if (node.locked && node.groupId !== this.drillGroupId) return;
      this.dragging = {
        node,
        startX: point.x,
        startY: point.y,
        originX: node.x,
        originY: node.y,
      };
      this.pressClient = { x: event.clientX, y: event.clientY };
      return;
    }
    // §14 BOX SELECT: left-click on empty canvas starts box selection.
    this.callbacks.onClearSelection?.();
    this.callbacks.onSelectionChange?.(null);
    this.updateHover(null);
    this.boxOrigin = { x: event.clientX, y: event.clientY };
    this.boxCurrent = { x: event.clientX, y: event.clientY };
    this.host.drawBoxSelect(this.boxOrigin, this.boxCurrent);
  }

  private commitBoxSelect(): void {
    if (!this.boxOrigin || !this.boxCurrent) return;
    const dx = Math.abs(this.boxCurrent.x - this.boxOrigin.x);
    const dy = Math.abs(this.boxCurrent.y - this.boxOrigin.y);
    // Too small to be intentional → treat as click (deselect all).
    if (dx < 3 && dy < 3) {
      this.callbacks.onMultiSelectChange?.([]);
      return;
    }
    const origin = this.host.worldPoint(this.boxOrigin.x, this.boxOrigin.y);
    const current = this.host.worldPoint(this.boxCurrent.x, this.boxCurrent.y);
    const wx1 = Math.min(origin.x, current.x);
    const wy1 = Math.min(origin.y, current.y);
    const wx2 = Math.max(origin.x, current.x);
    const wy2 = Math.max(origin.y, current.y);
    // All node kinds, rotation-aware (rotated AABB intersect).
    const hit = this.host.allNodes().filter((node) => {
      const bounds = node.rotatedBounds();
      return bounds.left < wx2 && bounds.right > wx1 && bounds.top < wy2 && bounds.bottom > wy1;
    });
    this.callbacks.onMultiSelectChange?.(hit.map((node) => node.id));
    this.callbacks.onBoxSelect?.({ x1: wx1, y1: wy1, x2: wx2, y2: wy2 });
  }

  /**
   * One z order for every kind: the topmost painted node is the topmost
   * hit. Ties resolve like the renderer (later in the list paints on top).
   * Hit tests use node.containsPoint (rotation-aware).
   */
  private hitTest(point: { x: number; y: number }): BoardNode | null {
    const nodes = this.host.candidates();
    let best: BoardNode | null = null;
    for (const node of nodes) {
      if ((best === null || node.zIndex >= best.zIndex) && node.containsPoint(point)) best = node;
    }
    return best;
  }

  private updateHover(node: BoardNode | null): void {
    if (node === this.hovered) return;
    this.hovered = node;
    this.callbacks.onHoverChange?.(node?.id ?? null);
  }
}
