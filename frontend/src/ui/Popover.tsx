import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { enter } from '@/ui/motion';

type Placement = 'below-start' | 'below-end' | 'above-center';

type Point = { x: number; y: number };

/**
 * A small non-modal panel anchored to a chrome control (the board list) or
 * to a point (search, opened where the board was right-clicked). Escape or a
 * press outside closes it and focus returns to an anchoring control.
 * Positioned fixed, so no container ever clips it.
 */
export function Popover({
  anchor,
  onClose,
  placement = 'below-start',
  label,
  className = '',
  children,
}: {
  anchor: RefObject<HTMLElement | null> | Point;
  onClose: () => void;
  placement?: Placement;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const point = 'current' in anchor ? null : anchor;
  const element = 'current' in anchor ? anchor : null;
  const pointX = point?.x;
  const pointY = point?.y;

  useLayoutEffect(() => {
    const place = () => {
      const from =
        pointX !== undefined && pointY !== undefined
          ? new DOMRect(pointX, pointY, 0, 0)
          : element?.current?.getBoundingClientRect();
      const rect = panel.current?.getBoundingClientRect();
      if (!from || !rect) return;
      const margin = 8;
      const left =
        placement === 'below-start'
          ? from.left
          : placement === 'below-end'
            ? from.right - rect.width
            : from.left + from.width / 2 - rect.width / 2;
      // A point opens right there, like a context menu; a control, below it.
      const gap = pointX === undefined ? 8 : 0;
      const top = placement === 'above-center' ? from.top - rect.height - 10 : from.bottom + gap;
      setPosition({
        left: Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin)),
        top: Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [element, pointX, pointY, placement]);

  // Once placed (it renders hidden for one measuring pass, and hidden
  // elements can't take focus): animate in, and focus the current row, else
  // the first control, so the keyboard can work the list.
  const shown = useRef(false);
  useEffect(() => {
    if (!position || shown.current) return;
    shown.current = true;
    enter(panel.current, 'pop');
    const target =
      panel.current?.querySelector<HTMLElement>('[aria-current="true"]') ??
      panel.current?.querySelector<HTMLElement>('button, input, [tabindex="0"]');
    target?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    const anchorElement = element?.current ?? null;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchorElement?.contains(target)) return;
      onClose();
    };
    // Capture phase on window: Escape closes the popover and nothing else
    // (not the board's deselect), wherever focus is.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A field that cancels its own edit on Escape (inline rename) keeps it.
      if ((event.target as Element | null)?.closest?.('[data-own-escape]')) return;
      event.stopPropagation();
      onClose();
      anchorElement?.focus();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [element, onClose]);

  // Portalled to <body>: a transformed or backdrop-filtered ancestor (every
  // chrome group) would otherwise become the fixed position's frame.
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={`popover ${placement === 'above-center' ? 'from-bottom' : ''} ${className}`}
      style={
        position
          ? { left: position.left, top: position.top }
          : { left: -9999, top: -9999, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
