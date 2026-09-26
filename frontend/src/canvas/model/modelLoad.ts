/**
 * Model loading for the model worker: bytes → a flattened, render-only
 * asset. Models are never edited, so everything is baked once at load:
 *
 * - every mesh's world transform (and skinning / morphs at rest) goes into
 *   its vertices, and the scene graph is thrown away;
 * - the material's base colour is multiplied into a per-vertex colour;
 * - triangles are bucketed by base-colour texture, so a whole model is one
 *   draw call per texture (plus one untextured);
 * - only position, normal, uv (textured buckets) and colour survive.
 */
import {
  type BufferAttribute,
  type BufferGeometry,
  Color,
  type InterleavedBufferAttribute,
  Loader,
  LoadingManager,
  type Material,
  Matrix3,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** One draw call's worth of baked triangles. */
export type Bucket = {
  positions: Float32Array;
  /** Normalized int8 normals (the model's own). */
  normals: Int8Array;
  /** sRGB-encoded vertex colour (material colour × vertex colour). */
  colors: Uint8Array;
  uvs: Float32Array | null;
  indices: Uint16Array | Uint32Array;
  map: Texture | null;
  /** Cut out texels below half alpha (foliage cards, fences). */
  cutout: boolean;
  /** Welded averaged normals, made on first use (Shade Smooth). */
  smoothNormals: Int8Array | null;
};

export type ModelAsset = {
  buckets: Bucket[];
  center: Vector3;
  radius: number;
  vertexCount: number;
};

export type ModelFormat = 'glb' | 'gltf' | 'fbx';

/** The format of a model's bytes, by their magic numbers. */
export function sniffModel(bytes: ArrayBuffer): ModelFormat | null {
  const head = new Uint8Array(bytes, 0, Math.min(64, bytes.byteLength));
  const text = String.fromCharCode(...head);
  if (text.startsWith('glTF')) return 'glb';
  if (text.startsWith('Kaydara FBX Binary')) return 'fbx';
  const trimmed = text.trimStart();
  if (trimmed.startsWith(';') && /FBX/i.test(text)) return 'fbx';
  if (trimmed.startsWith('{')) return 'gltf';
  return null;
}

/** Parse model bytes and bake them into an asset. */
export async function loadModel(bytes: ArrayBuffer): Promise<ModelAsset> {
  const format = sniffModel(bytes);
  if (!format) throw new Error('Not a model this viewer reads (GLB, glTF or FBX)');
  const root = format === 'fbx' ? await parseFbx(bytes) : await parseGltf(bytes);
  try {
    return bake(root);
  } finally {
    dispose(root);
  }
}

// ------------------------------------------------------------------ parse

let draco: DRACOLoader | null = null;

async function parseGltf(bytes: ArrayBuffer): Promise<Object3D> {
  const loader = new GLTFLoader();
  // The decoder files ship with three (bundled next to this worker).
  draco ??= new DRACOLoader();
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(bytes, '');
  return gltf.scene;
}

/**
 * FBX parses synchronously, but its embedded textures load through the
 * loading manager. The stock TextureLoader needs the DOM (an <img>), so the
 * manager hands every image to a createImageBitmap loader instead, and the
 * parse waits for them (a texture that fails to load just isn't used).
 */
async function parseFbx(bytes: ArrayBuffer): Promise<Object3D> {
  const pending: Promise<unknown>[] = [];
  const manager = new LoadingManager();
  manager.addHandler(
    /\.(png|jpe?g|bmp|gif|webp|tiff?)$/i,
    new BitmapTextureLoader(manager, pending),
  );
  // A camera in the file reads window.innerWidth for its aspect (the
  // worker has no window): shim it for the synchronous parse only.
  const scope = globalThis as { window?: unknown };
  const hadWindow = 'window' in scope;
  if (!hadWindow) scope.window = { innerWidth: 1, innerHeight: 1 };
  let root: Object3D;
  try {
    root = new FBXLoader(manager).parse(bytes, '');
  } finally {
    if (!hadWindow) delete scope.window;
  }
  // FBXLoader reads material colours as sRGB, but Blender (and most DCCs)
  // write them linear: undo its conversion, or every colour comes out far
  // too dark.
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      (material as Material & { color?: Color }).color?.convertLinearToSRGB();
    }
  });
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, 15_000)),
  ]);
  return root;
}

/** TextureLoader without the DOM: fetch + createImageBitmap. */
class BitmapTextureLoader extends Loader<Texture> {
  constructor(
    manager: LoadingManager,
    private readonly pending: Promise<unknown>[],
  ) {
    super(manager);
  }

  override load(url: string): Texture {
    const texture = new Texture();
    // FBX UVs are bottom-up: flip the bitmap itself (WebGL ignores
    // UNPACK_FLIP_Y for ImageBitmap uploads).
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    const full = this.path && !/^(blob|data):/.test(url) ? this.path + url : url;
    this.pending.push(
      fetch(full)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.blob();
        })
        .then((blob) => createImageBitmap(blob, { imageOrientation: 'flipY' }))
        .then((bitmap) => {
          texture.image = bitmap;
          texture.needsUpdate = true;
        })
        .catch(() => undefined),
    );
    return texture;
  }
}

// ------------------------------------------------------------------- bake

type Draft = {
  positions: GrowF32;
  normals: GrowI8;
  colors: GrowU8;
  uvs: GrowF32 | null;
  indices: GrowU32;
  vertexCount: number;
  map: Texture | null;
  cutout: boolean;
};

/** The texture a material draws with, if it has actually loaded. */
function baseMap(material: Material): Texture | null {
  const map = (material as Material & { map?: Texture | null }).map ?? null;
  if (!map) return null;
  const image = map.image as { width?: number } | undefined;
  return image && (image.width ?? 0) > 0 ? map : null;
}

function bake(root: Object3D): ModelAsset {
  root.updateMatrixWorld(true);
  const drafts = new Map<string, Draft>();
  const normalMatrix = new Matrix3();
  const position = new Vector3();
  const normal = new Vector3();
  const tint = new Color();
  const vertexTint = new Color();

  root.traverseVisible((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as BufferGeometry;
    const positions = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!positions || positions.count === 0) return;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const normals = geometry.getAttribute('normal') as BufferAttribute | InterleavedBufferAttribute;
    const uvs = geometry.getAttribute('uv') as BufferAttribute | undefined;
    const colors = geometry.getAttribute('color') as BufferAttribute | undefined;
    const index = geometry.getIndex();
    const matrix = mesh.matrixWorld;
    normalMatrix.getNormalMatrix(matrix);
    // Mirrored transforms turn triangles inside out: flip their winding so
    // back-face culling still keeps the outside.
    const mirrored = matrix.determinant() < 0;
    const skinned = (mesh as SkinnedMesh).isSkinnedMesh || !!geometry.morphAttributes.position;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const total = index ? index.count : positions.count;
    const groups = Array.isArray(mesh.material)
      ? geometry.groups
      : [{ start: 0, count: total, materialIndex: 0 }];

    // Per (mesh, material): only the vertices its triangles use.
    const remap = new Int32Array(positions.count).fill(-1);
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material) continue;
      const map = baseMap(material);
      const cutout =
        !!map && (material.alphaTest > 0 || (material.transparent && material.opacity >= 0.99));
      const key = `${map?.uuid ?? 'none'}|${cutout ? 1 : 0}`;
      let draft = drafts.get(key);
      if (!draft) {
        draft = {
          positions: new GrowF32(),
          normals: new GrowI8(),
          colors: new GrowU8(),
          uvs: map ? new GrowF32() : null,
          indices: new GrowU32(),
          vertexCount: 0,
          map,
          cutout,
        };
        drafts.set(key, draft);
      }
      const materialColor = (material as Material & { color?: Color }).color;
      tint.setRGB(1, 1, 1);
      if (materialColor) tint.copy(materialColor);
      const useVertexColors = !!colors && (material as Material).vertexColors;

      const touched: number[] = [];
      const start = Math.max(0, group.start);
      const end = Math.min(total, start + group.count);
      const triangleEnd = start + Math.floor((end - start) / 3) * 3;
      const corner = [0, 0, 0];
      for (let i = start; i < triangleEnd; i += 3) {
        for (let k = 0; k < 3; k += 1) {
          const source = index ? index.getX(i + k) : i + k;
          let target = remap[source] ?? -1;
          if (target < 0) {
            target = draft.vertexCount;
            draft.vertexCount += 1;
            remap[source] = target;
            touched.push(source);
            if (skinned) (mesh as Mesh).getVertexPosition(source, position);
            else position.fromBufferAttribute(positions, source);
            position.applyMatrix4(matrix);
            draft.positions.push3(position.x, position.y, position.z);
            normal.fromBufferAttribute(normals, source).applyMatrix3(normalMatrix).normalize();
            draft.normals.push3(snorm(normal.x), snorm(normal.y), snorm(normal.z));
            if (draft.uvs) {
              draft.uvs.push2(uvs ? uvs.getX(source) : 0, uvs ? uvs.getY(source) : 0);
            }
            vertexTint.copy(tint);
            if (useVertexColors && colors) {
              vertexTint.r *= colors.getX(source);
              vertexTint.g *= colors.getY(source);
              vertexTint.b *= colors.getZ(source);
            }
            draft.colors.push3(
              srgbByte(vertexTint.r),
              srgbByte(vertexTint.g),
              srgbByte(vertexTint.b),
            );
          }
          corner[k] = target;
        }
        const [a = 0, b = 0, c = 0] = corner;
        if (mirrored) draft.indices.push3(a, c, b);
        else draft.indices.push3(a, b, c);
      }
      for (const source of touched) remap[source] = -1;
    }
  });

  const buckets: Bucket[] = [];
  let vertexCount = 0;
  for (const draft of drafts.values()) {
    if (draft.indices.length === 0) continue;
    vertexCount += draft.vertexCount;
    const indices = draft.indices.view();
    buckets.push({
      positions: draft.positions.view(),
      normals: draft.normals.view(),
      colors: draft.colors.view(),
      uvs: draft.uvs?.view() ?? null,
      indices: draft.vertexCount <= 65535 ? Uint16Array.from(indices) : indices,
      map: draft.map,
      cutout: draft.cutout,
      smoothNormals: null,
    });
  }
  if (buckets.length === 0) throw new Error('The model has no visible surfaces');
  const { center, radius } = boundingSphere(buckets);
  return { buckets, center, radius, vertexCount };
}

/** Centre = bounding box centre; radius = farthest vertex from it. */
function boundingSphere(buckets: Bucket[]): { center: Vector3; radius: number } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of buckets) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[i + axis] ?? 0;
        if (value < (min[axis] ?? 0)) min[axis] = value;
        if (value > (max[axis] ?? 0)) max[axis] = value;
      }
    }
  }
  const center = new Vector3(
    ((min[0] ?? 0) + (max[0] ?? 0)) / 2,
    ((min[1] ?? 0) + (max[1] ?? 0)) / 2,
    ((min[2] ?? 0) + (max[2] ?? 0)) / 2,
  );
  let squared = 0;
  for (const { positions } of buckets) {
    for (let i = 0; i < positions.length; i += 3) {
      const dx = (positions[i] ?? 0) - center.x;
      const dy = (positions[i + 1] ?? 0) - center.y;
      const dz = (positions[i + 2] ?? 0) - center.z;
      squared = Math.max(squared, dx * dx + dy * dy + dz * dz);
    }
  }
  return { center, radius: Math.max(Math.sqrt(squared), 1e-6) };
}

/**
 * Shade Smooth: one normal per POSITION (welded across UV seams, split
 * edges and buckets), the area-weighted average of the faces around it —
 * like Blender's smooth shading without auto-smooth. Made once, on demand.
 */
export function computeSmoothNormals(asset: ModelAsset): void {
  const quantum = asset.radius * 1e-5;
  const keyOf = (positions: Float32Array, vertex: number) =>
    `${Math.round((positions[vertex * 3] ?? 0) / quantum)},${Math.round(
      (positions[vertex * 3 + 1] ?? 0) / quantum,
    )},${Math.round((positions[vertex * 3 + 2] ?? 0) / quantum)}`;
  const sums = new Map<string, [number, number, number]>();
  const keys: string[][] = [];
  for (const bucket of asset.buckets) {
    const { positions, indices } = bucket;
    const bucketKeys: string[] = new Array(positions.length / 3);
    for (let v = 0; v < bucketKeys.length; v += 1) bucketKeys[v] = keyOf(positions, v);
    keys.push(bucketKeys);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] ?? 0;
      const b = indices[i + 1] ?? 0;
      const c = indices[i + 2] ?? 0;
      const ux = (positions[b * 3] ?? 0) - (positions[a * 3] ?? 0);
      const uy = (positions[b * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
      const uz = (positions[b * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
      const vx = (positions[c * 3] ?? 0) - (positions[a * 3] ?? 0);
      const vy = (positions[c * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
      const vz = (positions[c * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
      // Unnormalized cross product = normal weighted by twice the area.
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const vertex of [a, b, c]) {
        const key = bucketKeys[vertex] ?? '';
        const sum = sums.get(key);
        if (sum) {
          sum[0] += nx;
          sum[1] += ny;
          sum[2] += nz;
        } else sums.set(key, [nx, ny, nz]);
      }
    }
  }
  asset.buckets.forEach((bucket, index) => {
    const bucketKeys = keys[index] ?? [];
    const smooth = new Int8Array(bucket.normals.length);
    for (let v = 0; v < bucketKeys.length; v += 1) {
      const [x, y, z] = sums.get(bucketKeys[v] ?? '') ?? [0, 1, 0];
      const length = Math.hypot(x, y, z) || 1;
      smooth[v * 3] = snorm(x / length);
      smooth[v * 3 + 1] = snorm(y / length);
      smooth[v * 3 + 2] = snorm(z / length);
    }
    bucket.smoothNormals = smooth;
  });
}

function dispose(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.dispose();
  });
}

const snorm = (value: number) => Math.max(-127, Math.min(127, Math.round(value * 127)));

/** Linear [0, 1] → sRGB byte. */
function srgbByte(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

// ------------------------------------------------------- growable arrays

class Grow<T extends Float32Array | Int8Array | Uint8Array | Uint32Array> {
  length = 0;
  constructor(private data: T) {}
  protected ensure(extra: number): T {
    if (this.length + extra > this.data.length) {
      const next = new (this.data.constructor as new (size: number) => T)(
        Math.max(1024, (this.length + extra) * 2),
      );
      next.set(this.data.subarray(0, this.length) as unknown as ArrayLike<number>);
      this.data = next;
    }
    return this.data;
  }
  push2(a: number, b: number): void {
    const data = this.ensure(2);
    data[this.length] = a;
    data[this.length + 1] = b;
    this.length += 2;
  }
  push3(a: number, b: number, c: number): void {
    const data = this.ensure(3);
    data[this.length] = a;
    data[this.length + 1] = b;
    data[this.length + 2] = c;
    this.length += 3;
  }
  /** The filled part, as its own compact array. */
  view(): T {
    return this.data.slice(0, this.length) as T;
  }
}
class GrowF32 extends Grow<Float32Array> {
  constructor() {
    super(new Float32Array(1024));
  }
}
class GrowI8 extends Grow<Int8Array> {
  constructor() {
    super(new Int8Array(1024));
  }
}
class GrowU8 extends Grow<Uint8Array> {
  constructor() {
    super(new Uint8Array(1024));
  }
}
class GrowU32 extends Grow<Uint32Array> {
  constructor() {
    super(new Uint32Array(1024));
  }
}
