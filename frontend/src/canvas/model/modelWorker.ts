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
  NoColorSpace,
  OrthographicCamera,
  PerspectiveCamera,
  RawShaderMaterial,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  activeTextures,
  cameraBasis,
  framingDistance,
  MODEL_FOV_Y,
  type ModelSettings,
  settingsKey,
  type TextureChannel,
} from '../nodes/modelView';
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
  /** What smooth surfaces reflect: the sky above the horizon, ground below. */
  envSky: new Color('#c6d2df'),
  envGround: new Color('#8f8a85'),
  /** Towards the sun, model space: each item's own (settings.sun*), set
   *  before every render; the model and sky materials share this vector. */
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
#ifdef USE_UV
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
#ifdef USE_UV
  vUv = uv;
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

/**
 * The model shader. With no maps beyond the model's own colour texture it
 * is the plain diffuse one (sun + sky/ground hemisphere). Maps given in the
 * menu switch parts on by define, so a model only pays for what it has:
 * a normal map (tangent frame from screen-space derivatives — no tangent
 * attribute), ambient occlusion, and — with metalness or roughness — a
 * small GGX specular plus sky reflections.
 */
const MODEL_FRAGMENT = /* glsl */ `
precision highp float;
#define PI 3.14159265
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDirection;
uniform vec3 uEnvSky;
uniform vec3 uEnvGround;
uniform vec3 cameraPosition;
uniform float uFlat;
uniform float uRoughInvert;
#ifdef USE_UV
in vec2 vUv;
#endif
#ifdef USE_MAP
uniform sampler2D map;
#endif
#ifdef USE_NORMALMAP
uniform sampler2D normalMap;
#endif
#ifdef USE_MRO
uniform sampler2D mroMap;
#endif
#ifdef USE_METALMAP
uniform sampler2D metalMap;
#endif
#ifdef USE_ROUGHMAP
uniform sampler2D roughMap;
#endif
#ifdef USE_AOMAP
uniform sampler2D aoMap;
#endif
in vec3 vNormal;
in vec3 vPosition;
in vec3 vColor;
out vec4 fragColor;
${SRGB_OUT}

#ifdef USE_NORMALMAP
// A tangent-space normal onto the surface, the frame from derivatives of
// position and UV (Schueler's cotangent frame).
vec3 perturb(vec3 n, vec3 mapN) {
  vec3 q0 = dFdx(vPosition);
  vec3 q1 = dFdy(vPosition);
  vec2 st0 = dFdx(vUv);
  vec2 st1 = dFdy(vUv);
  vec3 q1perp = cross(q1, n);
  vec3 q0perp = cross(n, q0);
  vec3 t = q1perp * st0.x + q0perp * st1.x;
  vec3 b = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(t, t), dot(b, b));
  float scale = det == 0.0 ? 0.0 : inversesqrt(det);
  return normalize(t * (mapN.x * scale) + b * (mapN.y * scale) + n * mapN.z);
}
#endif

void main() {
  vec3 albedo = vColor;
#ifdef USE_MAP
  vec4 texel = texture(map, vUv);
  #ifdef USE_CUTOUT
  if (texel.a < 0.5) discard;
  #endif
  #ifdef COLOR_REPLACES
  // An imported colour map IS the base colour (as an image in Blender's
  // Base Color is): the material's colour and vertex colour step aside.
  albedo = texel.rgb;
  #else
  albedo *= texel.rgb;
  #endif
#endif
  // Flat: the face's own normal from screen-space derivatives (no extra
  // geometry). Otherwise the interpolated vertex normal.
  vec3 faceNormal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
  vec3 n = uFlat > 0.5 ? faceNormal : normalize(vNormal);
#ifdef USE_NORMALMAP
  vec3 mapN = texture(normalMap, vUv).xyz * 2.0 - 1.0;
  // OpenGL-style maps (green up) on top-down UVs: up in the image is -v.
  mapN.y = -mapN.y;
  n = perturb(n, mapN);
#endif
  float ao = 1.0;
  float metal = 0.0;
  float rough = 1.0;
#ifdef USE_MRO
  vec3 mro = texture(mroMap, vUv).rgb;
  metal = mro.r;
  rough = mix(mro.g, 1.0 - mro.g, uRoughInvert);
  ao = mro.b;
#endif
#ifdef USE_METALMAP
  metal = texture(metalMap, vUv).r;
#endif
#ifdef USE_ROUGHMAP
  float roughness = texture(roughMap, vUv).r;
  rough = mix(roughness, 1.0 - roughness, uRoughInvert);
#endif
#ifdef USE_AOMAP
  ao = texture(aoMap, vUv).r;
#endif
  vec3 ambient = mix(uGround, uSky, n.y * 0.5 + 0.5) * ao;
  float ndl = max(dot(n, uSunDirection), 0.0);
#ifdef USE_PBR
  vec3 v = normalize(cameraPosition - vPosition);
  vec3 h = normalize(uSunDirection + v);
  float ndv = max(dot(n, v), 1e-4);
  float ndh = max(dot(n, h), 0.0);
  float vdh = max(dot(v, h), 0.0);
  float a = max(rough * rough, 0.002);
  float a2 = a * a;
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  float d = a2 / (PI * denom * denom);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float g = (ndl / (ndl * (1.0 - k) + k)) * (ndv / (ndv * (1.0 - k) + k));
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 fresnel = f0 + (1.0 - f0) * pow(1.0 - vdh, 5.0);
  vec3 specular = d * g * fresnel / max(4.0 * ndl * ndv, 1e-4);
  vec3 diffuse = albedo * (1.0 - metal);
  // Reflections of the sky: sharp when smooth, towards the ambient when rough.
  vec3 r = reflect(-v, n);
  vec3 env = mix(uEnvGround, uEnvSky, smoothstep(-0.15, 0.25, r.y));
  env = mix(env, ambient * 1.6, rough);
  vec3 envFresnel = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - ndv, 5.0);
  vec3 lit = diffuse * ambient + (diffuse + PI * specular) * uSun * ndl + env * envFresnel * ao;
#else
  vec3 lit = albedo * (ambient + uSun * ndl);
#endif
  fragColor = vec4(toSrgb(lit), 1.0);
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
uniform vec3 uSunDirection;
in vec2 vNdc;
out vec4 fragColor;
${SRGB_OUT}
void main() {
  vec4 view = uInverseProjection * vec4(vNdc, 1.0, 1.0);
  vec3 direction = normalize((uCameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
  float y = direction.y;
  vec3 sky = mix(uHorizon, uZenith, pow(max(y, 0.0), 0.55));
  vec3 ground = mix(uGroundHorizon, uGround, pow(max(-y, 0.0), 0.4));
  vec3 color = mix(ground, sky, smoothstep(-0.015, 0.015, y));
  // The sun where the light comes from: a small disk and a soft glow.
  float toSun = dot(direction, uSunDirection);
  color += vec3(1.0, 0.95, 0.85) * (smoothstep(0.9993, 0.9996, toSun) * 3.0 + pow(max(toSun, 0.0), 180.0) * 0.35);
  fragColor = vec4(toSrgb(color), 1.0);
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
const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

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
    uSunDirection: { value: LIGHT.sunDirection },
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
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: MODEL_VERTEX,
    fragmentShader: MODEL_FRAGMENT,
    uniforms: {
      map: { value: bucket.map },
      normalMap: { value: null },
      mroMap: { value: null },
      metalMap: { value: null },
      roughMap: { value: null },
      aoMap: { value: null },
      uSky: { value: LIGHT.sky },
      uGround: { value: LIGHT.ground },
      uSun: { value: LIGHT.sun },
      uSunDirection: { value: LIGHT.sunDirection },
      uEnvSky: { value: LIGHT.envSky },
      uEnvGround: { value: LIGHT.envGround },
      uFlat: { value: 0 },
      uSmooth: { value: 0 },
      uRoughInvert: { value: 0 },
    },
    side: FrontSide,
  });
  applyMaps(material, bucket, {}, false);
  return material;
}

/** Point a bucket's material at its maps (the menu's, over the model's own
 *  colour texture), recompiling only when the set of maps changes. */
function applyMaps(
  material: RawShaderMaterial,
  bucket: Bucket,
  maps: Maps,
  roughnessInvert: boolean,
): void {
  const color = maps.color ?? bucket.map;
  const defines: Record<string, string> = {};
  if (color) defines.USE_MAP = '';
  if (maps.color) defines.COLOR_REPLACES = '';
  // The model's own texture's alpha cuts out (foliage); a replacement doesn't.
  if (color === bucket.map && bucket.cutout) defines.USE_CUTOUT = '';
  if (maps.normal) defines.USE_NORMALMAP = '';
  if (maps.mro) defines.USE_MRO = '';
  if (maps.metalness) defines.USE_METALMAP = '';
  if (maps.roughness) defines.USE_ROUGHMAP = '';
  if (maps.ao) defines.USE_AOMAP = '';
  if (maps.mro || maps.metalness || maps.roughness) defines.USE_PBR = '';
  if (Object.keys(defines).length > 0) defines.USE_UV = '';
  const signature = Object.keys(defines).sort().join(',');
  if (material.userData.signature !== signature) {
    material.userData.signature = signature;
    material.defines = defines;
    material.needsUpdate = true;
  }
  const { uniforms } = material;
  const set = (name: string, value: unknown) => {
    const uniform = uniforms[name];
    if (uniform) uniform.value = value;
  };
  set('map', color ?? null);
  set('normalMap', maps.normal ?? null);
  set('mroMap', maps.mro ?? null);
  set('metalMap', maps.metalness ?? null);
  set('roughMap', maps.roughness ?? null);
  set('aoMap', maps.ao ?? null);
  set('uRoughInvert', roughnessInvert ? 1 : 0);
}

// -------------------------------------------------------------- user maps

/** Resolved maps given in the menu, by channel. */
type Maps = Partial<Record<TextureChannel, Texture>>;

type MapEntry = { texture: Texture | null; done: boolean; lastUsed: number };
/** Loaded images by blob hash + colour space; failures resolve to null. */
const mapCache = new Map<string, MapEntry>();
/** Images kept on the GPU before the least recently used go. */
const MAX_MAPS = 64;

function loadMap(hash: string, srgb: boolean): MapEntry {
  const key = `${hash}|${srgb ? 'srgb' : 'linear'}`;
  const cached = mapCache.get(key);
  if (cached) {
    cached.lastUsed = clock;
    return cached;
  }
  const entry: MapEntry = { texture: null, done: false, lastUsed: clock };
  mapCache.set(key, entry);
  fetch(`/blob/${hash}/full`, { credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.blob();
    })
    .then((blob) => createImageBitmap(blob))
    .then((bitmap) => {
      const texture = new Texture(bitmap);
      texture.flipY = false; // top-down, like every baked UV
      texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      entry.texture = texture;
    })
    .catch(() => undefined)
    .finally(() => {
      entry.done = true;
      evictMaps();
      schedule();
    });
  return entry;
}

function evictMaps(): void {
  if (mapCache.size <= MAX_MAPS) return;
  const oldest = [...mapCache.entries()]
    .filter(([, entry]) => entry.done)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, entry] of oldest.slice(0, mapCache.size - MAX_MAPS)) {
    entry.texture?.dispose();
    mapCache.delete(key);
  }
}

/** A render's maps once all have loaded (a failed one is left out), or
 *  null while any is still on its way. */
function resolveMaps(settings: ModelSettings): Maps | null {
  const maps: Maps = {};
  let ready = true;
  for (const [channel, hash] of Object.entries(activeTextures(settings)) as [
    TextureChannel,
    string,
  ][]) {
    const entry = loadMap(hash, channel === 'color');
    if (!entry.done) ready = false;
    else if (entry.texture) maps[channel] = entry.texture;
  }
  return ready ? maps : null;
}

function buildScene(asset: ModelAsset): Loaded {
  const scene = new Scene();
  const meshes = asset.buckets.map((bucket) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(bucket.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(bucket.normals, 3, true));
    geometry.setAttribute('color', new BufferAttribute(bucket.colors, 3, true));
    geometry.setAttribute('uv', new BufferAttribute(bucket.uvs, 2));
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

function render(loaded: Loaded, request: Request, maps: Maps): ImageBitmap {
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
  meshes.forEach((mesh, index) => {
    const { uFlat, uSmooth } = mesh.material.uniforms;
    if (uFlat) uFlat.value = settings.shading === 'flat' ? 1 : 0;
    if (uSmooth) uSmooth.value = settings.shading === 'smooth' ? 1 : 0;
    const bucket = asset.buckets[index];
    if (bucket) applyMaps(mesh.material, bucket, maps, settings.roughnessInvert);
  });

  LIGHT.sunDirection.set(settings.sunX, settings.sunY, settings.sunZ).normalize();

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

  // Orthographic: the same framing (the model's sphere just fits at
  // distance 1), the camera backed off far enough never to clip it. The
  // sky keeps reading its rays from the perspective camera above, so its
  // gradient stays (a parallel projection would flatten it to one colour).
  let view: PerspectiveCamera | OrthographicCamera = camera;
  if (settings.projection === 'orthographic') {
    const half = radius * settings.distance;
    const halfHeight = half * Math.max(1, 1 / aspect);
    const halfWidth = halfHeight * aspect;
    ortho.left = -halfWidth;
    ortho.right = halfWidth;
    ortho.top = halfHeight;
    ortho.bottom = -halfHeight;
    const back = reach * 3;
    ortho.position.set(forward.x, forward.y, forward.z).multiplyScalar(back).add(target);
    ortho.up.set(0, 1, 0);
    ortho.lookAt(target);
    const orthoToCenter = ortho.position.distanceTo(asset.center);
    ortho.near = Math.max(orthoToCenter - reach, radius * 0.001);
    ortho.far = orthoToCenter + reach;
    ortho.updateProjectionMatrix();
    ortho.updateMatrixWorld();
    view = ortho;
  }

  if (settings.background) scene.add(sky);
  renderer.render(scene, view);
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
    // Maps given in the menu load first (a finished load reschedules).
    const maps = resolveMaps(request.settings);
    if (!maps) continue;
    pending.delete(request.id);
    let bitmap: ImageBitmap;
    try {
      bitmap = render(loaded, request, maps);
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
