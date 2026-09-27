import { useEffect, useRef, useState } from 'react';
import {
  anglesFacing,
  DEFAULT_MODEL_SUN,
  isFacing,
  lerpAngles,
  type ModelSettings,
  type ModelSun,
  type ModelView,
  orbit,
  projectDirection,
  rotateSun,
  SUN_RADIANS_PER_PX,
  sunOf,
  viewOf,
} from '@/canvas/nodes/modelView';
import type { SpriteNode } from '@/canvas/nodes/types';
import { CLICK_EPSILON_PX } from '@/canvas/transform';

/** Gizmo diameter and inset from the viewport's corner (screen px). */
const SIZE = 72;
const INSET = 8;
/** Below this on-screen size the viewport is too small to carry it. */
const MIN_VIEWPORT = { width: 180, height: 140 };
/** Axis tip distance from the centre, in the SVG's units (= px). */
const TIP = 24;
/** Hit radii (px) of the sun and the axis balls. */
const SUN_HIT = 10;
const AXIS_HIT = 7.5;
/** An axis click eases the camera round over this long. */
const AXIS_EASE_MS = 280;
/** Arrow keys turn the view (Shift: the sun) this far. */
const KEY_STEP_RADIANS = Math.PI / 12;

type Vec = { x: number; y: number; z: number };

/** Blender's axes (Z up) in the viewer's model space (Y up, glTF). */
const AXES = [
  { label: 'X', color: '#f0505f', vector: { x: 1, y: 0, z: 0 } },
  { label: 'Y', color: '#79c23a', vector: { x: 0, y: 0, z: -1 } },
  { label: 'Z', color: '#3f8ee8', vector: { x: 0, y: 1, z: 0 } },
] as const;

type Mark =
  | { kind: 'axis'; key: string; label: string; color: string; positive: boolean; vector: Vec }
  | { kind: 'sun'; key: 'sun'; vector: Vec };

type Drag = {
  mode: 'orbit' | 'sun' | 'axis';
  x: number;
  y: number;
  moved: boolean;
  view: ModelView;
  sun: ModelSun;
  axis: Vec | null;
};

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * A selected model's navigation gizmo, top-right of its viewport, in
 * Blender's colours and axes (turning with the camera):
 * - drag the ball: orbit the camera;
 * - drag the sun: swing the light around the model;
 * - click an axis: ease round to an orthographic view straight down it
 *   (clicked again, the opposite side). Orbiting away returns to
 *   perspective.
 * Double-click the sun to put it back; arrows orbit, Shift+arrows turn the
 * sun. Exists only while the model is selected (Section 0 Rule 8).
 */
export function ModelGizmo({
  node,
  viewport,
  settings,
  onPreview,
  onCommit,
}: {
  node: SpriteNode;
  viewport: { x: number; y: number; zoom: number };
  /** The settings on screen (a live orbit or sun drag included). */
  settings: ModelSettings;
  onPreview: (settings: ModelSettings | null) => void;
  onCommit: (patch: Partial<ModelSettings>, label: string) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const easing = useRef<number | null>(null);
  const [active, setActive] = useState<Drag['mode'] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (easing.current !== null) cancelAnimationFrame(easing.current);
    },
    [],
  );

  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  if (width < MIN_VIEWPORT.width || height < MIN_VIEWPORT.height) return null;

  const centerX = viewport.x + (node.x + node.width / 2) * viewport.zoom;
  const centerY = viewport.y + (node.y + node.height / 2) * viewport.zoom;
  const radians = (-node.rotation * Math.PI) / 180;
  /** A client-space offset in the item's own (rotated) frame. */
  const local = (dx: number, dy: number) => ({
    x: dx * Math.cos(radians) - dy * Math.sin(radians),
    y: dx * Math.sin(radians) + dy * Math.cos(radians),
  });

  const sun = sunOf(settings);
  const marks: Mark[] = [
    ...AXES.flatMap(({ label, color, vector }) => [
      { kind: 'axis' as const, key: label, label, color, positive: true, vector },
      {
        kind: 'axis' as const,
        key: `-${label}`,
        label,
        color,
        positive: false,
        vector: { x: -vector.x, y: -vector.y, z: -vector.z },
      },
    ]),
    { kind: 'sun', key: 'sun', vector: { x: sun.sunX, y: sun.sunY, z: sun.sunZ } },
  ];
  // Far to near: nearer marks paint (and hit) on top.
  const placed = marks
    .map((mark) => ({ mark, at: projectDirection(mark.vector, settings) }))
    .sort((a, b) => a.at.depth - b.at.depth);

  /** The mark under a gizmo-local point (px from its centre), if any. */
  const markAt = (x: number, y: number) =>
    [...placed].reverse().find(({ mark, at }) => {
      const reach = mark.kind === 'sun' ? SUN_HIT : AXIS_HIT;
      return Math.hypot(at.x * TIP - x, at.y * TIP - y) <= reach;
    })?.mark ?? null;
  const pointIn = (element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    return local(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
  };

  /** Ease the camera to look straight down `direction`, then commit an
   *  orthographic axis view (already there: the opposite side). */
  const faceAxis = (direction: Vec) => {
    const already = settings.projection === 'orthographic' && isFacing(settings, direction);
    const target = already ? { x: -direction.x, y: -direction.y, z: -direction.z } : direction;
    const from = { yaw: settings.yaw, pitch: settings.pitch };
    const to = anglesFacing(target);
    const start = performance.now();
    if (easing.current !== null) cancelAnimationFrame(easing.current);
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / AXIS_EASE_MS);
      onPreview({ ...settings, ...lerpAngles(from, to, easeOut(t)) });
      if (t < 1) {
        easing.current = requestAnimationFrame(frame);
        return;
      }
      easing.current = null;
      onCommit({ ...to, projection: 'orthographic', axisView: true }, 'Axis View');
      onPreview(null);
    };
    easing.current = requestAnimationFrame(frame);
  };

  const dragged = (current: Drag, clientX: number, clientY: number): ModelSettings => {
    const delta = local(clientX - current.x, clientY - current.y);
    if (current.mode === 'sun') {
      return { ...settings, ...rotateSun(current.sun, current.view, delta.x, delta.y) };
    }
    // The ball orbits like the viewport would (same speed per px).
    return { ...settings, ...orbit(current.view, delta.x, delta.y, height) };
  };

  const hoveredMark = hovered ? marks.find((mark) => mark.key === hovered) : undefined;
  const cursor =
    active === 'orbit' || active === 'sun'
      ? 'grabbing'
      : hoveredMark?.kind === 'axis'
        ? 'pointer'
        : 'grab';

  return (
    <div
      className="model-gizmo-frame"
      style={{
        left: centerX - width / 2,
        top: centerY - height / 2,
        width,
        height,
        transform: `rotate(${node.rotation}deg)`,
      }}
    >
      <button
        type="button"
        className={`model-gizmo${active ? ' dragging' : ''}`}
        style={{ width: SIZE, height: SIZE, top: INSET, right: INSET, cursor }}
        aria-label="3D view: drag to orbit, drag the sun to move the light, click an axis for a straight-on view"
        data-testid="model-gizmo"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // The gizmo's own: never a move of the item.
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = pointIn(event.currentTarget, event.clientX, event.clientY);
          const mark = markAt(point.x, point.y);
          const mode = mark?.kind === 'sun' ? 'sun' : mark ? 'axis' : 'orbit';
          drag.current = {
            mode,
            x: event.clientX,
            y: event.clientY,
            moved: false,
            view: viewOf(settings),
            sun,
            axis: mark?.kind === 'axis' ? mark.vector : null,
          };
          setActive(mode);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) {
            const point = pointIn(event.currentTarget, event.clientX, event.clientY);
            setHovered(markAt(point.x, point.y)?.key ?? null);
            return;
          }
          const travel = Math.hypot(event.clientX - current.x, event.clientY - current.y);
          if (!current.moved && travel < CLICK_EPSILON_PX) return;
          current.moved = true;
          // Dragging from an axis ball orbits (only a click picks the axis).
          if (current.mode === 'axis') {
            current.mode = 'orbit';
            setActive('orbit');
          }
          onPreview(dragged(current, event.clientX, event.clientY));
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (!current) return;
          drag.current = null;
          setActive(null);
          if (!current.moved) {
            if (current.mode === 'axis' && current.axis) faceAxis(current.axis);
            return;
          }
          const result = dragged(current, event.clientX, event.clientY);
          if (current.mode === 'sun') onCommit(sunOf(result), 'Sun');
          else onCommit(viewOf(result), 'Orbit');
          onPreview(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setActive(null);
          onPreview(null);
        }}
        onPointerLeave={() => setHovered(null)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          const point = pointIn(event.currentTarget, event.clientX, event.clientY);
          if (markAt(point.x, point.y)?.kind === 'sun') onCommit(DEFAULT_MODEL_SUN, 'Reset Sun');
        }}
        onKeyDown={(event) => {
          const steps: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          };
          const step = steps[event.key];
          if (!step) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            const px = KEY_STEP_RADIANS / SUN_RADIANS_PER_PX;
            onCommit(rotateSun(sun, settings, step[0] * px, step[1] * px), 'Sun');
          } else {
            // orbit() turns half a turn per viewport height.
            const px = (KEY_STEP_RADIANS / Math.PI) * height;
            onCommit(orbit(viewOf(settings), step[0] * px, step[1] * px, height), 'Orbit');
          }
        }}
      >
        <svg viewBox="-36 -36 72 72" aria-hidden="true">
          {placed.map(({ mark, at }) => {
            const x = at.x * TIP;
            const y = at.y * TIP;
            const hot = hovered === mark.key;
            if (mark.kind === 'sun') {
              const behind = at.depth < 0;
              return (
                <g
                  key="sun"
                  className={`model-gizmo-sun${behind ? ' behind' : ''}${hot ? ' hot' : ''}`}
                >
                  <line x1={0} y1={0} x2={x} y2={y} />
                  <circle cx={x} cy={y} r={5.5} />
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((ray) => {
                    const angle = (ray * Math.PI) / 4;
                    return (
                      <line
                        key={ray}
                        className="ray"
                        x1={x + Math.cos(angle) * 7.5}
                        y1={y + Math.sin(angle) * 7.5}
                        x2={x + Math.cos(angle) * 10}
                        y2={y + Math.sin(angle) * 10}
                      />
                    );
                  })}
                </g>
              );
            }
            return mark.positive ? (
              <g key={mark.key} className={`model-gizmo-axis${hot ? ' hot' : ''}`}>
                <line x1={0} y1={0} x2={x} y2={y} stroke={mark.color} strokeWidth={2} />
                <circle cx={x} cy={y} r={6.5} fill={mark.color} />
                <text x={x} y={y} className="model-gizmo-label">
                  {mark.label}
                </text>
              </g>
            ) : (
              <circle
                key={mark.key}
                className={`model-gizmo-axis negative${hot ? ' hot' : ''}`}
                cx={x}
                cy={y}
                r={4.5}
                fill={mark.color}
              />
            );
          })}
        </svg>
      </button>
    </div>
  );
}
