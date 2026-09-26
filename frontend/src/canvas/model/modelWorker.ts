/**
 * The model worker: owns ONE WebGL context (an OffscreenCanvas) and renders
 * 3D model items into bitmaps the board draws as ordinary sprites. Parsing,
 * baking and rendering all happen here, off the main thread.
 *
 * Shading is deliberately cheap: a diffuse (Lambert) term under a sun plus a
 * sky/ground hemisphere, the base-colour texture and vertex colour, back
 * faces culled. The sky background is its own pass drawn AFTER the model,
 * only where the depth buffer is still empty — switching it off leaves those
 * pixels transparent and changes nothing about how the model is lit
 * (Blender's transparent film).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  FrontSide,
  GLSL3,
  LessEqualDepth,
  Mesh,
  PerspectiveCamera,
  RawShaderMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { cameraBasis, framingDistance, MODEL_FOV_Y, settingsKey } from '../nodes/modelView';
import { type Bucket, computeSmoothNormals, loadModel, type ModelAsset } from './modelLoad';
import { readPoster, writePoster } from './posterCache';
import type { FromWorker, ToWorker } from './protocol';

type Scope = {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
};
const scope = self as unknown as Scope;

// ------------------------------------------------------------------ light

/** The default sky (sRGB), after Unity's: blue overhead, a pale horizon,
 *  warm grey ground. Model lighting comes from the same colours. */
const SKY = {
  zenith: new Color('#6f95c9'),
  horizon: new Color('#d3dbe4'),
  groundHorizon: new Color('#aba7a3'),
  ground: new Color('#85807b'),
};
const LIGHT = {
  sky: new Color('#b4c3d8').multiplyScalar(0.62),
  ground: new Color('#8a837b').multiplyScalar(0.5),
  sun: new Color('#fff3e2').multiplyScalar(0.95),
  /** Towards the sun, world space: high, front-right. */
  sunDirection: new Vector3(0.45, 0.8, 0.4).normalize(),
};

const SRGB_OUT = /* glsl */ `
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}`;

const MODEL_VERTEX = /* glsl */ `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform float uSmooth;
in vec3 position;
in vec3 normal;
in vec3 smoothNormal;
in vec3 color;
#ifdef USE_MAP
in vec2 uv;
out vec2 vUv;
#endif
out vec3 vNormal;
out vec3 vPosition;
out vec3 vColor;
void main() {
  vNormal = mix(normal, smoothNormal, uSmooth);
  vPosition = position;
  // Stored sRGB (a byte each); lighting happens in linear.
  vColor = pow(color, vec3(2.2));
#ifdef USE_MAP
  vUv = uv;
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const MODEL_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDirection;
uniform float uFlat;
#ifdef USE_MAP
uniform sampler2D map;
in vec2 vUv;
#endif
in vec3 vNormal;
in vec3 vPosition;
in vec3 vColor;
out vec4 fragColor;
${SRGB_OUT}
void main() {
  vec3 albedo = vColor;
#ifdef USE_MAP
  vec4 texel = texture(map, vUv);
  #ifdef USE_CUTOUT
  if (texel.a < 0.5) discard;
  #endif
  albedo *= texel.rgb;
#endif
  // Flat: the face's own normal from screen-space derivatives (no extra
  // geometry). Otherwise the interpolated vertex normal.
  vec3 faceNormal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
  vec3 n = uFlat > 0.5 ? faceNormal : normalize(vNormal);
  float hemisphere = n.y * 0.5 + 0.5;
  vec3 light = mix(uGround, uSky, hemisphere) + uSun * max(dot(n, uSunDirection), 0.0);
  fragColor = vec4(toSrgb(albedo * light), 1.0);
}`;

const SKY_VERTEX = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  // On the far plane: the depth test keeps it only where nothing was drawn.
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

const SKY_FRAGMENT = /* glsl */ `
precision highp float;
uniform mat4 uInverseProjection;
uniform mat4 uCameraWorld;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundHorizon;
uniform vec3 uGround;
in vec2 vNdc;
out vec4 fragColor;
${SRGB_OUT}
void main() {
  vec4 view = uInverseProjection * vec4(vNdc, 1.0, 1.0);
  vec3 direction = normalize((uCameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
  float y = direction.y;
  vec3 sky = mix(uHorizon, uZenith, pow(max(y, 0.0), 0.55));
  vec3 ground = mix(uGroundHorizon, uGround, pow(max(-y, 0.0), 0.4));
  fragColor = vec4(toSrgb(mix(ground, sky, smoothstep(-0.015, 0.015, y))), 1.0);
}`;

// --------------------------------------------------------------- renderer

const canvas = new OffscreenCanvas(1, 1);
const renderer = new WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  premultipliedAlpha: true,
  powerPreference: 'high-performance',
});
renderer.setClearColor(0x000000, 0);
const camera = new PerspectiveCamera((MODEL_FOV_Y * 180) / Math.PI, 1, 0.1, 100);

const skyMaterial = new RawShaderMaterial({
  glslVersion: GLSL3,
  vertexShader: SKY_VERTEX,
  fragmentShader: SKY_FRAGMENT,
  uniforms: {
    // Live references: the camera updates them before every render.
    uInverseProjection: { value: camera.projectionMatrixInverse },
    uCameraWorld: { value: camera.matrixWorld },
    uZenith: { value: SKY.zenith },
    uHorizon: { value: SKY.horizon },
    uGroundHorizon: { value: SKY.groundHorizon },
    uGround: { value: SKY.ground },
  },
  depthTest: true,
  depthWrite: false,
  depthFunc: LessEqualDepth,
});
const skyGeometry = new BufferGeometry();
// One triangle covering the whole viewport.
skyGeometry.setAttribute(
  'position',
  new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
);
const sky = new Mesh(skyGeometry, skyMaterial);
sky.frustumCulled = false;
sky.renderOrder = 1; // after the (opaque) model

// ------------------------------------------------------------------ models

type Loaded = {
  asset: ModelAsset;
  scene: Scene;
  meshes: Mesh<BufferGeometry, RawShaderMaterial>[];
  lastUsed: number;
};

const models = new Map<string, Promise<Loaded>>();
const ready = new Map<string, Loaded>();
const failures = new Map<string, string>();
/** Vertices kept resident across models before the least recently used go. */
const MAX_RESIDENT_VERTICES = 12_000_000;
let clock = 0;

function modelMaterial(bucket: Bucket): RawShaderMaterial {
  const defines: Record<string, string> = {};
  if (bucket.map) defines.USE_MAP = '';
  if (bucket.cutout) defines.USE_CUTOUT = '';
  return new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: MODEL_VERTEX,
    fragmentShader: MODEL_FRAGMENT,
    defines,
    uniforms: {
      map: { value: bucket.map },
      uSky: { value: LIGHT.sky },
      uGround: { value: LIGHT.ground },
      uSun: { value: LIGHT.sun },
      uSunDirection: { value: LIGHT.sunDirection },
      uFlat: { value: 0 },
      uSmooth: { value: 0 },
    },
    side: FrontSide,
  });
}

function buildScene(asset: ModelAsset): Loaded {
  const scene = new Scene();
  const meshes = asset.buckets.map((bucket) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(bucket.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(bucket.normals, 3, true));
    geometry.setAttribute('color', new BufferAttribute(bucket.colors, 3, true));
    if (bucket.uvs) geometry.setAttribute('uv', new BufferAttribute(bucket.uvs, 2));
    geometry.setIndex(new BufferAttribute(bucket.indices, 1));
    const mesh = new Mesh(geometry, modelMaterial(bucket));
    // One camera always framing the whole model: nothing to cull.
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  });
  return { asset, scene, meshes, lastUsed: clock };
}

function ensureModel(url: string): Promise<Loaded> {
  const existing = models.get(url);
  if (existing) return existing;
  const promise = (async () => {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
      const reason = (await response.text().catch(() => '')).trim();
      throw new Error(reason || `HTTP ${response.status}`);
    }
    const loaded = buildScene(await loadModel(await response.arrayBuffer()));
    ready.set(url, loaded);
    evict(url);
    return loaded;
  })();
  models.set(url, promise);
  promise.catch((error: unknown) => {
    models.delete(url);
    failures.set(url, error instanceof Error ? error.message : String(error));
  });
  return promise;
}

function evict(keep: string): void {
  let total = 0;
  for (const loaded of ready.values()) total += loaded.asset.vertexCount;
  const oldest = [...ready.entries()]
    .filter(([url]) => url !== keep)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [url, loaded] of oldest) {
    if (total <= MAX_RESIDENT_VERTICES) break;
    total -= loaded.asset.vertexCount;
    for (const mesh of loaded.meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    for (const bucket of loaded.asset.buckets) bucket.map?.dispose();
    ready.delete(url);
    models.delete(url);
  }
}

// ------------------------------------------------------------------ render

type Request = Extract<ToWorker, { type: 'render' }>;

const target = new Vector3();

function render(loaded: Loaded, request: Request): ImageBitmap {
  const { asset, scene, meshes } = loaded;
  const { settings } = request;
  loaded.lastUsed = ++clock;
  if (settings.shading === 'smooth' && !asset.buckets[0]?.smoothNormals) {
    computeSmoothNormals(asset);
    asset.buckets.forEach((bucket, index) => {
      if (bucket.smoothNormals) {
        meshes[index]?.geometry.setAttribute(
          'smoothNormal',
          new BufferAttribute(bucket.smoothNormals, 3, true),
        );
      }
    });
  }
  for (const mesh of meshes) {
    const { uFlat, uSmooth } = mesh.material.uniforms;
    if (uFlat) uFlat.value = settings.shading === 'flat' ? 1 : 0;
    if (uSmooth) uSmooth.value = settings.shading === 'smooth' ? 1 : 0;
  }

  const width = Math.max(1, Math.round(request.width));
  const height = Math.max(1, Math.round(request.height));
  if (canvas.width !== width || canvas.height !== height) renderer.setSize(width, height, false);
  const aspect = width / height;
  const radius = asset.radius;
  const distance = framingDistance(radius, MODEL_FOV_Y, aspect) * settings.distance;
  target.set(settings.panX, settings.panY, settings.panZ).multiplyScalar(radius).add(asset.center);
  const { forward } = cameraBasis(settings);
  camera.position.set(forward.x, forward.y, forward.z).multiplyScalar(distance).add(target);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  const reach = radius * (1 + Math.hypot(settings.panX, settings.panY, settings.panZ)) * 1.05;
  const toCenter = camera.position.distanceTo(asset.center);
  camera.aspect = aspect;
  camera.near = Math.max(toCenter - reach, radius * 0.001, toCenter * 0.0005);
  camera.far = toCenter + reach;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  if (settings.background) scene.add(sky);
  renderer.render(scene, camera);
  scene.remove(sky);
  return canvas.transferToImageBitmap();
}

// ------------------------------------------------------------------ queue

/** Latest request per item; live (orbiting) ones go first. */
const pending = new Map<string, Request>();
/** Requests waiting on a poster-cache lookup (not loaded meanwhile). */
const checking = new Set<Request>();
let draining = false;

function schedule(): void {
  if (draining) return;
  draining = true;
  setTimeout(drain, 0);
}

function drain(): void {
  draining = false;
  const order = [...pending.values()].sort((a, b) => Number(b.live) - Number(a.live));
  for (const request of order) {
    if (checking.has(request)) continue;
    const loaded = ready.get(request.url);
    if (!loaded) {
      const failed = failures.get(request.url);
      if (failed) {
        pending.delete(request.id);
        scope.postMessage({ type: 'error', id: request.id, reqId: request.reqId, message: failed });
        continue;
      }
      ensureModel(request.url).then(schedule, schedule);
      continue;
    }
    pending.delete(request.id);
    let bitmap: ImageBitmap;
    try {
      bitmap = render(loaded, request);
    } catch (error) {
      scope.postMessage({
        type: 'error',
        id: request.id,
        reqId: request.reqId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!request.live) persist(request, bitmap);
    scope.postMessage(
      { type: 'frame', id: request.id, reqId: request.reqId, bitmap, cached: false },
      [bitmap],
    );
    // One frame per turn: keep answering new (live) requests promptly.
    if (pending.size > 0) schedule();
    return;
  }
}

/** A render only becomes the poster once the item has settled (a resize
 *  asks for a new size every frame; only the last is worth encoding). */
const PERSIST_DELAY_MS = 600;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Keep a settled render as the item's poster for the next cold load (a
 *  copy: the bitmap itself is transferred to the board). */
function persist(request: Request, bitmap: ImageBitmap): void {
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
  copy.getContext('2d')?.drawImage(bitmap, 0, 0);
  const previous = persistTimers.get(request.id);
  if (previous !== undefined) clearTimeout(previous);
  persistTimers.set(
    request.id,
    setTimeout(async () => {
      persistTimers.delete(request.id);
      try {
        const blob = await copy.convertToBlob({ type: 'image/webp', quality: 0.9 });
        await writePoster(posterKey(request), blob, copy.width, copy.height);
      } catch {
        // The cache is an optimization; a failed write only costs a render.
      }
    }, PERSIST_DELAY_MS),
  );
}

const posterKey = (request: Request) => `${request.url}|${settingsKey(request.settings)}`;

/**
 * A cold item (its model not loaded) first tries the poster cache: a big
 * enough poster answers without loading the model at all; a smaller one is
 * shown while the model loads for a sharp render.
 */
async function fromCache(request: Request): Promise<boolean> {
  const poster = await readPoster(posterKey(request)).catch(() => null);
  if (!poster || pending.get(request.id) !== request) return false;
  const bitmap = await createImageBitmap(poster.blob).catch(() => null);
  if (!bitmap || pending.get(request.id) !== request) return false;
  const sharp = poster.width >= request.width * 0.75 && poster.height >= request.height * 0.75;
  scope.postMessage({ type: 'frame', id: request.id, reqId: request.reqId, bitmap, cached: true }, [
    bitmap,
  ]);
  if (sharp) pending.delete(request.id);
  return sharp;
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    pending.delete(message.id);
    return;
  }
  pending.set(message.id, message);
  if (!message.live && !ready.has(message.url)) {
    checking.add(message);
    void fromCache(message).then((served) => {
      checking.delete(message);
      if (!served) schedule();
    });
    return;
  }
  schedule();
});
