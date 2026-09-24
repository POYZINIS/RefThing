import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewportState } from '@/canvas/BoardCanvas';
import {
  ACCENT,
  ACTIVE_EDGE_OUTLINE_PX,
  CORNER_HANDLE_PX,
  CORNER_HIT_ZONE_PX,
  EDGE_HIT_ZONE_PX,
  MIN_SCREEN_SIZE_PX,
  SELECTED_OUTLINE_PX,
} from './interactionConstants';

/**
 * Anything with a transformable box: an image item or a note (§0.7 uniform
 * shell). Selection/transform math only reads these geometry fields — the
 * shell never touches type-specific content.
 */
export type Selectable = {
  kind: 'item' | 'note';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

/** Geometry patch for a `Selectable` — subset of the box the shell can
 * transform. Item patches also carry `z_index`/`metadata` etc.; notes carry
 * `bg_color`/`opacity`. The overlay only ever emits `BoxPatch` and App
 * routes it to the right entity. */
export type BoxPatch = Partial<Pick<Selectable, 'x' | 'y' | 'width' | 'height' | 'rotation'>>;

export type SelectableChange = { id: string; kind: 'item' | 'note'; patch: BoxPatch };

type SelectionOverlayProps = {
  items: Selectable[];
  viewport: ViewportState;
  onPreview: (patch: BoxPatch) => void;
  onCommit: (patch: BoxPatch) => void;
  onPreviewItems?: (changes: SelectableChange[]) => void;
  onCommitItems?: (changes: SelectableChange[]) => void;
  /** Called when the user clicks on the overlay outside the selection box
   *  (no drag started). Used to clear selection when clicking empty space. */
  onClearSelection?: () => void;
  editing?: boolean;
  /** When true, resize is free-form (no aspect lock).  Shift+drag locks
   *  aspect instead of the default (images: default locks, notes: free). */
  freeTransform?: boolean;
  /** Forwarded through the overlay (notes enter edit on double-click; the
   * overlay covers the note body while selected, so it must pass the event
   * through). */
  onDoubleClick?: () => void;
};

/** Combined AABB of a selection — the virtual "item" the overlay/shell
 *  draws around and transforms. §1 MULTI-SELECTED: exactly ONE box. */
type SelectionBox = { x: number; y: number; width: number; height: number; rotation: number };

function selectionBox(items: Selectable[]): SelectionBox | null {
  if (items.length === 0) return null;
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const it of items) {
    x1 = Math.min(x1, it.x);
    y1 = Math.min(y1, it.y);
    x2 = Math.max(x2, it.x + it.width);
    y2 = Math.max(y2, it.y + it.height);
  }
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    // Multi-select boxes have no intrinsic rotation; each item keeps its own.
    rotation: 0,
  };
}

type Zone =
  | 'top-left'
  | 'top-right'
  | 'bottom-right'
  | 'bottom-left'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'body'
  | null;

type DragState = {
  mode: 'move' | 'resize' | 'rotate' | 'aspect-reset';
  zone: Zone;
  startPX: number;
  startPY: number;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  startRot: number;
  ox: number;
  oy: number;
  /** §3 +Alt: anchor is the item's center (does not move while resizing). */
  fromCenter: boolean;
  /** §3 CONSTRAIN TO AXIS: 'pending' until the first move locks 'x' or 'y'. */
  axis?: 'pending' | 'x' | 'y' | null;
};

function hostRect(): DOMRect {
  return document.getElementById('canvas-host')?.getBoundingClientRect() ?? new DOMRect();
}

function screenToWorld(clientX: number, clientY: number, viewport: ViewportState) {
  const r = hostRect();
  return {
    x: (clientX - r.left - viewport.x) / viewport.zoom,
    y: (clientY - r.top - viewport.y) / viewport.zoom,
  };
}

type BoxLike = Pick<Selectable, 'x' | 'y' | 'width' | 'height'>;

function hitZone(clientX: number, clientY: number, item: BoxLike, viewport: ViewportState): Zone {
  const r = hostRect();
  const left = r.left + viewport.x + item.x * viewport.zoom;
  const top = r.top + viewport.y + item.y * viewport.zoom;
  const w = item.width * viewport.zoom;
  const h = item.height * viewport.zoom;
  const right = left + w;
  const bottom = top + h;
  // §2 screen-space hit zones: edge band is 8px wide (4px each side of the
  // edge line), corner hit-zone is 10x10 (5px each way from the corner).
  const edgeHalf = EDGE_HIT_ZONE_PX / 2;
  const cornerHalf = CORNER_HIT_ZONE_PX / 2;
  // §3 RULE — corner priority: corners are tested first, so a corner
  // hit-zone always wins over an overlapping edge hit-zone.
  const inCorner = (cx: number, cy: number) =>
    clientX >= cx - cornerHalf &&
    clientX <= cx + cornerHalf &&
    clientY >= cy - cornerHalf &&
    clientY <= cy + cornerHalf;
  if (inCorner(left, top)) return 'top-left';
  if (inCorner(right, top)) return 'top-right';
  if (inCorner(right, bottom)) return 'bottom-right';
  if (inCorner(left, bottom)) return 'bottom-left';
  const inTop = clientY >= top - edgeHalf && clientY <= top + edgeHalf;
  const inBottom = clientY >= bottom - edgeHalf && clientY <= bottom + edgeHalf;
  const inLeft = clientX >= left - edgeHalf && clientX <= left + edgeHalf;
  const inRight = clientX >= right - edgeHalf && clientX <= right + edgeHalf;
  if (inTop) return 'top';
  if (inBottom) return 'bottom';
  if (inLeft) return 'left';
  if (inRight) return 'right';
  if (clientX > left && clientX < right && clientY > top && clientY < bottom) return 'body';
  return null;
}

const isCorner = (z: Zone): z is 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' =>
  z === 'top-left' || z === 'top-right' || z === 'bottom-left' || z === 'bottom-right';
const isEdge = (z: Zone): z is 'top' | 'bottom' | 'left' | 'right' =>
  z === 'top' || z === 'bottom' || z === 'left' || z === 'right';

/**
 * §2 minimum size collapse: if the item's on-screen box is smaller than
 * 24x24px in either dimension, all 8 transform zones are disabled. Only
 * move and rotate (Ctrl+drag) remain.
 */
function zonesDisabled(item: BoxLike, viewport: ViewportState): boolean {
  return Math.min(item.width * viewport.zoom, item.height * viewport.zoom) < MIN_SCREEN_SIZE_PX;
}

/**
 * Shared transform math for a live drag (used by both pointermove preview and
 * pointerup commit so the committed result always matches the preview).
 * Returns null when nothing changed.
 *
 * §3: the anchor (d.ox/d.oy) is decided at drag start by the modifiers —
 * opposite edge/corner by default, item center with Alt. The pointer's world
 * position determines the controlled dimension; the perpendicular dimension
 * follows proportionally (no Shift) or stays fixed (Shift).
 */
function computePatch(
  d: DragState,
  mx: number,
  my: number,
  shiftKey: boolean,
  zoom: number,
  freeTransform?: boolean,
): BoxPatch | null {
  if (d.mode === 'aspect-reset') {
    // §3 RESET ASPECT RATIO: a click, not a drag — fires on click-up only if
    // the pointer barely moved (within one screen px of where it went down),
    // so a real drag still moves the item. Snaps to 1:1 keeping the area
    // fixed. NOTE: the caller passes the ON-HOLD delta as (pointer - drag
    // start) by giving d.ox = d.startPX for this mode — see startDrag.
    if (Math.abs(mx * zoom) > 1 || Math.abs(my * zoom) > 1) return null;
    if (d.startW <= 0 || d.startH <= 0) return null;
    const area = d.startW * d.startH;
    const side = Math.sqrt(area);
    const x = d.startX + d.startW / 2 - side / 2;
    const y = d.startY + d.startH / 2 - side / 2;
    return { x, y, width: side, height: side };
  }
  if (d.mode === 'move') {
    // §3 CONSTRAIN TO AXIS: Shift+drag locks to the axis with the larger
    // initial delta; the locked axis is decided on the first move.
    if (d.axis === 'pending') {
      if (Math.abs(mx) >= Math.abs(my)) {
        d.axis = 'x';
      } else {
        d.axis = 'y';
      }
    }
    if (d.axis === 'x') return { x: d.startX + mx };
    if (d.axis === 'y') return { y: d.startY + my };
    return { x: d.startX + mx, y: d.startY + my };
  }
  if (d.mode === 'rotate') {
    const angle =
      d.startRot +
      ((Math.atan2(my, mx) - Math.atan2(d.startPY - d.oy, d.startPX - d.ox)) * 180) / Math.PI;
    return { rotation: Math.round((shiftKey ? Math.round(angle / 45) * 45 : angle) * 10) / 10 };
  }

  // resize — all dims are world px; enforce a minimum on-screen size by
  // converting the 24px screen minimum to world px.
  const minDim = Math.max(MIN_SCREEN_SIZE_PX / zoom, 4);
  const corner = isCorner(d.zone);
  // freeTransform (notes): Shift LOCKS aspect; default is free.
  // images: default locks aspect; Shift unlocks.
  const proportional = freeTransform ? shiftKey : !shiftKey;
  const absW = Math.max(minDim, Math.abs(mx));
  const absH = Math.max(minDim, Math.abs(my));
  if (corner) {
    // Scale about the anchor (opposite corner or center). Both dimensions
    // follow the larger axis delta, scaled to preserve aspect ratio when
    // proportional; with Shift each axis is controlled independently.
    const sxs = d.startW > 1 ? mx / d.startW : 1;
    const sys = d.startH > 1 ? my / d.startH : 1;
    const scale = proportional ? Math.max(Math.abs(sxs), Math.abs(sys)) : 1;
    const w = proportional ? Math.abs(d.startW * scale) : absW;
    const h = proportional ? Math.abs(d.startH * scale) : absH;
    // Directional sign: which way the handle sits relative to the anchor.
    const sx2 = d.zone === 'top-left' || d.zone === 'bottom-left' ? -1 : 1;
    const sy2 = d.zone === 'top-left' || d.zone === 'top-right' ? -1 : 1;
    // When not proportional (Shift), the dragged axis extends toward the
    // cursor with the anchor fixed; the other axis extents from the anchor
    // toward the handle side.
    const x = d.fromCenter ? d.ox - w / 2 : d.ox + sx2 * (mx >= 0 ? 0 : w);
    const y = d.fromCenter ? d.oy - h / 2 : d.oy + sy2 * (my >= 0 ? 0 : h);
    return { x, y, width: w, height: h };
  }
  // Edge zones. Left/right control width; top/bottom control height.
  if (d.zone === 'left' || d.zone === 'right') {
    const newW = absW;
    if (proportional) {
      const scale = d.startW > 1 ? newW / d.startW : 1;
      const newH = d.startH * scale;
      return {
        x: d.fromCenter ? d.ox - newW / 2 : d.zone === 'left' ? d.ox - newW : d.ox,
        y: d.oy - newH / 2,
        width: newW,
        height: newH,
      };
    }
    return {
      x: d.fromCenter ? d.ox - newW / 2 : d.zone === 'left' ? d.ox - newW : d.ox,
      width: newW,
    };
  }
  // top / bottom edge
  const newH = absH;
  if (proportional) {
    const scale = d.startH > 1 ? newH / d.startH : 1;
    const newW = d.startW * scale;
    return {
      x: d.ox - newW / 2,
      y: d.fromCenter ? d.oy - newH / 2 : d.zone === 'top' ? d.oy - newH : d.oy,
      width: newW,
      height: newH,
    };
  }
  return {
    y: d.fromCenter ? d.oy - newH / 2 : d.zone === 'top' ? d.oy - newH : d.oy,
    height: newH,
  };
}

/**
 * §1 MULTI-SELECTED: distribute a transform computed for the combined box
 * onto every selected item.
 *
 * - move: every item translates by the box delta.
 * - resize: items keep their relative positions within the box; each is
 *   scaled by (newW/startW, newH/startH) about the box's anchor, and the
 *   whole selection's top-left maps to the box's new top-left.
 * - rotate: every item rotates by the same delta (about its own center how
 *   the single-item rotate works — but multi-selection rotation rotates
 *   about the box center in most tools; the convention only says "same
 *   rules as single selection", so we keep the simpler "add delta rotation"
 *   for now).
 * - aspect-reset: applies only to a 1-item selection (computePatch guards).
 */
function distributeBoxPatch(
  d: DragState,
  boxPatch: BoxPatch,
  items: Selectable[],
): SelectableChange[] {
  if (items.length === 1) {
    const only = items[0];
    if (only) return [{ id: only.id, kind: only.kind, patch: boxPatch }];
  }
  if (d.mode === 'move' || d.mode === 'aspect-reset') {
    const dx = boxPatch.x !== undefined ? boxPatch.x - d.startX : 0;
    const dy = boxPatch.y !== undefined ? boxPatch.y - d.startY : 0;
    return items.map((it) => ({
      id: it.id,
      kind: it.kind,
      patch: { x: it.x + dx, y: it.y + dy },
    }));
  }
  if (d.mode === 'rotate') {
    const delta = (boxPatch.rotation ?? 0) - d.startRot;
    return items.map((it) => ({
      id: it.id,
      kind: it.kind,
      patch: { rotation: it.rotation + delta },
    }));
  }
  // resize
  const scaleX = boxPatch.width !== undefined && d.startW > 0 ? boxPatch.width / d.startW : 1;
  const scaleY = boxPatch.height !== undefined && d.startH > 0 ? boxPatch.height / d.startH : 1;
  return items.map((it) => {
    // Item position relative to the box's original top-left.
    const relX = it.x - d.startX;
    const relY = it.y - d.startY;
    const newX = boxPatch.x !== undefined ? boxPatch.x + relX * scaleX : it.x;
    const newY = boxPatch.y !== undefined ? boxPatch.y + relY * scaleY : it.y;
    const patch: BoxPatch = {};
    if (boxPatch.x !== undefined) patch.x = newX;
    if (boxPatch.y !== undefined) patch.y = newY;
    if (boxPatch.width !== undefined) patch.width = it.width * scaleX;
    if (boxPatch.height !== undefined) patch.height = it.height * scaleY;
    return { id: it.id, kind: it.kind, patch };
  });
}

export function SelectionOverlay({
  items,
  viewport,
  onPreview,
  onCommit,
  onPreviewItems,
  onCommitItems,
  onClearSelection,
  editing,
  freeTransform,
  onDoubleClick,
}: SelectionOverlayProps) {
  // The combined AABB of every selected item — the ONE box the overlay draws
  // and transforms (§1 MULTI-SELECTED hard rule: never N outlines).
  const box = selectionBox(items);
  const [hovered, setHovered] = useState<Zone>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastPtr = useRef({ x: 0, y: 0 });
  // Shift state of the last pointermove — captured so pointerup commits the
  // exact state the user last saw (snap/proportional behavior).
  const lastShift = useRef(false);
  // Modifier key state for the §5 cursor table (e.g. Ctrl over a selected
  // body shows the rotate cursor).
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onPreviewItemsRef = useRef(onPreviewItems);
  onPreviewItemsRef.current = onPreviewItems;
  const onCommitItemsRef = useRef(onCommitItems);
  onCommitItemsRef.current = onCommitItems;
  const onClearSelectionRef = useRef(onClearSelection);
  onClearSelectionRef.current = onClearSelection;
  const lastViewport = useRef(viewport);
  lastViewport.current = viewport;
  const freeTransformRef = useRef(freeTransform);
  freeTransformRef.current = freeTransform;
  const boxRef = useRef<SelectionBox | null>(box);
  boxRef.current = box;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Original (unpreviewed) positions captured at drag start. The items prop
  // carries live preview patches during a drag, so commit-time distribution
  // must apply deltas to the originals — never the previewed ones, or the
  // delta double-applies.
  const dragOriginItemsRef = useRef<Selectable[] | null>(null);

  const sx = box ? viewport.x + box.x * viewport.zoom : 0;
  const sy = box ? viewport.y + box.y * viewport.zoom : 0;
  const sw = box ? box.width * viewport.zoom : 0;
  const sh = box ? box.height * viewport.zoom : 0;
  const collapsed = box ? zonesDisabled(box, viewport) : false;

  const startDrag = useCallback(
    (clientX: number, clientY: number, ctrlKey: boolean, altKey: boolean, shiftKey: boolean) => {
      const vp = lastViewport.current;
      const b = boxRef.current;
      if (!b) return;
      // Snapshot the current (unpreviewed) items — deltas commit from here.
      dragOriginItemsRef.current = itemsRef.current.map((it) => ({ ...it }));
      // Always record the pointer down position so a click-without-drag (e.g.
      // §3 RESET ASPECT RATIO) commits from the actual down point, not a
      // stale last-pointer.
      lastPtr.current = { x: clientX, y: clientY };
      const zone = hitZone(clientX, clientY, b, vp);
      const w = screenToWorld(clientX, clientY, vp);
      const bodyZone = zone === 'body' || zonesDisabled(b, vp);
      // §3 RESET ASPECT RATIO — Alt + click on the body only, never inside a
      // corner/edge hit-zone. Fires on release (no drag), snaps to 1:1 while
      // keeping the area fixed; never enters the Resizing state.
      // Skipped for freeTransform (notes) — they don't have a canonical aspect.
      if (altKey && !ctrlKey && bodyZone && !shiftKey && !freeTransformRef.current) {
        dragRef.current = {
          mode: 'aspect-reset',
          zone,
          startPX: w.x,
          startPY: w.y,
          startX: b.x,
          startY: b.y,
          startW: b.width,
          startH: b.height,
          startRot: b.rotation,
          ox: b.x,
          oy: b.y,
          fromCenter: false,
        };
        return;
      }
      if (!zone) {
        // Clicked the overlay OUTSIDE the selection box — treat like
        // clicking empty canvas: clear selection (notes included), which
        // removes this overlay and lets the click fall through to the
        // canvas / underlying notes.
        onClearSelectionRef.current?.();
        return;
      }
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      if (ctrlKey) {
        dragRef.current = {
          mode: 'rotate',
          zone,
          startPX: w.x,
          startPY: w.y,
          startX: b.x,
          startY: b.y,
          startW: b.width,
          startH: b.height,
          startRot: b.rotation,
          ox: cx,
          oy: cy,
          fromCenter: true,
        };
      } else if (bodyZone) {
        dragRef.current = {
          mode: 'move',
          zone,
          startPX: w.x,
          startPY: w.y,
          startX: b.x,
          startY: b.y,
          startW: b.width,
          startH: b.height,
          startRot: b.rotation,
          ox: b.x,
          oy: b.y,
          fromCenter: false,
          // §3 CONSTRAIN TO AXIS — Shift+drag on the body (no other modifier)
          // locks movement to the axis with the larger initial delta.
          axis: shiftKey && !altKey ? 'pending' : null,
        };
      } else {
        // §3: the transform anchor is modifier-determined, never by which
        // handle was grabbed. Alt always pins the anchor to the box's
        // center; without Alt it's the opposite edge/corner.
        let ox = cx,
          oy = cy;
        if (!altKey) {
          if (isCorner(zone)) {
            if (zone === 'top-left') {
              ox = b.x + b.width;
              oy = b.y + b.height;
            }
            if (zone === 'top-right') {
              ox = b.x;
              oy = b.y + b.height;
            }
            if (zone === 'bottom-right') {
              ox = b.x;
              oy = b.y;
            }
            if (zone === 'bottom-left') {
              ox = b.x + b.width;
              oy = b.y;
            }
          } else {
            if (zone === 'top') {
              ox = cx;
              oy = b.y + b.height;
            }
            if (zone === 'bottom') {
              ox = cx;
              oy = b.y;
            }
            if (zone === 'left') {
              ox = b.x + b.width;
              oy = cy;
            }
            if (zone === 'right') {
              ox = b.x;
              oy = cy;
            }
          }
        }
        dragRef.current = {
          mode: 'resize',
          zone,
          startPX: w.x,
          startPY: w.y,
          startX: b.x,
          startY: b.y,
          startW: b.width,
          startH: b.height,
          startRot: b.rotation,
          ox,
          oy,
          fromCenter: altKey,
        };
      }
    },
    [],
  );

  // §1: hover tracking on the overlay element.
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (dragRef.current) return;
      const b2 = boxRef.current;
      if (!b2) return;
      setHovered(hitZone(event.clientX, event.clientY, b2, viewport));
    },
    [viewport],
  );
  const onPointerLeave = useCallback(() => {
    if (!dragRef.current) setHovered(null);
  }, []);

  // Overlay pointerdown — fires for body / left / top edges (inside canvas).
  const onOverlayPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (editing) return;
      startDrag(
        event.clientX,
        event.clientY,
        event.ctrlKey || event.metaKey,
        event.altKey,
        event.shiftKey,
      );
    },
    [editing, startDrag],
  );

  // Window-level pointerdown — fires for right / bottom edges that extend
  // past the canvas overflow:hidden. Without this, those zones are unreachable.
  useEffect(() => {
    const onWinDown = (event: PointerEvent) => {
      if (editing) return;
      // Only handle clicks outside the overlay (the overlay has its own handler).
      const overlay = document.querySelector('.selection-overlay');
      if (overlay?.contains(event.target as Node)) return;
      startDrag(
        event.clientX,
        event.clientY,
        event.ctrlKey || event.metaKey,
        event.altKey,
        event.shiftKey,
      );
    };
    window.addEventListener('pointerdown', onWinDown);
    return () => window.removeEventListener('pointerdown', onWinDown);
  }, [editing, startDrag]);

  // Ctrl/Cmd modifier tracking for the §5 cursor table.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setCtrlHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setCtrlHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Global move/up — registered once on mount, reads viewport/item through refs.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      lastPtr.current = { x: event.clientX, y: event.clientY };
      lastShift.current = event.shiftKey;
      const vp = lastViewport.current;
      const w = screenToWorld(event.clientX, event.clientY, vp);
      // §2 / §3: the delta that drives the transform. Move (and the click
      // gesture RESET ASPECT RATIO) preserve the grab offset by measuring
      // from the pointer start; resize/rotate measure from the anchor.
      const fromStart = d.mode === 'move' || d.mode === 'aspect-reset';
      const dx = fromStart ? w.x - d.startPX : w.x - d.ox;
      const dy = fromStart ? w.y - d.startPY : w.y - d.oy;
      const patch = computePatch(d, dx, dy, event.shiftKey, vp.zoom, freeTransformRef.current);
      if (!patch) return;
      const origin = dragOriginItemsRef.current ?? itemsRef.current;
      if (origin.length > 1 && onPreviewItemsRef.current) {
        onPreviewItemsRef.current(distributeBoxPatch(d, patch, origin));
      } else {
        onPreviewRef.current(patch);
      }
    };

    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      const vp = lastViewport.current;
      const w = screenToWorld(lastPtr.current.x, lastPtr.current.y, vp);
      const fromStart = d.mode === 'move' || d.mode === 'aspect-reset';
      const dx = fromStart ? w.x - d.startPX : w.x - d.ox;
      const dy = fromStart ? w.y - d.startPY : w.y - d.oy;
      // Commit exactly the last previewed result (Shift state included) so
      // the committed patch never jumps from what the user saw.
      const patch = computePatch(d, dx, dy, lastShift.current, vp.zoom, freeTransformRef.current);
      if (!patch) return;
      const origin = dragOriginItemsRef.current ?? itemsRef.current;
      if (origin.length > 1 && onCommitItemsRef.current) {
        onCommitItemsRef.current(distributeBoxPatch(d, patch, origin));
      } else {
        onCommitRef.current(patch);
      }
      dragOriginItemsRef.current = null;
      dragRef.current = null;
      setHovered(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // §1: a pointercancel (e.g. the platform reclaiming the pointer after the
    // pointer leaves the overlay's hit zones) must release the item exactly
    // like a pointerup — otherwise the drag sticks and the cursor stays
    // locked ("grabbing") forever.
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const cursor = (() => {
    const d = dragRef.current;
    if (d) {
      if (d.mode === 'rotate' || d.mode === 'aspect-reset') return 'crosshair';
      if (d.mode === 'move') return 'grabbing';
      switch (d.zone) {
        case 'top':
        case 'bottom':
          return 'ns-resize';
        case 'left':
        case 'right':
          return 'ew-resize';
        case 'top-left':
        case 'bottom-right':
          return 'nwse-resize';
        case 'top-right':
        case 'bottom-left':
          return 'nesw-resize';
        default:
          return 'grabbing';
      }
    }
    const h = collapsed ? ('body' as Zone) : hovered;
    switch (h) {
      case 'top':
      case 'bottom':
        return 'ns-resize';
      case 'left':
      case 'right':
        return 'ew-resize';
      case 'top-left':
      case 'bottom-right':
        return 'nwse-resize';
      case 'top-right':
      case 'bottom-left':
        return 'nesw-resize';
      case 'body':
        // §5: Ctrl/Cmd held over a selected item's body = rotate cursor.
        return ctrlHeld ? 'crosshair' : 'grab';
      default:
        return 'grab';
    }
  })();

  return (
    <>
      {/* §1 MULTI-SELECTED: exactly ONE combined bounding box around the
          full extent. Never per-item outlines. */}
      {box ? (
        <div
          className={`selection-overlay${editing ? ' selection-overlay--editing' : ''}`}
          style={{
            position: 'absolute',
            left: sx,
            top: sy,
            width: sw,
            height: sh,
            cursor,
            // §4 RULE 3 — while editing a note the shell is a pure
            // visual (dashed outline): no pointer capture, no zones, so the
            // textarea underneath is fully interactive.
            pointerEvents: editing ? 'none' : 'auto',
            border: 'none',
            outline: editing
              ? '1.5px dashed rgba(214, 255, 118, 0.6)'
              : `${SELECTED_OUTLINE_PX}px solid ${ACCENT}`,
            outlineOffset: 0,
            boxShadow: '0 0 18px rgb(196 240 108 / 18%)',
            transformOrigin: 'center',
            zIndex: 3,
          }}
          onPointerDown={editing ? undefined : onOverlayPointerDown}
          onPointerMove={editing ? undefined : onPointerMove}
          onPointerLeave={editing ? undefined : onPointerLeave}
          onDoubleClick={editing ? undefined : onDoubleClick}
          role="application"
        >
          {/* Edge hit zones — §2: 8px screen-space band, disabled when the item
          is below the minimum on-screen size (§2 min-size collapse, move
          and rotate only). */}
          <div
            style={{
              position: 'absolute',
              top: -EDGE_HIT_ZONE_PX / 2,
              left: 0,
              width: '100%',
              height: EDGE_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 4,
              display: collapsed ? 'none' : 'block',
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: -EDGE_HIT_ZONE_PX / 2,
              left: 0,
              width: '100%',
              height: EDGE_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 4,
              display: collapsed ? 'none' : 'block',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: -EDGE_HIT_ZONE_PX / 2,
              top: 0,
              height: '100%',
              width: EDGE_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 4,
              display: collapsed ? 'none' : 'block',
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: -EDGE_HIT_ZONE_PX / 2,
              top: 0,
              height: '100%',
              width: EDGE_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 4,
              display: collapsed ? 'none' : 'block',
            }}
          />
          {/* Corner hit zones — §2: 10x10px, z-index above edges so the corner
          wins wherever they overlap (§3 zone priority). */}
          <div
            style={{
              position: 'absolute',
              left: -CORNER_HIT_ZONE_PX / 2,
              top: -CORNER_HIT_ZONE_PX / 2,
              width: CORNER_HIT_ZONE_PX,
              height: CORNER_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 5,
              display: collapsed ? 'none' : 'block',
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: -CORNER_HIT_ZONE_PX / 2,
              top: -CORNER_HIT_ZONE_PX / 2,
              width: CORNER_HIT_ZONE_PX,
              height: CORNER_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 5,
              display: collapsed ? 'none' : 'block',
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: -CORNER_HIT_ZONE_PX / 2,
              bottom: -CORNER_HIT_ZONE_PX / 2,
              width: CORNER_HIT_ZONE_PX,
              height: CORNER_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 5,
              display: collapsed ? 'none' : 'block',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: -CORNER_HIT_ZONE_PX / 2,
              bottom: -CORNER_HIT_ZONE_PX / 2,
              width: CORNER_HIT_ZONE_PX,
              height: CORNER_HIT_ZONE_PX,
              pointerEvents: 'auto',
              zIndex: 5,
              display: collapsed ? 'none' : 'block',
            }}
          />
          {/* Edge indicator */}
          {!collapsed && isEdge(hovered) && (
            <div
              style={{
                position: 'absolute',
                pointerEvents: 'none',
                background: ACCENT,
                ...(hovered === 'top' && {
                  top: -0.5,
                  left: 0,
                  width: '100%',
                  height: ACTIVE_EDGE_OUTLINE_PX,
                }),
                ...(hovered === 'bottom' && {
                  bottom: -0.5,
                  left: 0,
                  width: '100%',
                  height: ACTIVE_EDGE_OUTLINE_PX,
                }),
                ...(hovered === 'left' && {
                  left: -0.5,
                  top: 0,
                  width: ACTIVE_EDGE_OUTLINE_PX,
                  height: '100%',
                }),
                ...(hovered === 'right' && {
                  right: -0.5,
                  top: 0,
                  width: ACTIVE_EDGE_OUTLINE_PX,
                  height: '100%',
                }),
              }}
            />
          )}
          {/* Corner handle */}
          {!collapsed && isCorner(hovered) && (
            <div
              style={{
                position: 'absolute',
                pointerEvents: 'none',
                width: CORNER_HANDLE_PX,
                height: CORNER_HANDLE_PX,
                background: ACCENT,
                border: '1.5px solid #101419',
                ...(hovered === 'top-left' && {
                  left: -(CORNER_HANDLE_PX / 2),
                  top: -(CORNER_HANDLE_PX / 2),
                }),
                ...(hovered === 'top-right' && {
                  right: -(CORNER_HANDLE_PX / 2),
                  top: -(CORNER_HANDLE_PX / 2),
                }),
                ...(hovered === 'bottom-right' && {
                  right: -(CORNER_HANDLE_PX / 2),
                  bottom: -(CORNER_HANDLE_PX / 2),
                }),
                ...(hovered === 'bottom-left' && {
                  left: -(CORNER_HANDLE_PX / 2),
                  bottom: -(CORNER_HANDLE_PX / 2),
                }),
              }}
            />
          )}
        </div>
      ) : null}
    </>
  );
}
