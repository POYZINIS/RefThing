import { useRef, useState } from 'react';
import type { ViewportState } from '@/canvas/BoardCanvas';

type DrawingOverlayProps = {
  enabled: boolean;
  viewport: ViewportState;
  initialStrokes?: Point[][];
  onCommit?: (strokes: Point[][]) => void;
};

type Point = { x: number; y: number };
type Stroke = { id: string; points: Point[] };

export function DrawingOverlay({
  enabled,
  viewport,
  initialStrokes = [],
  onCommit,
}: DrawingOverlayProps) {
  const [strokes, setStrokes] = useState<Stroke[]>(() =>
    initialStrokes.map((points) => ({ id: crypto.randomUUID(), points })),
  );
  const active = useRef<Point[] | null>(null);
  const activeId = useRef<string | null>(null);

  if (!enabled) return null;
  const begin = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = toWorld(event, viewport);
    active.current = [point];
    activeId.current = crypto.randomUUID();
    setStrokes((current) => [
      ...current,
      { id: activeId.current ?? crypto.randomUUID(), points: active.current ?? [] },
    ]);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!active.current) return;
    active.current.push(toWorld(event, viewport));
    setStrokes((current) =>
      current.map((stroke) =>
        stroke.id === activeId.current ? { ...stroke, points: active.current ?? [] } : stroke,
      ),
    );
  };
  const finish = () => {
    onCommit?.(strokes.map((stroke) => stroke.points));
    active.current = null;
    activeId.current = null;
  };

  return (
    <svg
      className="drawing-overlay"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      aria-label="Freehand annotations"
    >
      {strokes.map((stroke) => (
        <polyline
          key={stroke.id}
          points={stroke.points
            .map(
              (point) =>
                `${viewport.x + point.x * viewport.zoom},${viewport.y + point.y * viewport.zoom}`,
            )
            .join(' ')}
          fill="none"
          stroke="#d6ff76"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={3}
        />
      ))}
    </svg>
  );
}

function toWorld(event: React.PointerEvent<SVGSVGElement>, viewport: ViewportState): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - viewport.x) / viewport.zoom,
    y: (event.clientY - rect.top - viewport.y) / viewport.zoom,
  };
}
