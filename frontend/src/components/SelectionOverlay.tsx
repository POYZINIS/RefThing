import { useEffect, useRef, useState } from 'react';
import type { Item, ItemPatch } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';

type SelectionOverlayProps = {
  item: Item;
  viewport: ViewportState;
  onPreview: (patch: ItemPatch) => void;
  onCommit: (patch: ItemPatch) => void;
};

type DragMode = 'resize' | 'rotate';

type DragState = {
  mode: DragMode;
  startX: number;
  startY: number;
  startRotation: number;
};

export function SelectionOverlay({ item, viewport, onPreview, onCommit }: SelectionOverlayProps) {
  const drag = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<ItemPatch>({});
  const currentItem = { ...item, ...preview };

  useEffect(() => {
    if (!drag.current) return;
    const onMove = (event: PointerEvent) => {
      const active = drag.current;
      if (!active) return;
      const centerX = item.x + item.width / 2;
      const centerY = item.y + item.height / 2;
      const pointerX = (event.clientX - viewport.x) / viewport.zoom;
      const pointerY = (event.clientY - viewport.y) / viewport.zoom;
      let patch: ItemPatch;
      if (active.mode === 'rotate') {
        const startAngle = Math.atan2(active.startY - centerY, active.startX - centerX);
        const angle = Math.atan2(pointerY - centerY, pointerX - centerX);
        patch = { rotation: active.startRotation + ((angle - startAngle) * 180) / Math.PI };
      } else {
        patch = {
          width: Math.max(32, pointerX - item.x),
          height: Math.max(32, pointerY - item.y),
        };
      }
      setPreview(patch);
      onPreview(patch);
    };
    const onUp = () => {
      if (drag.current) onCommit({ ...preview });
      drag.current = null;
      setPreview({});
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [item, onCommit, onPreview, preview, viewport]);

  const startDrag = (mode: DragMode) => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    drag.current = {
      mode,
      startX: (event.clientX - viewport.x) / viewport.zoom,
      startY: (event.clientY - viewport.y) / viewport.zoom,
      startRotation: item.rotation,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const left = viewport.x + currentItem.x * viewport.zoom;
  const top = viewport.y + currentItem.y * viewport.zoom;
  const width = currentItem.width * viewport.zoom;
  const height = currentItem.height * viewport.zoom;

  return (
    <div
      className="selection-overlay"
      style={{ left, top, width, height, transform: `rotate(${currentItem.rotation}deg)` }}
    >
      <button
        className="selection-handle resize-handle"
        type="button"
        aria-label="Resize image"
        onPointerDown={startDrag('resize')}
      />
      <button
        className="selection-handle rotate-handle"
        type="button"
        aria-label="Rotate image"
        onPointerDown={startDrag('rotate')}
      />
    </div>
  );
}
