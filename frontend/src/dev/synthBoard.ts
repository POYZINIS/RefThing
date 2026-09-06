import type { BoardSnapshot, Item } from '@/api/client';

export type SynthBoard = {
  snapshot: BoardSnapshot;
  /** blob_hash -> object URL for the shared procedural placeholder images. */
  imageUrls: Map<string, string>;
};

export type SynthOptions = {
  count: number;
  seed: number;
  /** Number of shared placeholder images the item pool draws from. */
  imageCount?: number;
};

export const SYNTH_BOARD_ID = 'synth-board';
const DEFAULT_IMAGE_COUNT = 200;
const PLACEHOLDER_SIZE = 256;

/** Deterministic PRNG so a given seed always produces the same board. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makePlaceholderImage(index: number, rand: () => number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = PLACEHOLDER_SIZE;
  canvas.height = PLACEHOLDER_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('2d context unavailable'));
  const base = [
    64 + Math.floor(rand() * 160),
    64 + Math.floor(rand() * 160),
    64 + Math.floor(rand() * 160),
  ] as const;
  const pixels = context.createImageData(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const noise = (rand() - 0.5) * 96;
    pixels.data[i] = clamp((base[0] ?? 0) + noise, 0, 255);
    pixels.data[i + 1] = clamp((base[1] ?? 0) + noise, 0, 255);
    pixels.data[i + 2] = clamp((base[2] ?? 0) + noise, 0, 255);
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  context.fillStyle = 'rgba(0, 0, 0, 0.6)';
  context.fillRect(0, 0, PLACEHOLDER_SIZE, 56);
  context.fillStyle = '#ffffff';
  context.font = 'bold 40px sans-serif';
  context.textBaseline = 'middle';
  context.fillText(`#${index}`, 12, 30);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(URL.createObjectURL(blob));
      else reject(new Error('canvas.toBlob failed'));
    }, 'image/png');
  });
}

/**
 * Generates a deterministic synthetic board: ~60% of items in Gaussian
 * clusters, ~40% uniform, both over a sqrt(count) * 2000px extent; log-normal
 * sizes in the 100-3000px range; 15% of items rotated +/-15 degrees. Items
 * share `imageCount` procedurally generated placeholder images so texture
 * load/decode/GPU-upload behavior stays honest without a backend.
 */
export async function generateSynthBoard(options: SynthOptions): Promise<SynthBoard> {
  const { count, seed } = options;
  const imageCount = options.imageCount ?? DEFAULT_IMAGE_COUNT;
  const rand = mulberry32(seed);

  const imageUrls = new Map<string, string>();
  const hashes: string[] = [];
  for (let index = 0; index < imageCount; index += 1) {
    const hash = `synth-${seed}-${index}`;
    hashes.push(hash);
    imageUrls.set(hash, await makePlaceholderImage(index, mulberry32(seed * 1000 + index)));
  }

  const extent = Math.sqrt(count) * 2000;
  const half = extent / 2;
  const clusterCount = Math.max(1, Math.round(count / 20));
  const clusters: Array<{ x: number; y: number; sigma: number }> = [];
  for (let i = 0; i < clusterCount; i += 1) {
    clusters.push({
      x: (rand() * 2 - 1) * half,
      y: (rand() * 2 - 1) * half,
      sigma: 600 + rand() * 1400,
    });
  }

  const now = Date.now();
  const items: Item[] = [];
  for (let index = 0; index < count; index += 1) {
    let x: number;
    let y: number;
    if (rand() < 0.6) {
      const cluster = clusters[Math.floor(rand() * clusters.length)];
      x = (cluster?.x ?? 0) + gaussian(rand) * (cluster?.sigma ?? 1000);
      y = (cluster?.y ?? 0) + gaussian(rand) * (cluster?.sigma ?? 1000);
    } else {
      x = (rand() * 2 - 1) * half;
      y = (rand() * 2 - 1) * half;
    }
    const size = clamp(Math.exp(gaussian(rand) * 0.6) * 380, 100, 3000);
    const aspect = 0.5 + rand() * 1.8;
    const wide = rand() < 0.5;
    const width = clamp(wide ? size * aspect : size / aspect, 60, 3200);
    const height = clamp(wide ? size / aspect : size * aspect, 60, 3200);
    const rotation = rand() < 0.15 ? (rand() * 2 - 1) * 15 : 0;
    items.push({
      id: `synth-item-${seed}-${index}`,
      board_id: SYNTH_BOARD_ID,
      type: 'image',
      blob_hash: hashes[index % hashes.length] ?? null,
      x,
      y,
      width,
      height,
      rotation,
      z_index: index,
      group_id: null,
      metadata: {},
      created_at: now,
      updated_at: now,
    });
  }

  const snapshot: BoardSnapshot = {
    board: {
      id: SYNTH_BOARD_ID,
      name: `Synthetic board (${count} items, seed ${seed})`,
      seq: 1,
      viewport_state: { x: 0, y: 0, zoom: 1 },
      created_at: now,
      updated_at: now,
    },
    seq: 1,
    items,
    groups: [],
    notes: [],
    tags: [],
    item_tags: {},
    blobs: [],
  };
  return { snapshot, imageUrls };
}

// --- /blob interception -----------------------------------------------------
// BoardCanvas resolves textures via blobUrl() -> /blob/{hash}/{level}, which
// normally hits the backend. The dev board must run without one, so synth
// hashes are rewritten to object URLs by patching the HTMLImageElement src
// setter (dev-only, installed once per page).

let interceptionInstalled = false;
const synthImageUrls = new Map<string, string>();

export function installSynthImageInterception(): void {
  if (interceptionInstalled || typeof HTMLImageElement === 'undefined') return;
  const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (!original?.set || !original.get) return;
  interceptionInstalled = true;
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: original.enumerable,
    get: original.get,
    set(this: HTMLImageElement, value: string) {
      const hash = /^\/blob\/(synth-[^/]+)\//.exec(value)?.[1];
      const override = hash ? synthImageUrls.get(hash) : undefined;
      original.set?.call(this, override ?? value);
    },
  });
}

export function registerSynthImages(imageUrls: Map<string, string>): void {
  synthImageUrls.clear();
  for (const [hash, url] of imageUrls) synthImageUrls.set(hash, url);
}
