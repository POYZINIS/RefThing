export type NodeKind = 'image' | 'gif' | 'note';

export type NodeCapabilities = {
  resizable: boolean;
  rotatable: boolean;
  freeTransform: boolean;
  groupable: boolean;
  editable: boolean;
};

export type WorldPoint = { x: number; y: number };

/** Axis-aligned bounding box of a (possibly rotated) node, in world coords. */
export type WorldRect = { left: number; top: number; right: number; bottom: number };

export interface BoardNode {
  readonly id: string;
  readonly kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise. */
  rotation: number;
  zIndex: number;
  groupId: string | null;
  readonly capabilities: NodeCapabilities;
  containsPoint(point: WorldPoint): boolean;
  rotatedBounds(): WorldRect;
}

export interface SpriteNode extends BoardNode {
  // Mutable: the live-drag merge re-adopts it each update() — a blob's MIME
  // (hence the kind) can arrive after the node was created.
  kind: 'image' | 'gif';
  readonly blobHash: string;
}

/** A note: painted by the NoteTextureSource from its text (pretext layout). */
export interface NoteNode extends BoardNode {
  readonly kind: 'note';
  readonly text: string;
  readonly bgColor: string | null;
  readonly opacity: number;
}

/** Every node the canvas paints. */
export type CanvasNode = SpriteNode | NoteNode;

/** Geometry the interaction layer can patch on any node kind. */
export type NodePatch = Partial<Pick<BoardNode, 'x' | 'y' | 'width' | 'height' | 'rotation'>>;

/**
 * One committed node change. `kind` is the persistence-routing kind: 'note'
 * routes to the notes API, everything sprite-based routes to item batch ops.
 */
export type NodeChange = { id: string; kind: 'item' | 'note'; patch: NodePatch };

export const nodeChangeKind = (node: BoardNode): NodeChange['kind'] =>
  node.kind === 'note' ? 'note' : 'item';

/**
 * Shared node geometry, spread onto every node the adapters build. The
 * methods read `this`, so mutating a node's fields mid-drag is immediately
 * reflected in hit tests and culling.
 */
export const nodeGeometry = {
  /** Rotation-aware hit test (the canvas's hitTest math). */
  containsPoint(this: BoardNode, point: WorldPoint): boolean {
    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;
    const radians = (-this.rotation * Math.PI) / 180;
    const localX =
      (point.x - centerX) * Math.cos(radians) - (point.y - centerY) * Math.sin(radians);
    const localY =
      (point.x - centerX) * Math.sin(radians) + (point.y - centerY) * Math.cos(radians);
    return Math.abs(localX) <= this.width / 2 && Math.abs(localY) <= this.height / 2;
  },
  /** Rotation-aware AABB (the canvas's visibility-culling math). */
  rotatedBounds(this: BoardNode): WorldRect {
    const radians = (this.rotation * Math.PI) / 180;
    const halfWidth =
      (Math.abs(this.width * Math.cos(radians)) + Math.abs(this.height * Math.sin(radians))) / 2;
    const halfHeight =
      (Math.abs(this.width * Math.sin(radians)) + Math.abs(this.height * Math.cos(radians))) / 2;
    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;
    return {
      left: centerX - halfWidth,
      top: centerY - halfHeight,
      right: centerX + halfWidth,
      bottom: centerY + halfHeight,
    };
  },
};
