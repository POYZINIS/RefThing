import iro from '@jaames/iro';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SpriteNode } from '@/canvas/nodes/types';
import {
  BASE_INDEX,
  compressToward,
  HARMONIES,
  HARMONY_LABELS,
  type Harmony,
  type Hsv,
  harmonize,
  hexToHsv,
  hsvToHex,
  hsvToHsl,
  moveSet,
  randomPalette,
  shiftBrightness,
  wheelXY,
} from '@/color/harmony';
import { DEFAULT_WHEEL, type WheelState, wheelBase } from '@/color/items';
import {
  FIELD_RADIUS,
  PANEL_RADIUS,
  type Rect,
  ROW_RADIUS,
  STRIP_RADIUS,
  WHEEL_DOT_PX,
  wheelDetail,
  wheelLayout,
} from '@/color/wheelLayout';
import { Icon } from '@/ui/Icon';
import { enter, reducedMotion } from '@/ui/motion';

/** A press has to travel this far (px) before it drags a palette out. */
const DRAG_OUT_PX = 5;
/** Handles glide to a new palette (a harmony, Random, a loaded one, undo). */
const GLIDE_MS = 260;

type IroHsv = { h: number; s: number; v: number };
const toIro = ({ h, s, v }: Hsv): IroHsv => ({ h, s: s * 100, v: v * 100 });
const fromIro = ({ h, s, v }: IroHsv): Hsv => ({ h, s: s / 100, v: v / 100 });

/** Hard-stopped swatches as one CSS gradient (library rows, the ghost). */
const stripes = (colors: readonly string[]) =>
  `linear-gradient(to right, ${colors
    .map((hex, at) => `${hex} ${(at / colors.length) * 100}% ${((at + 1) / colors.length) * 100}%`)
    .join(', ')})`;

/** A small press-feedback animation (Web Animations; none with reduced motion). */
function play(element: Element, keyframes: Keyframe[], duration: number): void {
  if (reducedMotion()) return;
  element.animate(keyframes, { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
}

/**
 * The colour wheel item's live controls, over the item while it is the lone
 * selection (Section 0 Rule 8); unselected — and zoomed far out — the
 * canvas paints the same layout (the canvas picture is hidden meanwhile, so
 * the panel is real glass over the board). iro.js draws the wheel with a
 * handle per colour — dragging any one turns the whole harmony (Adobe
 * Color). Beside it, the brightness slider: HSV value, or HSL lightness,
 * which extends to white. Letting go of the wheel or the slider saves the
 * palette to the library. Swatches copy their hex on click; the current
 * palette and every saved one drag out onto the board as palette items.
 *
 * Zoomed out ("compact": under 300px wide on screen) only the colour
 * shows — no text, no buttons, handles as dots.
 *
 * Only the controls take the pointer — the wheel only inside its disc:
 * the gaps and margins pass through to the selection shell, so the wheel
 * moves and resizes like any item.
 */
export function ColorWheelPanel({
  node,
  viewport,
  onCommit,
  onCopy,
  onDragOut,
  leaving = false,
}: {
  node: SpriteNode;
  /** Deselected: easing back into the canvas picture (takes no input). */
  leaving?: boolean;
  viewport: { x: number; y: number; zoom: number };
  onCommit: (patch: Partial<WheelState>, label: string) => void;
  onCopy: (hex: string) => void;
  /** A palette dropped outside the panel (client point). */
  onDragOut: (colors: string[], clientX: number, clientY: number) => void;
}) {
  const stored = node.wheel ?? DEFAULT_WHEEL;
  // The live points (a gesture in progress) over the stored ones — exact
  // HSV throughout, never rebuilt from hex (see color/harmony.ts).
  const [live, setLive] = useState<Hsv[] | null>(null);
  const points = live ?? stored.points;
  const base = points[BASE_INDEX] ?? wheelBase(stored);
  const colors = points.map(hsvToHex);
  const latest = useRef({ stored, points, onCommit });
  latest.current = { stored, points, onCommit };
  /** The points when the gesture under way began: every edit moves the set
   *  from there, so nothing drifts or snaps back to the harmony. */
  const gestureStart = useRef<Hsv[] | null>(null);

  const zoom = viewport.zoom;
  const detail = wheelDetail(node.width * zoom);
  const layout = wheelLayout(node.width, node.height);
  const px = (rect: Rect) => ({
    left: rect.x * zoom,
    top: rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  });
  const wheelPx = Math.max(40, layout.wheel.width * zoom);
  const handleRadius = Math.max(5, wheelPx * 0.04);

  // ------------------------------------------------------------- the wheel
  const wheelHost = useRef<HTMLDivElement>(null);
  const picker = useRef<iro.ColorPicker | null>(null);
  const glideFrame = useRef(0);
  const [wheelDragging, setWheelDragging] = useState(false);
  // Before the first paint: the canvas picture is already hidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; sized and fed below
  useLayoutEffect(() => {
    const host = wheelHost.current;
    if (!host) return;
    const instance = iro.ColorPicker(host, {
      width: wheelPx,
      colors: points.map(toIro),
      layout: [{ component: iro.ui.Wheel }],
      handleRadius,
      activeHandleRadius: handleRadius * 1.25,
      borderWidth: 0,
      padding: 0,
    });
    instance.setActiveColor(BASE_INDEX);
    const onStart = () => {
      cancelAnimationFrame(glideFrame.current);
      setWheelDragging(true);
    };
    const onInput = (color: iro.Color) => {
      gestureStart.current ??= latest.current.points;
      const next = moveSet(gestureStart.current, color.index, fromIro(color.hsv as IroHsv));
      next.forEach((hsv, index) => {
        if (index === color.index) return;
        const handle = instance.colors[index];
        if (handle) handle.hsv = toIro(hsv);
      });
      setLive(next);
    };
    const onEnd = () => {
      setWheelDragging(false);
      const moved = gestureStart.current !== null;
      gestureStart.current = null;
      if (moved) save('Color');
    };
    instance.on('input:start', onStart);
    instance.on('input:change', onInput);
    instance.on('input:end', onEnd);
    picker.current = instance;
    return () => {
      cancelAnimationFrame(glideFrame.current);
      instance.off('input:start', onStart);
      instance.off('input:change', onInput);
      instance.off('input:end', onEnd);
      host.replaceChildren();
      picker.current = null;
    };
  }, []);

  // Follow zoom, and outside changes (undo, the menu, a sampled swatch).
  useEffect(() => {
    picker.current?.resize(wheelPx);
    picker.current?.setOptions({ handleRadius, activeHandleRadius: handleRadius * 1.25 });
  }, [wheelPx, handleRadius]);
  const pointsKey = points.map(({ h, s, v }) => `${h},${s},${v}`).join(';');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the points' value
  useEffect(() => {
    const instance = picker.current;
    if (!instance || live) return;
    glide(instance, points);
  }, [pointsKey]);

  /** Ease every handle to `target` (hue the short way round). */
  const glide = (instance: iro.ColorPicker, target: Hsv[]) => {
    cancelAnimationFrame(glideFrame.current);
    const from = instance.colors.map((color) => fromIro(color.hsv as IroHsv));
    const to = target;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    const same =
      from.length === to.length &&
      from.every((a, index) => {
        const b = to[index];
        return !!b && near(a.h, b.h) && near(a.s, b.s) && near(a.v, b.v);
      });
    if (same) return;
    if (from.length !== to.length || reducedMotion()) {
      instance.setColors(target.map(toIro), BASE_INDEX);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      const eased = 1 - (1 - t) ** 3;
      if (t >= 1) {
        instance.setColors(target.map(toIro), BASE_INDEX);
        return;
      }
      from.forEach((a, index) => {
        const b = to[index];
        const color = instance.colors[index];
        if (!b || !color) return;
        // A grey has no hue of its own: take the target's.
        const turn = a.s < 0.01 ? 0 : ((b.h - a.h + 540) % 360) - 180;
        const h = a.s < 0.01 ? b.h : (a.h + turn * eased + 360) % 360;
        color.hsv = toIro({ h, s: a.s + (b.s - a.s) * eased, v: a.v + (b.v - a.v) * eased });
      });
      glideFrame.current = requestAnimationFrame(step);
    };
    glideFrame.current = requestAnimationFrame(step);
  };

  /** Commit the live state; a palette the wheel produced joins the library. */
  const save = (label: string, extra: Partial<WheelState> = {}) => {
    const { stored: current, points: set, onCommit: commit } = latest.current;
    const hexes = set.map(hsvToHex);
    const newest = current.library[0];
    const library =
      newest && newest.join() === hexes.join() ? current.library : [hexes, ...current.library];
    commit(
      {
        base: hexes[BASE_INDEX] ?? current.base,
        colors: hexes,
        points: set,
        library,
        ...extra,
      },
      label,
    );
    setLive(null);
  };

  // ------------------------------------------------------- the fine-tune grip
  // Hovering a handle shows a grip behind it (an arrow to a line, pointing
  // at the rest of the set); dragging the grip that way draws every other
  // colour toward this one, back the other way spreads them out again.
  const [hovered, setHovered] = useState<number | null>(null);
  const [gripping, setGripping] = useState<number | null>(null);
  const hideGrip = useRef(0);
  const reach = wheelPx / 2 - handleRadius;
  /** A point's centre on the disc, px from its top-left. */
  const onDisc = (point: Hsv) => {
    const { x, y } = wheelXY(point);
    return { x: wheelPx / 2 + x * reach, y: wheelPx / 2 + y * reach };
  };
  /** Which way the grip at `index` points: toward the others' middle (out
   *  from the disc's centre when they sit on top of it). */
  const gripDirection = (index: number) => {
    const at = onDisc(points[index] ?? base);
    const others = points.filter((_, other) => other !== index).map(onDisc);
    const middle = {
      x: others.reduce((sum, point) => sum + point.x, 0) / Math.max(1, others.length),
      y: others.reduce((sum, point) => sum + point.y, 0) / Math.max(1, others.length),
    };
    let dx = middle.x - at.x;
    let dy = middle.y - at.y;
    let length = Math.hypot(dx, dy);
    if (length < 2) {
      dx = at.x - wheelPx / 2;
      dy = at.y - wheelPx / 2;
      length = Math.hypot(dx, dy);
      if (length < 1) return { x: 1, y: 0, distance: 0 };
    }
    return {
      x: dx / length,
      y: dy / length,
      distance: Math.hypot(middle.x - at.x, middle.y - at.y),
    };
  };
  const hover = (clientX: number, clientY: number) => {
    const rect = wheelHost.current?.getBoundingClientRect();
    if (!rect || wheelDragging || gripping !== null) return;
    const local = { x: clientX - rect.left, y: clientY - rect.top };
    let nearest: number | null = null;
    let best = handleRadius * 1.7;
    points.forEach((point, index) => {
      const at = onDisc(point);
      const distance = Math.hypot(at.x - local.x, at.y - local.y);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    window.clearTimeout(hideGrip.current);
    if (nearest !== null) setHovered(nearest);
    else hideGrip.current = window.setTimeout(() => setHovered(null), 700);
  };
  const pressGrip = (event: React.PointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const direction = gripDirection(index);
    const start = latest.current.points;
    const from = { x: event.clientX, y: event.clientY };
    // One grip-length of travel per this much of the gap to the others.
    const span = Math.max(24, direction.distance);
    gestureStart.current = start;
    cancelAnimationFrame(glideFrame.current);
    setGripping(index);
    const move = (moveEvent: PointerEvent) => {
      const along =
        (moveEvent.clientX - from.x) * direction.x + (moveEvent.clientY - from.y) * direction.y;
      const factor = Math.min(3, Math.max(0.02, (span - along) / span));
      const next = compressToward(start, index, factor);
      picker.current?.setColors(next.map(toIro), BASE_INDEX);
      setLive(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      gestureStart.current = null;
      setGripping(null);
      if (latest.current.points !== start) save('Fine Tune');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const gripIndex = gripping ?? hovered;
  const showGrip =
    gripIndex !== null && !wheelDragging && !leaving && detail === 'full' && !!points[gripIndex];

  // ------------------------------------------------------------ the slider
  const [sliding, setSliding] = useState(false);
  const level = stored.mode === 'hsl' ? hsvToHsl(base).l : base.v;
  const setLevel = (clientY: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const value = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
    const { stored: current, points: now } = latest.current;
    // The rest follow the base proportionally, from where the drag began.
    const next = shiftBrightness(gestureStart.current ?? now, BASE_INDEX, value, current.mode);
    cancelAnimationFrame(glideFrame.current);
    picker.current?.setColors(next.map(toIro), BASE_INDEX);
    setLive(next);
  };
  const pure = hsvToHex({ h: base.h, s: stored.mode === 'hsl' ? 1 : base.s, v: 1 });
  const track =
    stored.mode === 'hsl'
      ? `linear-gradient(to bottom, #fff, ${pure}, #000)`
      : `linear-gradient(to bottom, ${pure}, #000)`;

  // ------------------------------------------------------- drag palettes out
  const [ghost, setGhost] = useState<{ colors: string[]; x: number; y: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** Press on a palette strip: a click does `onClick`, a drag carries the
   *  colours out and drops them on the board. */
  const dragOrClick = (event: React.PointerEvent, drag: string[], onClick: () => void) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    const move = (moveEvent: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_OUT_PX
      )
        return;
      dragging = true;
      setGhost({ colors: drag, x: moveEvent.clientX, y: moveEvent.clientY });
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      if (!dragging) {
        onClick();
        return;
      }
      const rect = panel.current?.getBoundingClientRect();
      const inside =
        rect &&
        upEvent.clientX >= rect.left &&
        upEvent.clientX <= rect.right &&
        upEvent.clientY >= rect.top &&
        upEvent.clientY <= rect.bottom;
      if (!inside) onDragOut(drag, upEvent.clientX, upEvent.clientY);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The harmony picker: our menu (the right-click menu's look), not a
  // native select, whose list the system draws.
  const harmonyButton = useRef<HTMLButtonElement>(null);
  const [harmonyOpen, setHarmonyOpen] = useState(false);

  // Saved palettes keep their keys (oldest = 1), so only a new one animates in.
  const libraryAtMount = useRef(stored.library.length);

  const controlsPx = layout.controls.height * zoom;
  const libraryPad = controlsPx * 0.42 * 0.8;
  const style = {
    left: viewport.x + node.x * zoom,
    top: viewport.y + node.y * zoom,
    width: node.width * zoom,
    height: node.height * zoom,
    borderRadius: node.width * zoom * PANEL_RADIUS,
    fontSize: controlsPx * 0.42,
    '--field-radius': `${controlsPx * FIELD_RADIUS}px`,
    '--strip-radius': `${layout.swatches.height * zoom * STRIP_RADIUS}px`,
    '--row-radius': `${layout.rowHeight * zoom * ROW_RADIUS}px`,
    // Handles shrink to dots by scaling their coloured circle (radius R − 2).
    '--dot-scale': WHEEL_DOT_PX / Math.max(1, handleRadius - 2),
    '--dot-scale-active': (WHEEL_DOT_PX * 1.3) / Math.max(1, handleRadius * 1.25 - 2),
  } as CSSProperties;
  return (
    <div
      ref={panel}
      className={`color-wheel-panel${leaving ? ' leaving' : ''}`}
      data-testid="color-wheel-panel"
      data-detail={detail}
      style={style}
    >
      <div
        className={`color-wheel-slider${sliding ? ' sliding' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label={stored.mode === 'hsl' ? 'Lightness' : 'Brightness'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        style={{ ...px(layout.slider), background: track }}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          setSliding(true);
          gestureStart.current = latest.current.points;
          setLevel(event.clientY, event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            setLevel(event.clientY, event.currentTarget);
          }
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          setSliding(false);
          gestureStart.current = null;
          save('Color');
        }}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowUp' ? 0.05 : event.key === 'ArrowDown' ? -0.05 : 0;
          if (!step) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setLevel(
            rect.top + (1 - Math.min(1, Math.max(0, level + step))) * rect.height,
            event.currentTarget,
          );
          queueMicrotask(() => save('Color'));
        }}
      >
        <span
          className="color-wheel-thumb"
          style={{ top: `${(1 - level) * 100}%`, background: hsvToHex(base) }}
        />
      </div>
      <div
        ref={wheelHost}
        className="color-wheel-iro"
        style={px(layout.wheel)}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => hover(event.clientX, event.clientY)}
        onPointerLeave={() => {
          window.clearTimeout(hideGrip.current);
          hideGrip.current = window.setTimeout(() => setHovered(null), 700);
        }}
      />
      <div className="color-wheel-grips" style={px(layout.wheel)}>
        {showGrip &&
          gripIndex !== null &&
          (() => {
            const point = points[gripIndex] ?? base;
            const at = onDisc(point);
            const direction = gripDirection(gripIndex);
            // Behind the handle (away from the others), clear of the set.
            const offset = handleRadius * (gripIndex === BASE_INDEX ? 1.25 : 1) + 15;
            return (
              <button
                key={gripIndex}
                type="button"
                className={`color-wheel-grip${gripping !== null ? ' active' : ''}`}
                aria-label="Fine-tune: drag to draw the other colours toward this one"
                title="Drag to draw the other colours toward this one"
                tabIndex={-1}
                style={{
                  left: at.x - direction.x * offset,
                  top: at.y - direction.y * offset,
                  transform: `translate(-50%, -50%) rotate(${Math.atan2(direction.y, direction.x)}rad)`,
                }}
                onPointerEnter={() => window.clearTimeout(hideGrip.current)}
                onPointerLeave={() => {
                  hideGrip.current = window.setTimeout(() => setHovered(null), 700);
                }}
                onPointerDown={(event) => pressGrip(event, gripIndex)}
              >
                <Icon name="compress" size={12} />
              </button>
            );
          })()}
      </div>
      <div className="color-wheel-harmony color-wheel-extra" style={px(layout.harmony)}>
        <button
          ref={harmonyButton}
          type="button"
          className={harmonyOpen ? 'open' : undefined}
          aria-label={`Harmony: ${HARMONY_LABELS[stored.harmony]}`}
          aria-haspopup="menu"
          aria-expanded={harmonyOpen}
          tabIndex={detail === 'full' ? 0 : -1}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setHarmonyOpen((open) => !open)}
        >
          {HARMONY_LABELS[stored.harmony]}
        </button>
        <span className="color-wheel-chevron" style={{ width: controlsPx }}>
          <Icon name="chevronDown" size={controlsPx * 0.5} />
        </span>
      </div>
      {harmonyOpen && !leaving && detail === 'full' && (
        <HarmonyMenu
          anchor={harmonyButton}
          value={stored.harmony}
          onPick={(harmony) => {
            // Choosing a harmony (again) lays the set out by it afresh.
            const set = harmonize(base, harmony);
            onCommit(
              { harmony, base: hsvToHex(base), colors: set.map(hsvToHex), points: set },
              'Harmony',
            );
          }}
          onClose={() => setHarmonyOpen(false)}
        />
      )}
      <fieldset
        className="color-wheel-mode color-wheel-extra"
        aria-label="Brightness mode"
        data-mode={stored.mode}
        style={px(layout.mode)}
      >
        <span className="color-wheel-mode-thumb" />
        {(['hsv', 'hsl'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={stored.mode === mode}
            tabIndex={detail === 'full' ? 0 : -1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              if (stored.mode !== mode) onCommit({ mode }, 'Brightness Mode');
            }}
          >
            {mode.toUpperCase()}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        className="color-wheel-random color-wheel-extra"
        aria-label="Random palette"
        title="Random palette"
        tabIndex={detail === 'full' ? 0 : -1}
        style={px(layout.random)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const icon = event.currentTarget.querySelector('svg');
          if (icon) {
            play(
              icon,
              [
                { transform: 'rotate(0) scale(1)' },
                { transform: 'rotate(200deg) scale(0.85)' },
                { transform: 'rotate(360deg) scale(1)' },
              ],
              420,
            );
          }
          const random = randomPalette();
          latest.current.points = random.points;
          save('Random Palette', { harmony: random.harmony });
        }}
      >
        <Icon name="dice" size={controlsPx * 0.58} />
      </button>
      <div
        className="color-wheel-swatches"
        style={px(layout.swatches)}
        onPointerDown={(event) => dragOrClick(event, colors, () => undefined)}
      >
        {colors.map((hex, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: five fixed slots
            key={index}
            type="button"
            aria-label={`Copy ${hex}`}
            style={{ background: hex }}
            onClick={(event) => {
              event.stopPropagation();
              play(
                event.currentTarget,
                [
                  { transform: 'scale(1)', boxShadow: '0 0 0 0 rgb(255 255 255 / 70%)' },
                  { transform: 'scale(1.1)', boxShadow: '0 0 0 4px rgb(255 255 255 / 0%)' },
                  { transform: 'scale(1)', boxShadow: '0 0 0 0 rgb(255 255 255 / 0%)' },
                ],
                360,
              );
              onCopy(hex);
            }}
          />
        ))}
      </div>
      <div className="color-wheel-title color-wheel-extra" style={px(layout.libraryTitle)}>
        {stored.library.length > 0 ? `Palettes · ${stored.library.length}` : 'Palettes'}
      </div>
      <div
        className="color-wheel-library"
        data-wheel-scroll
        // Padded out past its rect so the rows' shadows aren't clipped.
        style={{
          left: layout.library.x * zoom - libraryPad,
          top: layout.library.y * zoom - libraryPad,
          width: layout.library.width * zoom + libraryPad * 2,
          height: layout.library.height * zoom + libraryPad * 2,
          padding: libraryPad,
          gap: layout.rowGap * zoom,
        }}
      >
        {stored.library.map((row, index) => {
          const key = stored.library.length - index;
          return (
            <button
              key={key}
              type="button"
              className={`color-wheel-row${key > libraryAtMount.current ? ' entering' : ''}`}
              aria-label={`Palette ${row.join(' ')}`}
              style={{ height: layout.rowHeight * zoom, background: stripes(row) }}
              onPointerDown={(event) =>
                dragOrClick(event, row, () => {
                  // Load it: the wheel picks up this palette.
                  // Five colours load as they are; any other count lends
                  // its middle colour as the base of the current harmony.
                  const set =
                    row.length === 5
                      ? row.map(hexToHsv)
                      : harmonize(
                          hexToHsv(row[Math.floor(row.length / 2)] ?? stored.base),
                          stored.harmony,
                        );
                  const hexes = set.map(hsvToHex);
                  onCommit(
                    { colors: hexes, points: set, base: hexes[BASE_INDEX] ?? stored.base },
                    'Load Palette',
                  );
                })
              }
            />
          );
        })}
      </div>
      {ghost &&
        createPortal(
          <div
            className="palette-ghost"
            style={{
              left: ghost.x,
              top: ghost.y,
              background: stripes(ghost.colors),
              width: Math.min(220, 36 * ghost.colors.length),
            }}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * The harmony list, in the right-click menu's style (glass, 30px rows, the
 * chosen one checked): under its field (above it when there's no room),
 * fixed to the window so the panel never clips it, following the field
 * while the board moves. Arrow keys walk it, Enter picks, Escape or a
 * press outside closes it and focus returns to the field.
 */
function HarmonyMenu({
  anchor,
  value,
  onPick,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  value: Harmony;
  onPick: (harmony: Harmony) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);

  // Follow the field every render (the panel re-renders with the camera).
  useLayoutEffect(() => {
    const from = anchor.current?.getBoundingClientRect();
    const own = menu.current?.getBoundingClientRect();
    if (!from || !own) return;
    const margin = 8;
    const below = from.bottom + 4;
    const top =
      below + own.height > window.innerHeight - margin && from.top - own.height - 4 > margin
        ? from.top - own.height - 4
        : Math.min(below, window.innerHeight - own.height - margin);
    const left = Math.max(margin, Math.min(from.left, window.innerWidth - own.width - margin));
    const width = Math.max(160, from.width);
    if (place && place.left === left && place.top === top && place.width === width) return;
    setPlace({ left, top, width });
  });

  // Once placed: pop in (as every menu does) and focus the chosen row.
  const shown = useRef(false);
  useEffect(() => {
    if (!place || shown.current) return;
    shown.current = true;
    enter(menu.current, 'pop');
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [place]);

  // A press anywhere else closes it (the field toggles it itself).
  useEffect(() => {
    const press = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, [anchor, onClose]);

  const close = () => {
    onClose();
    anchor.current?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step) {
      rows[(at + step + rows.length) % rows.length]?.focus();
    } else if (event.key === 'Home') {
      rows[0]?.focus();
    } else if (event.key === 'End') {
      rows.at(-1)?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      close();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={menu}
      className="board-context-menu harmony-menu"
      role="menu"
      aria-label="Harmony"
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        minWidth: place?.width,
        visibility: place ? 'visible' : 'hidden',
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {HARMONIES.map((harmony) => (
        <button
          key={harmony}
          type="button"
          role="menuitemradio"
          aria-checked={harmony === value}
          onClick={() => {
            onPick(harmony);
            close();
          }}
        >
          <span>{HARMONY_LABELS[harmony]}</span>
          <span className="menu-check">{harmony === value && <Icon name="check" size={15} />}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
