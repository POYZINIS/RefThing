import { useEffect, useRef, useState } from 'react';
import type { ViewportState } from '@/canvas/BoardCanvas';
import { screenToWorld } from '@/canvas/coordinates';
import { type BoardNode, type NodeChange, nodeChangeKind } from '@/canvas/nodes/types';
import {
  applyToNode,
  type Box,
  type BoxTransform,
  beginAspectReset,
  beginMove,
  beginResize,
  beginRotate,
  CLICK_EPSILON_PX,
  finishAspectReset,
  type Gesture,
  hitZone,
  isCorner,
  isEdge,
  type Point,
  stepGesture,
  type Zone,
  zoneCursor,
  zonesCollapsed,
} from '@/canvas/transform';
import {
  ACCENT,
  ACTIVE_EDGE_OUTLINE_PX,
  CORNER_HANDLE_PX,
  CORNER_HIT_ZONE_PX,
  EDGE_HIT_ZONE_PX,
  MIN_SCREEN_SIZE_PX,
  ROTATE_CURSOR,
  SELECTED_OUTLINE_PX,
} from './interactionConstants';

type SelectionOverlayProps = {
  /** Everything the shell frames and transforms: the selection plus any
   *  group-mates — a group is selected as one unit (§6 RULE 1). */
  nodes: BoardNode[];
  /** The RENDERED camera (what Pixi painted this frame), never the target. */
  viewport: ViewportState;
  /** Live per-node geometry while a gesture is in progress ([] clears). */
  onPreview: (changes: NodeChange[]) => void;
  /** One committed gesture → one undo entry. */
  onCommit: (changes: NodeChange[]) => void;
  /** Left press outside the box: the canvas controller hit-tests it. */
  onOutsidePress?: (event: PointerEvent) => void;
  /** Non-left press on the shell (middle = pan) — handed to the canvas. */
  onChromePress?: (event: PointerEvent) => void;
  /** A click (no drag) on the body: re-select / Shift-toggle the node under
   *  the pointer, exactly like a click on bare canvas would. */
  onBodyClick?: (event: PointerEvent) => void;
  editing?: boolean;
  /** Forwarded double-click (the shell covers selected nodes). */
  onDoubleClick?: (event: React.MouseEvent) => void;
};

/** §1 MULTI-SELECTED: exactly ONE box. A lone node's box is the node itself
 *  (rotation included); a multi-selection's box is the axis-aligned union. */
function selectionBox(nodes: BoardNode[]): Box | null {
  const only = nodes[0];
  if (!only) return null;
  if (nodes.length === 1) {
    return {
      x: only.x,
      y: only.y,
      width: only.width,
      height: only.height,
      rotation: only.rotation,
    };
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    const bounds = node.rotatedBounds();
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }
  return { x: left, y: top, width: right - left, height: bottom - top, rotation: 0 };
}

function hostRect(): DOMRect {
  return document.getElementById('canvas-host')?.getBoundingClientRect() ?? new DOMRect();
}

/** The box projected into canvas-host-relative screen px. */
function screenBox(box: Box, viewport: ViewportState): Box {
  return {
    x: viewport.x + box.x * viewport.zoom,
    y: viewport.y + box.y * viewport.zoom,
    width: box.width * viewport.zoom,
    height: box.height * viewport.zoom,
    rotation: box.rotation,
  };
}

type ActiveGesture = {
  gesture: Gesture;
  pointerId: number;
  /** Geometry of every framed node at press — transforms apply to these
   *  originals, never to the live-previewed copies. */
  origin: BoardNode[];
  freeTransform: boolean;
  pressClient: Point;
  lastClient: Point;
  modifiers: { shift: boolean; alt: boolean };
  /** Last previewed result — pointerup commits exactly what the user saw. */
  last: NodeChange[] | null;
  moved: boolean;
  pressEvent: PointerEvent;
};

/**
 * The kind-agnostic transform shell (§0.7): one outline, 8 hover-revealed
 * zones, modifier-determined anchors. All geometry lives in
 * canvas/transform.ts; this component only routes pointer samples to it.
 */
export function SelectionOverlay({
  nodes,
  viewport,
  onPreview,
  onCommit,
  onOutsidePress,
  onChromePress,
  onBodyClick,
  editing,
  onDoubleClick,
}: SelectionOverlayProps) {
  const box = selectionBox(nodes);
  const [hovered, setHovered] = useState<Zone | null>(null);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [dragMode, setDragMode] = useState<Gesture['mode'] | null>(null);
  const active = useRef<ActiveGesture | null>(null);
  const element = useRef<HTMLDivElement>(null);
  // Latest props for the window listeners (registered once).
  const latest = useRef({ viewport, onPreview, onCommit, onBodyClick });
  latest.current = { viewport, onPreview, onCommit, onBodyClick };

  const collapsed = box ? zonesCollapsed(box, viewport.zoom, MIN_SCREEN_SIZE_PX) : false;
  const freeTransform = nodes.length > 0 && nodes.every((node) => node.capabilities.freeTransform);

  const zoneAt = (clientX: number, clientY: number): Zone | null => {
    if (!box) return null;
    const rect = hostRect();
    const zone = hitZone(
      { x: clientX - rect.left, y: clientY - rect.top },
      screenBox(box, viewport),
      EDGE_HIT_ZONE_PX,
      CORNER_HIT_ZONE_PX,
    );
    // §2 minimum size collapse: zones disabled → the whole box is body.
    return collapsed && zone !== null ? 'body' : zone;
  };

  const worldAt = (clientX: number, clientY: number, vp = viewport) =>
    screenToWorld({ clientX, clientY }, vp, hostRect());

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editing || !box || active.current) return;
    const native = event.nativeEvent;
    if (event.button !== 0) {
      // Middle pans, right is the context menu — never a transform.
      onChromePress?.(native);
      return;
    }
    const zone = zoneAt(event.clientX, event.clientY);
    if (zone === null) {
      onOutsidePress?.(native);
      return;
    }
    const pointer = worldAt(event.clientX, event.clientY);
    const primary = event.ctrlKey || event.metaKey;
    let gesture: Gesture;
    if (primary) {
      // §3 ROTATION: Ctrl/Cmd + drag anywhere on the box, no handle.
      gesture = beginRotate(box, pointer);
    } else if (zone !== 'body') {
      gesture = beginResize(zone, box, pointer);
    } else if (event.altKey && !event.shiftKey && nodes.length === 1 && !freeTransform) {
      // §3 RESET ASPECT RATIO — Alt+click on the body only. Notes keep their
      // free aspect (sanctioned exception), so they have no square reset.
      gesture = beginAspectReset(box, pointer);
    } else {
      gesture = beginMove(pointer);
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = {
      gesture,
      pointerId: event.pointerId,
      origin: nodes.map((node) => ({ ...node })),
      freeTransform,
      pressClient: { x: event.clientX, y: event.clientY },
      lastClient: { x: event.clientX, y: event.clientY },
      modifiers: { shift: event.shiftKey, alt: event.altKey },
      last: null,
      moved: false,
      pressEvent: native,
    };
    setDragMode(gesture.mode);
  };

  useEffect(() => {
    const distribute = (transform: BoxTransform, origin: BoardNode[]): NodeChange[] =>
      origin.map((node) => ({
        id: node.id,
        kind: nodeChangeKind(node),
        patch: applyToNode(transform, node),
      }));

    // One sample: re-run the gesture at the last pointer position with the
    // current modifiers (called on pointermove AND on modifier key changes,
    // so pressing Shift mid-drag takes effect without moving — §2 rule 4).
    const sample = () => {
      const current = active.current;
      if (!current) return;
      const { viewport: vp } = latest.current;
      const travel = Math.hypot(
        current.lastClient.x - current.pressClient.x,
        current.lastClient.y - current.pressClient.y,
      );
      if (travel >= CLICK_EPSILON_PX) current.moved = true;
      // No drag threshold for moving (plan: "immediate, no threshold"), but
      // nothing previews until the pointer actually moves.
      if (travel === 0 && current.last === null) return;
      const pointer = screenToWorld(
        { clientX: current.lastClient.x, clientY: current.lastClient.y },
        vp,
        hostRect(),
      );
      const transform = stepGesture(
        current.gesture,
        pointer,
        current.modifiers,
        vp.zoom,
        current.freeTransform,
      );
      if (!transform) return;
      current.last = distribute(transform, current.origin);
      latest.current.onPreview(current.last);
    };

    const onMove = (event: PointerEvent) => {
      const current = active.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.lastClient = { x: event.clientX, y: event.clientY };
      current.modifiers = { shift: event.shiftKey, alt: event.altKey };
      sample();
    };

    const finish = (event: PointerEvent) => {
      const current = active.current;
      if (!current || event.pointerId !== current.pointerId) return;
      active.current = null;
      setDragMode(null);
      const { viewport: vp } = latest.current;
      if (current.gesture.mode === 'aspect-reset') {
        const pointer = screenToWorld(
          { clientX: event.clientX, clientY: event.clientY },
          vp,
          hostRect(),
        );
        const square = finishAspectReset(current.gesture, pointer, vp.zoom);
        if (square) {
          latest.current.onCommit(distribute(square, current.origin));
          return;
        }
      }
      if (!current.moved && current.gesture.mode !== 'resize') {
        // A click, not a drag: drop any sub-epsilon preview and let the
        // canvas treat it as a click on whatever node is under the pointer.
        latest.current.onPreview([]);
        if (current.gesture.mode === 'move') latest.current.onBodyClick?.(current.pressEvent);
        return;
      }
      if (current.last) latest.current.onCommit(current.last);
      else latest.current.onPreview([]);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setCtrlHeld(event.type === 'keydown');
      const current = active.current;
      if (!current || (event.key !== 'Shift' && event.key !== 'Alt')) return;
      current.modifiers = { shift: event.shiftKey, alt: event.altKey };
      sample();
    };
    const onBlur = () => setCtrlHeld(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    // A cancelled pointer ends the gesture like a release, keeping what the
    // user last saw — the cursor must never stay locked.
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  if (!box) return null;
  const screen = screenBox(box, viewport);
  const activeZone = active.current?.gesture.mode === 'resize' ? active.current.gesture.zone : null;
  // While resizing, only the grabbed handle stays visible (§1 RESIZING).
  const shownZone = dragMode === 'resize' ? activeZone : dragMode ? null : hovered;

  const cursor = (() => {
    if (dragMode === 'rotate') return ROTATE_CURSOR;
    if (dragMode === 'move' || dragMode === 'aspect-reset') return 'grabbing';
    if (dragMode === 'resize' && activeZone) return zoneCursor(activeZone, box.rotation);
    if (hovered === 'body' || hovered === null) return ctrlHeld ? ROTATE_CURSOR : 'grab';
    return ctrlHeld ? ROTATE_CURSOR : zoneCursor(hovered, box.rotation);
  })();

  // §4 RULE 3: while Editing the zones are not just hidden but gone — a
  // child with its own pointer-events would still take presses through the
  // shell's pointer-events: none.
  const zoneStrip = (style: React.CSSProperties, z: number) => (
    <div
      style={{
        position: 'absolute',
        pointerEvents: 'auto',
        zIndex: z,
        display: collapsed || editing ? 'none' : 'block',
        ...style,
      }}
    />
  );
  const edge = EDGE_HIT_ZONE_PX / 2;
  const corner = CORNER_HIT_ZONE_PX / 2;
  const handle = CORNER_HANDLE_PX / 2;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: canvas transform shell (pointer-only surface)
    <div
      ref={element}
      className={`selection-overlay${editing ? ' selection-overlay--editing' : ''}`}
      style={{
        left: screen.x,
        top: screen.y,
        width: screen.width,
        height: screen.height,
        cursor,
        // §4 RULE 3 — while editing, the shell is a pure visual: zones are
        // non-interactive, not merely hidden.
        pointerEvents: editing ? 'none' : 'auto',
        outline: editing
          ? `${SELECTED_OUTLINE_PX}px dashed ${ACCENT}`
          : `${SELECTED_OUTLINE_PX}px solid ${ACCENT}`,
        transform: `rotate(${box.rotation}deg)`,
        transformOrigin: 'center',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (!active.current) setHovered(zoneAt(event.clientX, event.clientY));
      }}
      onPointerLeave={() => {
        if (!active.current) setHovered(null);
      }}
      onDoubleClick={editing ? undefined : onDoubleClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* Hit strips extend the shell past its outline so the outer half of
          every zone receives presses (§2: zones straddle the edge). */}
      {zoneStrip({ top: -edge, left: 0, width: '100%', height: EDGE_HIT_ZONE_PX }, 1)}
      {zoneStrip({ bottom: -edge, left: 0, width: '100%', height: EDGE_HIT_ZONE_PX }, 1)}
      {zoneStrip({ left: -edge, top: 0, height: '100%', width: EDGE_HIT_ZONE_PX }, 1)}
      {zoneStrip({ right: -edge, top: 0, height: '100%', width: EDGE_HIT_ZONE_PX }, 1)}
      {zoneStrip(
        { left: -corner, top: -corner, width: CORNER_HIT_ZONE_PX, height: CORNER_HIT_ZONE_PX },
        2,
      )}
      {zoneStrip(
        { right: -corner, top: -corner, width: CORNER_HIT_ZONE_PX, height: CORNER_HIT_ZONE_PX },
        2,
      )}
      {zoneStrip(
        { right: -corner, bottom: -corner, width: CORNER_HIT_ZONE_PX, height: CORNER_HIT_ZONE_PX },
        2,
      )}
      {zoneStrip(
        { left: -corner, bottom: -corner, width: CORNER_HIT_ZONE_PX, height: CORNER_HIT_ZONE_PX },
        2,
      )}
      {!editing && !collapsed && isEdge(shownZone) && (
        // §1: only the hovered edge segment thickens.
        <div
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            background: ACCENT,
            ...(shownZone === 'top' || shownZone === 'bottom'
              ? { left: 0, width: '100%', height: ACTIVE_EDGE_OUTLINE_PX }
              : { top: 0, height: '100%', width: ACTIVE_EDGE_OUTLINE_PX }),
            ...(shownZone === 'top' && { top: -ACTIVE_EDGE_OUTLINE_PX / 2 }),
            ...(shownZone === 'bottom' && { bottom: -ACTIVE_EDGE_OUTLINE_PX / 2 }),
            ...(shownZone === 'left' && { left: -ACTIVE_EDGE_OUTLINE_PX / 2 }),
            ...(shownZone === 'right' && { right: -ACTIVE_EDGE_OUTLINE_PX / 2 }),
          }}
        />
      )}
      {!editing && !collapsed && isCorner(shownZone) && (
        // §1: a single 8x8 handle at the hovered corner only.
        <div
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            width: CORNER_HANDLE_PX,
            height: CORNER_HANDLE_PX,
            background: ACCENT,
            border: '1.5px solid #101419',
            boxSizing: 'border-box',
            ...(shownZone.includes('top') ? { top: -handle } : { bottom: -handle }),
            ...(shownZone.includes('left') ? { left: -handle } : { right: -handle }),
          }}
        />
      )}
    </div>
  );
}
