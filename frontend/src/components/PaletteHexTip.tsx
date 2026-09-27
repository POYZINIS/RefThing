import { useEffect, useState } from 'react';
import { screenToWorld } from '@/canvas/coordinates';
import type { SpriteNode } from '@/canvas/nodes/types';
import { swatchAt, swatchCenter } from '@/color/items';

/** Below this width on screen (px) a swatch is too small to point at. */
const MIN_SWATCH_PX = 14;

// The last pointer position, so a tip shows on the very move that hovered
// the palette (it mounts after that move).
let pointer: PointerEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (event) => {
      pointer = event;
    },
    { capture: true, passive: true },
  );
}

/**
 * The hovered palette swatch's hex, in a small glass tip above the palette
 * (palettes print nothing on their colours). Hover only — it edits nothing;
 * gone while a button is held (a drag, a pull).
 */
export function PaletteHexTip({
  node,
  camera,
  host,
}: {
  node: SpriteNode;
  camera: { x: number; y: number; zoom: number };
  host: HTMLElement | null;
}) {
  const colors = node.colors ?? [];
  const [index, setIndex] = useState<number | null>(null);
  const box = {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
  };
  const swatchPx = (node.width / Math.max(1, colors.length)) * camera.zoom;

  useEffect(() => {
    if (!host) return;
    const move = (event: PointerEvent) => {
      if (event.buttons !== 0) {
        setIndex(null);
        return;
      }
      const world = screenToWorld(event, camera, host.getBoundingClientRect());
      setIndex(swatchAt(box, colors.length, world));
    };
    if (pointer && index === null) move(pointer);
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  });

  const hex = index === null ? undefined : colors[index];
  if (index === null || !hex || swatchPx < MIN_SWATCH_PX) return null;
  const center = swatchCenter(box, colors.length, index);
  const top = node.rotatedBounds().top;
  return (
    <div
      className="palette-hex-tip"
      data-testid="palette-hex-tip"
      style={{ left: camera.x + center.x * camera.zoom, top: camera.y + top * camera.zoom - 8 }}
    >
      <i style={{ background: hex }} />
      {hex.toUpperCase()}
    </div>
  );
}
