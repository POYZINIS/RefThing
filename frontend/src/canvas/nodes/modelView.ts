/**
 * A 3D model item's view settings (item metadata `model`, merge-patched) and
 * the pure orbit math. The model itself is never edited — only how it is
 * looked at: the orbit camera, the shading mode and the sky background.
 */

/** `original` = the model's own normals; `smooth` = welded averaged normals
 *  (Blender's Shade Smooth); `flat` = one normal per face. */
export type ModelShading = 'original' | 'smooth' | 'flat';

export type ModelSettings = {
  shading: ModelShading;
  /** The sky behind the model. Off = transparent: the object alone, still
   *  lit by the same sky (like Blender's transparent film). */
  background: boolean;
  /** Orbit angles, radians: yaw about world up, pitch above the horizon. */
  yaw: number;
  pitch: number;
  /** Camera distance as a multiple of the framing distance (1 = fits). */
  distance: number;
  /** Look-at offset from the model's centre, in model radii (pan). */
  panX: number;
  panY: number;
  panZ: number;
};

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  shading: 'original',
  background: true,
  // A three-quarter view from slightly above, the horizon in frame.
  yaw: Math.PI / 5,
  pitch: Math.PI / 16,
  distance: 1,
  panX: 0,
  panY: 0,
  panZ: 0,
};

/** The model camera's vertical field of view (radians). */
export const MODEL_FOV_Y = (35 * Math.PI) / 180;

export const MIN_DISTANCE = 0.05;
export const MAX_DISTANCE = 20;
const PITCH_LIMIT = Math.PI / 2 - 0.001;

const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Stored settings, validated; anything missing or malformed is a default. */
export function modelSettings(value: unknown): ModelSettings {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_MODEL_SETTINGS;
  return {
    shading:
      raw.shading === 'smooth' || raw.shading === 'flat' || raw.shading === 'original'
        ? raw.shading
        : d.shading,
    background: typeof raw.background === 'boolean' ? raw.background : d.background,
    yaw: finite(raw.yaw, d.yaw),
    pitch: clamp(finite(raw.pitch, d.pitch), -PITCH_LIMIT, PITCH_LIMIT),
    distance: clamp(finite(raw.distance, d.distance), MIN_DISTANCE, MAX_DISTANCE),
    panX: finite(raw.panX, d.panX),
    panY: finite(raw.panY, d.panY),
    panZ: finite(raw.panZ, d.panZ),
  };
}

/** The camera part only (what an orbit gesture changes). */
export type ModelView = Pick<
  ModelSettings,
  'yaw' | 'pitch' | 'distance' | 'panX' | 'panY' | 'panZ'
>;

export const viewOf = (settings: ModelSettings): ModelView => ({
  yaw: settings.yaw,
  pitch: settings.pitch,
  distance: settings.distance,
  panX: settings.panX,
  panY: settings.panY,
  panZ: settings.panZ,
});

/** Radians of orbit per screen px dragged across the viewport's height. */
export const ORBIT_RADIANS_PER_VIEWPORT = Math.PI;

/** Orbit by a pointer drag of (dx, dy) screen px over a viewport `height`
 *  px tall: right turns the model to the right, down tilts it towards you. */
export function orbit(view: ModelView, dx: number, dy: number, height: number): ModelView {
  const perPx = ORBIT_RADIANS_PER_VIEWPORT / Math.max(1, height);
  return {
    ...view,
    yaw: wrapAngle(view.yaw - dx * perPx),
    pitch: clamp(view.pitch + dy * perPx, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

/** Dolly by a wheel delta (positive = away), exponentially. */
export function dolly(view: ModelView, deltaY: number): ModelView {
  return {
    ...view,
    distance: clamp(view.distance * Math.exp(deltaY * 0.0015), MIN_DISTANCE, MAX_DISTANCE),
  };
}

/** The camera's basis for a view: where it sits (unit direction from the
 *  target) and its right/up axes, in model space (Y up). */
export function cameraBasis(view: Pick<ModelView, 'yaw' | 'pitch'>) {
  const cosPitch = Math.cos(view.pitch);
  const forward = {
    x: Math.sin(view.yaw) * cosPitch,
    y: Math.sin(view.pitch),
    z: Math.cos(view.yaw) * cosPitch,
  };
  const right = { x: Math.cos(view.yaw), y: 0, z: -Math.sin(view.yaw) };
  // up = forward × right
  const up = {
    x: forward.y * right.z - forward.z * right.y,
    y: forward.z * right.x - forward.x * right.z,
    z: forward.x * right.y - forward.y * right.x,
  };
  return { forward, right, up };
}

/** Pan by a pointer drag, moving the look-at point in the view plane so the
 *  model follows the pointer (viewport `width` x `height` px, `fovY` in
 *  radians). */
export function pan(
  view: ModelView,
  dx: number,
  dy: number,
  width: number,
  height: number,
  fovY: number,
): ModelView {
  const { right, up } = cameraBasis(view);
  // Model radii per px at the target's depth.
  const aspect = Math.max(1, width) / Math.max(1, height);
  const depth = framingDistance(1, fovY, aspect) * view.distance;
  const visibleHeight = 2 * depth * Math.tan(fovY / 2);
  const perPx = visibleHeight / Math.max(1, height);
  const sx = -dx * perPx;
  const sy = dy * perPx;
  return {
    ...view,
    panX: view.panX + right.x * sx + up.x * sy,
    panY: view.panY + right.y * sx + up.y * sy,
    panZ: view.panZ + right.z * sx + up.z * sy,
  };
}

/** Camera distance that fits a sphere of `radius` in a view of `aspect`
 *  (width / height) with vertical field of view `fovY`. */
export function framingDistance(radius: number, fovY: number, aspect: number): number {
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
  const narrowest = Math.min(fovY, fovX);
  return radius / Math.sin(narrowest / 2);
}

/** Render px per world px, bucketed to powers of two (like note textures) so
 *  zooming re-renders a model only when it crosses a bucket. */
export function modelTextureScale(zoom: number, devicePixelRatio: number): number {
  const exact = Math.max(zoom * devicePixelRatio, 1 / 256);
  return 2 ** Math.max(-8, Math.min(2, Math.ceil(Math.log2(exact))));
}

/** Stable key for everything that changes a render of the model. */
export function settingsKey(settings: ModelSettings): string {
  const r = (value: number) => Math.round(value * 1e4) / 1e4;
  return [
    settings.shading,
    settings.background ? 1 : 0,
    r(settings.yaw),
    r(settings.pitch),
    r(settings.distance),
    r(settings.panX),
    r(settings.panY),
    r(settings.panZ),
  ].join(',');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapAngle(angle: number): number {
  const turn = Math.PI * 2;
  return ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
}
