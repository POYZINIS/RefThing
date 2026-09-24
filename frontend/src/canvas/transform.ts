/**
 * Pure transform-shell math (interaction conventions §2–§3). No DOM, no
 * React — SelectionOverlay feeds it pointer samples and the node tests drive
 * it with the canonical sampled paths from the testing conventions.
 *
 * Geometry model: a box is an unrotated rect (x, y, width, height) rotated by
 * `rotation` degrees clockwise about its own center — the same model as
 * BoardNode. Resize math runs in the box's LOCAL frame (origin at the box
 * center, axes rotated with the box) so the modifier-determined anchor stays
 * fixed in world space for rotated boxes too.
 */

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number; rotation: number };
export type Modifiers = { shift: boolean; alt: boolean };

export type CornerZone = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left';
export type EdgeZone = 'top' | 'bottom' | 'left' | 'right';
export type ResizeZone = CornerZone | EdgeZone;
export type Zone = ResizeZone | 'body';

export const isCorner = (zone: Zone | null): zone is CornerZone =>
  zone === 'top-left' || zone === 'top-right' || zone === 'bottom-left' || zone === 'bottom-right';
export const isEdge = (zone: Zone | null): zone is EdgeZone =>
  zone === 'top' || zone === 'bottom' || zone === 'left' || zone === 'right';

/** Screen px of pointer travel that still counts as a click (testing §2B). */
export const CLICK_EPSILON_PX = 3;
/** Smallest on-screen size a resize may produce. Deliberately far below the
 *  24px zone-collapse threshold: a live resize may pass through the collapse
 *  size and come back (testing §1); collapse only gates NEW gestures. */
export const MIN_RESIZE_SCREEN_PX = 2;

const DEG = Math.PI / 180;

function rotate(point: Point, degrees: number): Point {
  const r = degrees * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

export const boxCenter = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** World point → the box's local frame (origin at center, unrotated). */
export function toLocal(point: Point, box: Box): Point {
  const center = boxCenter(box);
  return rotate({ x: point.x - center.x, y: point.y - center.y }, -box.rotation);
}

/** Local-frame point → world. */
export function toWorld(local: Point, box: Box): Point {
  const center = boxCenter(box);
  const offset = rotate(local, box.rotation);
  return { x: center.x + offset.x, y: center.y + offset.y };
}

/** Unit direction of a zone's handle in the local frame (-1 | 0 | 1 per axis). */
function zoneDirection(zone: ResizeZone): Point {
  return {
    x: zone.includes('left') ? -1 : zone.includes('right') ? 1 : 0,
    y: zone.includes('top') ? -1 : zone.includes('bottom') ? 1 : 0,
  };
}

/**
 * §2 zone hit test, in screen px. `screenBox` is the box already projected to
 * screen space (same rotation). Corners are tested first (§2 zone priority).
 */
export function hitZone(
  pointer: Point,
  screenBox: Box,
  edgeZonePx: number,
  cornerZonePx: number,
): Zone | null {
  const local = toLocal(pointer, screenBox);
  const halfW = screenBox.width / 2;
  const halfH = screenBox.height / 2;
  const edgeHalf = edgeZonePx / 2;
  const cornerHalf = cornerZonePx / 2;
  const near = (value: number, target: number, half: number) => Math.abs(value - target) <= half;
  for (const zone of ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const) {
    const dir = zoneDirection(zone);
    if (near(local.x, dir.x * halfW, cornerHalf) && near(local.y, dir.y * halfH, cornerHalf)) {
      return zone;
    }
  }
  const withinX = Math.abs(local.x) <= halfW;
  const withinY = Math.abs(local.y) <= halfH;
  if (withinX && near(local.y, -halfH, edgeHalf)) return 'top';
  if (withinX && near(local.y, halfH, edgeHalf)) return 'bottom';
  if (withinY && near(local.x, -halfW, edgeHalf)) return 'left';
  if (withinY && near(local.x, halfW, edgeHalf)) return 'right';
  if (withinX && withinY) return 'body';
  return null;
}

/** §2 minimum size collapse: zones are disabled below the on-screen minimum. */
export function zonesCollapsed(box: Box, zoom: number, minScreenPx: number): boolean {
  return Math.min(box.width * zoom, box.height * zoom) < minScreenPx;
}

/** Resize cursor for a zone, turned with the box so a rotated edge shows the
 *  arrow that actually runs along the drag axis. */
export function zoneCursor(zone: ResizeZone, rotation: number): string {
  const cursors = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  const base: Record<ResizeZone, number> = {
    top: 0,
    bottom: 0,
    'top-right': 1,
    'bottom-left': 1,
    left: 2,
    right: 2,
    'top-left': 3,
    'bottom-right': 3,
  };
  const steps = Math.round(rotation / 45);
  return cursors[(((base[zone] + steps) % 4) + 4) % 4] ?? 'default';
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

export type Gesture =
  | {
      mode: 'move';
      start: Point;
      /** §3 CONSTRAIN TO AXIS: locked axis while Shift is held, else null. */
      axis: 'x' | 'y' | null;
    }
  | {
      mode: 'resize';
      zone: ResizeZone;
      box: Box;
      /** Pointer offset from the grabbed handle at press (local frame), so
       *  the first move never jumps by the distance into the hit zone. */
      grab: Point;
    }
  | {
      mode: 'rotate';
      pivot: Point;
      startRotation: number;
      lastAngle: number;
      /** Unwrapped sweep in degrees — never resets at ±180/360 (testing §4.3). */
      sweep: number;
    }
  | { mode: 'aspect-reset'; start: Point; box: Box }
  | {
      mode: 'flip';
      start: Point;
      center: Point;
      /** §3 FLIP: the drag axis, locked once the pointer leaves the click
       *  epsilon — horizontal mirrors left↔right, vertical top↔bottom. */
      axis: 'x' | 'y' | null;
    };

/** What a gesture sample does to the selection box as a whole. */
export type BoxTransform =
  | { kind: 'translate'; dx: number; dy: number }
  | { kind: 'resize'; from: Box; to: Box }
  | { kind: 'rotate'; pivot: Point; delta: number }
  | { kind: 'square'; box: Box }
  | { kind: 'flip'; axis: 'x' | 'y'; center: Point };

export function beginMove(pointer: Point): Gesture {
  return { mode: 'move', start: pointer, axis: null };
}

export function beginResize(zone: ResizeZone, box: Box, pointer: Point): Gesture {
  const dir = zoneDirection(zone);
  const handle = { x: (dir.x * box.width) / 2, y: (dir.y * box.height) / 2 };
  const local = toLocal(pointer, box);
  return { mode: 'resize', zone, box, grab: { x: local.x - handle.x, y: local.y - handle.y } };
}

export function beginRotate(box: Box, pointer: Point): Gesture {
  const pivot = boxCenter(box);
  return {
    mode: 'rotate',
    pivot,
    startRotation: box.rotation,
    lastAngle: Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x),
    sweep: 0,
  };
}

export function beginAspectReset(box: Box, pointer: Point): Gesture {
  return { mode: 'aspect-reset', start: pointer, box };
}

export function beginFlip(box: Box, pointer: Point): Gesture {
  return { mode: 'flip', start: pointer, center: boxCenter(box), axis: null };
}

/**
 * Advance a gesture by one pointer sample. Modifiers are read per sample
 * (testing §2 rule 4): Shift/Alt pressed or released mid-gesture takes effect
 * on the next sample. `freeTransform` is the node-kind resize default (notes:
 * free, Shift locks; images: locked, Shift frees). Returns null when the
 * sample changes nothing.
 */
export function stepGesture(
  gesture: Gesture,
  pointer: Point,
  modifiers: Modifiers,
  zoom: number,
  freeTransform = false,
): BoxTransform | null {
  switch (gesture.mode) {
    case 'move':
      return stepMove(gesture, pointer, modifiers, zoom);
    case 'resize':
      return stepResize(gesture, pointer, modifiers, zoom, freeTransform);
    case 'rotate':
      return stepRotate(gesture, pointer, modifiers);
    case 'aspect-reset':
      return null; // A click, resolved on release by finishAspectReset.
    case 'flip': {
      if (gesture.axis === null) {
        const dx = pointer.x - gesture.start.x;
        const dy = pointer.y - gesture.start.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) * zoom < CLICK_EPSILON_PX) return null;
        gesture.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      return { kind: 'flip', axis: gesture.axis, center: gesture.center };
    }
  }
}

function stepMove(
  gesture: Extract<Gesture, { mode: 'move' }>,
  pointer: Point,
  modifiers: Modifiers,
  zoom: number,
): BoxTransform {
  const dx = pointer.x - gesture.start.x;
  const dy = pointer.y - gesture.start.y;
  if (!modifiers.shift || modifiers.alt) {
    gesture.axis = null;
  } else if (gesture.axis === null) {
    // Lock on the larger delta once the pointer has left the click epsilon;
    // until then hold still rather than guess an axis from jitter.
    if (Math.max(Math.abs(dx), Math.abs(dy)) * zoom < CLICK_EPSILON_PX) {
      return { kind: 'translate', dx: 0, dy: 0 };
    }
    gesture.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  }
  if (gesture.axis === 'x') return { kind: 'translate', dx, dy: 0 };
  if (gesture.axis === 'y') return { kind: 'translate', dx: 0, dy };
  return { kind: 'translate', dx, dy };
}

function stepResize(
  gesture: Extract<Gesture, { mode: 'resize' }>,
  pointer: Point,
  modifiers: Modifiers,
  zoom: number,
  freeTransform: boolean,
): BoxTransform {
  const { box, zone } = gesture;
  const dir = zoneDirection(zone);
  const local = toLocal(pointer, box);
  const handle = { x: local.x - gesture.grab.x, y: local.y - gesture.grab.y };
  // §3 anchor: the item's center with Alt, else the opposite edge/corner.
  const fromCenter = modifiers.alt;
  const anchor = fromCenter
    ? { x: 0, y: 0 }
    : { x: (-dir.x * box.width) / 2, y: (-dir.y * box.height) / 2 };
  const span = fromCenter ? 2 : 1;
  const minSize = MIN_RESIZE_SCREEN_PX / zoom;
  // Signed extent along each axis, measured from the anchor. A handle
  // dragged across its anchor mirrors placement to the other side.
  const extentX = (handle.x - anchor.x) * span;
  const extentY = (handle.y - anchor.y) * span;
  const proportional = freeTransform ? modifiers.shift : !modifiers.shift;

  let width = box.width;
  let height = box.height;
  let signX = 1;
  let signY = 1;
  if (isCorner(zone)) {
    signX = Math.sign(extentX) || dir.x;
    signY = Math.sign(extentY) || dir.y;
    if (proportional) {
      const scale = Math.max(Math.abs(extentX) / box.width, Math.abs(extentY) / box.height);
      width = box.width * scale;
      height = box.height * scale;
    } else {
      width = Math.abs(extentX);
      height = Math.abs(extentY);
    }
  } else if (dir.x !== 0) {
    signX = Math.sign(extentX) || dir.x;
    width = Math.abs(extentX);
    // §3 edges: the drag axis controls width; height follows proportionally
    // or stays bit-for-bit fixed.
    if (proportional) height = box.height * (width / box.width);
  } else {
    signY = Math.sign(extentY) || dir.y;
    height = Math.abs(extentY);
    if (proportional) width = box.width * (height / box.height);
  }
  width = Math.max(minSize, width);
  height = Math.max(minSize, height);

  // New center in the local frame. Along a controlled axis the rect sits on
  // the handle's side of the anchor; along an edge's uncontrolled axis it
  // stays centered on the original box (the anchor edge's midpoint).
  const controlsX = isCorner(zone) || dir.x !== 0;
  const controlsY = isCorner(zone) || dir.y !== 0;
  const centerLocal = {
    x: fromCenter || !controlsX ? 0 : anchor.x + (signX * width) / 2,
    y: fromCenter || !controlsY ? 0 : anchor.y + (signY * height) / 2,
  };
  const center = toWorld(centerLocal, box);
  return {
    kind: 'resize',
    from: box,
    to: {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      rotation: box.rotation,
    },
  };
}

function stepRotate(
  gesture: Extract<Gesture, { mode: 'rotate' }>,
  pointer: Point,
  modifiers: Modifiers,
): BoxTransform {
  const angle = Math.atan2(pointer.y - gesture.pivot.y, pointer.x - gesture.pivot.x);
  // Unwrap: take the shortest step from the previous sample so a sweep
  // across the ±180° atan2 seam keeps accumulating instead of jumping 360°.
  let step = angle - gesture.lastAngle;
  if (step > Math.PI) step -= 2 * Math.PI;
  if (step < -Math.PI) step += 2 * Math.PI;
  gesture.lastAngle = angle;
  gesture.sweep += step / DEG;
  const raw = gesture.startRotation + gesture.sweep;
  // §3 Ctrl+Shift: snap the resulting angle to 45° increments.
  const target = modifiers.shift ? Math.round(raw / 45) * 45 : raw;
  return { kind: 'rotate', pivot: gesture.pivot, delta: target - gesture.startRotation };
}

/**
 * §3 RESET ASPECT RATIO on release: square the box keeping its area and
 * center. Null when the pointer travelled past the click epsilon (a drag,
 * not a click).
 */
export function finishAspectReset(
  gesture: Extract<Gesture, { mode: 'aspect-reset' }>,
  pointer: Point,
  zoom: number,
): BoxTransform | null {
  const travel = Math.hypot(pointer.x - gesture.start.x, pointer.y - gesture.start.y) * zoom;
  if (travel >= CLICK_EPSILON_PX) return null;
  const { box } = gesture;
  if (box.width <= 0 || box.height <= 0) return null;
  const side = Math.sqrt(box.width * box.height);
  const center = boxCenter(box);
  return {
    kind: 'square',
    box: {
      x: center.x - side / 2,
      y: center.y - side / 2,
      width: side,
      height: side,
      rotation: box.rotation,
    },
  };
}

export type Geometry = Box & { flipX?: boolean; flipY?: boolean };
export type GeometryPatch = Partial<Geometry>;

/**
 * Distribute a selection-box transform onto one member node (§1
 * MULTI-SELECTED, §6 RULE 1): every member scales/rotates from the same
 * modifier-determined anchor as the box. For a single-node selection the
 * box IS the node, so this reduces to the box result exactly.
 */
export function applyToNode(transform: BoxTransform, node: Geometry): GeometryPatch {
  switch (transform.kind) {
    case 'translate':
      return { x: node.x + transform.dx, y: node.y + transform.dy };
    case 'rotate': {
      const center = boxCenter(node);
      const offset = rotate(
        { x: center.x - transform.pivot.x, y: center.y - transform.pivot.y },
        transform.delta,
      );
      return {
        x: transform.pivot.x + offset.x - node.width / 2,
        y: transform.pivot.y + offset.y - node.height / 2,
        rotation: node.rotation + transform.delta,
      };
    }
    case 'resize': {
      const { from, to } = transform;
      const scaleX = from.width > 0 ? to.width / from.width : 1;
      const scaleY = from.height > 0 ? to.height / from.height : 1;
      const local = toLocal(boxCenter(node), from);
      const center = toWorld({ x: local.x * scaleX, y: local.y * scaleY }, to);
      const width = node.width * scaleX;
      const height = node.height * scaleY;
      return { x: center.x - width / 2, y: center.y - height / 2, width, height };
    }
    case 'square':
      return {
        x: transform.box.x,
        y: transform.box.y,
        width: transform.box.width,
        height: transform.box.height,
      };
    case 'flip': {
      // A world-axis mirror M applied to a node drawn as R(θ)·F equals
      // R(−θ)·(M·F): toggle the node's own flip on that axis and negate its
      // rotation. Positions mirror across the selection's center, so a
      // multi-selection flips as one picture.
      const center = boxCenter(node);
      const { center: pivot, axis } = transform;
      const mirroredX = axis === 'x' ? 2 * pivot.x - center.x : center.x;
      const mirroredY = axis === 'y' ? 2 * pivot.y - center.y : center.y;
      return {
        x: mirroredX - node.width / 2,
        y: mirroredY - node.height / 2,
        rotation: -node.rotation,
        ...(axis === 'x' ? { flipX: !node.flipX } : { flipY: !node.flipY }),
      };
    }
  }
}
