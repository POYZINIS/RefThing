import { useEffect, useRef, useState } from 'react';
import { heldModifiers, type PressAction, resolvePress } from '@/canvas/bindings';
import { isHeld } from '@/canvas/heldKeys';
import {
  dolly,
  MODEL_FOV_Y,
  type ModelSettings,
  type ModelView,
  modelSettings,
  orbit,
  pan,
  settingsKey,
  viewOf,
} from '@/canvas/nodes/modelView';
import type { SpriteNode } from '@/canvas/nodes/types';

/** A wheel pause this long ends one dolly (one commit). */
const WHEEL_SETTLE_MS = 250;

/**
 * Orbit mode for a selected 3D model (double-click it; Escape or a click
 * elsewhere ends it). A transparent surface over the item takes the
 * presses: drag turns the camera, Shift+drag pans it, the wheel moves it in
 * and out — all resolved through the bindings (target `orbit`). Presses the
 * bindings give to the board (middle-drag pan) go back to the board. The
 * model's pixels are still the canvas's; only the view changes, and each
 * finished gesture is committed.
 */
export function ModelOrbit({
  node,
  viewport,
  onPreview,
  onCommit,
  onBoardPress,
}: {
  node: SpriteNode;
  viewport: { x: number; y: number; zoom: number };
  onPreview: (settings: ModelSettings | null) => void;
  onCommit: (view: ModelView) => void;
  onBoardPress: (event: PointerEvent, action: 'pan' | 'drag_zoom' | 'move_window') => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const stored = node.model ?? modelSettings(undefined);
  /** The view being shown: the stored one, or the gesture's. */
  const view = useRef<ModelView>(viewOf(stored));
  const drag = useRef<{ action: PressAction; x: number; y: number } | null>(null);
  const wheelTimer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  // An outside change (undo, the menu's Reset View) moves the view — unless
  // a gesture is under way.
  const storedKey = settingsKey(stored);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the settings' value
  useEffect(() => {
    if (!drag.current && wheelTimer.current === null) view.current = viewOf(stored);
  }, [storedKey]);

  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  const latest = useRef({ stored, width, height, rotation: node.rotation, onPreview, onCommit });
  latest.current = { stored, width, height, rotation: node.rotation, onPreview, onCommit };

  const show = (next: ModelView) => {
    view.current = next;
    latest.current.onPreview({ ...latest.current.stored, ...next });
  };
  const commit = () => {
    latest.current.onCommit(view.current);
    latest.current.onPreview(null);
  };

  // The wheel needs a non-passive listener to keep the board from zooming.
  // biome-ignore lint/correctness/useExhaustiveDependencies: show/commit read refs
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      show(dolly(view.current, pixels));
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        wheelTimer.current = null;
        commit();
      }, WHEEL_SETTLE_MS);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      // Leaving mid-dolly still keeps it.
      if (wheelTimer.current !== null) {
        window.clearTimeout(wheelTimer.current);
        wheelTimer.current = null;
        commit();
      }
    };
  }, []);

  /** A client-space pointer delta in the item's own (rotated) frame. */
  const local = (dx: number, dy: number) => {
    const radians = (-latest.current.rotation * Math.PI) / 180;
    return {
      x: dx * Math.cos(radians) - dy * Math.sin(radians),
      y: dx * Math.sin(radians) + dy * Math.cos(radians),
    };
  };

  const centerX = viewport.x + (node.x + node.width / 2) * viewport.zoom;
  const centerY = viewport.y + (node.y + node.height / 2) * viewport.zoom;
  return (
    <div
      ref={surface}
      className={`model-orbit${dragging ? ' dragging' : ''}`}
      data-testid="model-orbit"
      // A custom pointer surface: drag orbits, Shift+drag pans, wheel zooms.
      role="application"
      aria-label="3D view: drag to orbit, Shift+drag to pan, scroll to zoom"
      style={{
        left: centerX - width / 2,
        top: centerY - height / 2,
        width,
        height,
        transform: `rotate(${node.rotation}deg)`,
      }}
      onPointerDown={(event) => {
        const native = event.nativeEvent;
        const action = resolvePress(event.button, heldModifiers(native, isHeld), 'orbit');
        if (action === 'pan' || action === 'drag_zoom' || action === 'move_window') {
          onBoardPress(native, action);
          return;
        }
        if (action !== 'orbit' && action !== 'orbit_pan') return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { action, x: event.clientX, y: event.clientY };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        const delta = local(event.clientX - current.x, event.clientY - current.y);
        current.x = event.clientX;
        current.y = event.clientY;
        const { width: w, height: h } = latest.current;
        show(
          current.action === 'orbit_pan'
            ? pan(view.current, delta.x, delta.y, w, h, MODEL_FOV_Y)
            : orbit(view.current, delta.x, delta.y, h),
        );
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        commit();
      }}
      onPointerCancel={() => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        commit();
      }}
      // Double-clicks inside orbit mode mean nothing (never zoom the board).
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
