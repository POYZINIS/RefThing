/**
 * A 3D model item's view settings (item metadata `model`, merge-patched) and
 * the pure orbit math. The model itself is never edited — only how it is
 * looked at: the orbit camera, the shading mode and the sky background.
 */

/** `original` = the model's own normals; `smooth` = welded averaged normals
 *  (Blender's Shade Smooth); `flat` = one normal per face. */
export type ModelShading = 'original' | 'smooth' | 'flat';

export type ModelProjection = 'perspective' | 'orthographic';

/** Image maps a model can be given (each a blob hash). `mro` is one packed
 *  texture: metalness in R, roughness in G, ambient occlusion in B. */
export type TextureChannel = 'color' | 'metalness' | 'roughness' | 'normal' | 'ao' | 'mro';
export const TEXTURE_CHANNELS: readonly TextureChannel[] = [
  'color',
  'metalness',
  'roughness',
  'normal',
  'ao',
  'mro',
];
export type ModelTextures = Partial<Record<TextureChannel, string>>;

export type ModelSettings = {
  shading: ModelShading;
  projection: ModelProjection;
  /** The orthographic view came from clicking a gizmo axis: orbiting away
   *  returns to perspective (Blender's auto perspective). An ortho chosen
   *  in the menu stays. */
  axisView: boolean;
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
  /** Maps given in the menu (blob hashes), applied over the model's UVs. */
  textures: ModelTextures;
  /** The roughness map is really smoothness: use 1 - value. */
  roughnessInvert: boolean;
  /** Metalness / roughness / AO come from one packed MRO texture. */
  packedMro: boolean;
  /** Towards the sun, model space (unit; Y up). */
  sunX: number;
  sunY: number;
  sunZ: number;
};

/** The default sun: high, front-right (like a studio key light). */
const DEFAULT_SUN = normalize({ x: 0.45, y: 0.8, z: 0.4 });

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  shading: 'original',
  projection: 'perspective',
  axisView: false,
  background: true,
  // A three-quarter view from slightly above, the horizon in frame.
  yaw: Math.PI / 5,
  pitch: Math.PI / 16,
  distance: 1,
  panX: 0,
  panY: 0,
  panZ: 0,
  sunX: DEFAULT_SUN.x,
  sunY: DEFAULT_SUN.y,
  sunZ: DEFAULT_SUN.z,
  textures: {},
  roughnessInvert: false,
  packedMro: false,
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
  const storedSun = { x: finite(raw.sunX, 0), y: finite(raw.sunY, 0), z: finite(raw.sunZ, 0) };
  const sun =
    Math.hypot(storedSun.x, storedSun.y, storedSun.z) > 1e-6 ? normalize(storedSun) : DEFAULT_SUN;
  return {
    shading:
      raw.shading === 'smooth' || raw.shading === 'flat' || raw.shading === 'original'
        ? raw.shading
        : d.shading,
    projection:
      raw.projection === 'orthographic' || raw.projection === 'perspective'
        ? raw.projection
        : d.projection,
    axisView: raw.axisView === true && raw.projection === 'orthographic',
    background: typeof raw.background === 'boolean' ? raw.background : d.background,
    yaw: finite(raw.yaw, d.yaw),
    pitch: clamp(finite(raw.pitch, d.pitch), -PITCH_LIMIT, PITCH_LIMIT),
    distance: clamp(finite(raw.distance, d.distance), MIN_DISTANCE, MAX_DISTANCE),
    panX: finite(raw.panX, d.panX),
    panY: finite(raw.panY, d.panY),
    panZ: finite(raw.panZ, d.panZ),
    sunX: sun.x,
    sunY: sun.y,
    sunZ: sun.z,
    textures: parseTextures(raw.textures),
    roughnessInvert: raw.roughnessInvert === true,
    packedMro: raw.packedMro === true,
  };
}

const BLOB_HASH = /^[0-9a-f]{64}$/;

function parseTextures(value: unknown): ModelTextures {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const textures: ModelTextures = {};
  for (const channel of TEXTURE_CHANNELS) {
    const hash = raw[channel];
    if (typeof hash === 'string' && BLOB_HASH.test(hash)) textures[channel] = hash;
  }
  return textures;
}

/** The maps a render actually uses: the packed MRO replaces the separate
 *  metalness / roughness / AO maps when on (and only then counts). */
export function activeTextures(settings: ModelSettings): ModelTextures {
  const { color, normal, metalness, roughness, ao, mro } = settings.textures;
  const packed = settings.packedMro ? { mro } : { metalness, roughness, ao };
  const all: ModelTextures = { color, normal, ...packed };
  return Object.fromEntries(
    Object.entries(all).filter(([, hash]) => hash !== undefined),
  ) as ModelTextures;
}

/** Is the camera where a new model's is (sun and shading aside)? */
export function isDefaultView(settings: ModelSettings): boolean {
  return (
    settingsKey({ ...DEFAULT_MODEL_SETTINGS, ...viewOf(settings) }) ===
    settingsKey(DEFAULT_MODEL_SETTINGS)
  );
}

export type ModelSun = Pick<ModelSettings, 'sunX' | 'sunY' | 'sunZ'>;

export const sunOf = (settings: ModelSettings): ModelSun => ({
  sunX: settings.sunX,
  sunY: settings.sunY,
  sunZ: settings.sunZ,
});

export const DEFAULT_MODEL_SUN: ModelSun = sunOf(DEFAULT_MODEL_SETTINGS);

/** Radians the sun turns per px dragged on the trackball. */
export const SUN_RADIANS_PER_PX = Math.PI / 90;

/**
 * Trackball: turn the sun around the model by a drag of (dx, dy) px on the
 * gizmo, relative to the camera — right swings it right (about the view's
 * up axis), down swings it down (about the view's right axis).
 */
export function rotateSun(
  sun: ModelSun,
  view: Pick<ModelView, 'yaw' | 'pitch'>,
  dx: number,
  dy: number,
): ModelSun {
  const { right, up } = cameraBasis(view);
  let vector = { x: sun.sunX, y: sun.sunY, z: sun.sunZ };
  vector = rotateAbout(vector, up, dx * SUN_RADIANS_PER_PX);
  vector = rotateAbout(vector, right, dy * SUN_RADIANS_PER_PX);
  const unit = normalize(vector);
  return { sunX: unit.x, sunY: unit.y, sunZ: unit.z };
}

type Vec = { x: number; y: number; z: number };

/** Rodrigues: `v` turned by `angle` about the unit `axis`. */
function rotateAbout(v: Vec, axis: Vec, angle: number): Vec {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z;
  const cross = {
    x: axis.y * v.z - axis.z * v.y,
    y: axis.z * v.x - axis.x * v.z,
    z: axis.x * v.y - axis.y * v.x,
  };
  return {
    x: v.x * cos + cross.x * sin + axis.x * dot * (1 - cos),
    y: v.y * cos + cross.y * sin + axis.y * dot * (1 - cos),
    z: v.z * cos + cross.z * sin + axis.z * dot * (1 - cos),
  };
}

function normalize(v: Vec): Vec {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * Where a model-space direction lands on a view-aligned gizmo: screen x/y
 * (unit radius, y down) and depth (positive = towards the viewer).
 */
export function projectDirection(
  direction: Vec,
  view: Pick<ModelView, 'yaw' | 'pitch'>,
): { x: number; y: number; depth: number } {
  const { forward, right, up } = cameraBasis(view);
  const along = (axis: Vec) => direction.x * axis.x + direction.y * axis.y + direction.z * axis.z;
  return { x: along(right), y: -along(up), depth: along(forward) };
}

/** The camera part only (what an orbit gesture changes). */
export type ModelView = Pick<
  ModelSettings,
  'yaw' | 'pitch' | 'distance' | 'panX' | 'panY' | 'panZ' | 'projection' | 'axisView'
>;

export const viewOf = (settings: ModelSettings): ModelView => ({
  yaw: settings.yaw,
  pitch: settings.pitch,
  distance: settings.distance,
  panX: settings.panX,
  panY: settings.panY,
  panZ: settings.panZ,
  projection: settings.projection,
  axisView: settings.axisView,
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
    // Turning away from an axis view goes back to perspective.
    ...(view.axisView ? { projection: 'perspective' as const, axisView: false } : {}),
  };
}

/** The orbit angles that look straight down `direction` (the camera sits
 *  on that side of the model). Straight up/down keep X to the right. */
export function anglesFacing(direction: { x: number; y: number; z: number }): {
  yaw: number;
  pitch: number;
} {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const y = direction.y / length;
  const vertical = Math.abs(y) > 0.9999;
  return {
    yaw: vertical ? 0 : Math.atan2(direction.x, direction.z),
    pitch: clamp(Math.asin(clamp(y, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT),
  };
}

/** Is the camera already looking straight down `direction`? */
export function isFacing(
  view: Pick<ModelView, 'yaw' | 'pitch'>,
  direction: { x: number; y: number; z: number },
): boolean {
  const { forward } = cameraBasis(view);
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const along = forward.x * direction.x + forward.y * direction.y + forward.z * direction.z;
  return along / length > 0.9999;
}

/** Part way (`t` 0…1) from one camera angle to another, the short way
 *  round in yaw. */
export function lerpAngles(
  from: Pick<ModelView, 'yaw' | 'pitch'>,
  to: Pick<ModelView, 'yaw' | 'pitch'>,
  t: number,
): { yaw: number; pitch: number } {
  const turn = wrapAngle(to.yaw - from.yaw);
  return { yaw: wrapAngle(from.yaw + turn * t), pitch: from.pitch + (to.pitch - from.pitch) * t };
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
    settings.projection,
    settings.background ? 1 : 0,
    r(settings.yaw),
    r(settings.pitch),
    r(settings.distance),
    r(settings.panX),
    r(settings.panY),
    r(settings.panZ),
    r(settings.sunX),
    r(settings.sunY),
    r(settings.sunZ),
    Object.entries(activeTextures(settings))
      .map(([channel, hash]) => `${channel}:${hash.slice(0, 12)}`)
      .sort()
      .join('+'),
    settings.roughnessInvert ? 'inv' : '',
  ].join(',');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapAngle(angle: number): number {
  const turn = Math.PI * 2;
  return ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
}
