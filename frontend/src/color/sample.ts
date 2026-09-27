/**
 * Sampling a palette from an image (pure, unit-tested): k-means++ in OKLab
 * — so clusters follow perceived colour, not raw RGB — over a bounded
 * sample of the opaque pixels. Transparent pixels are skipped (a 3D model
 * rendered without its sky gives only the model's own colours). The result
 * is ordered dark to light.
 */
import { rgbToHex } from './harmony';

type Lab = [number, number, number];

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const gamma = (channel: number) => {
  const c = Math.min(1, Math.max(0, channel));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
};

/** sRGB bytes → OKLab. */
export function toOklab(r: number, g: number, b: number): Lab {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → `#rrggbb`. */
export function oklabToHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return rgbToHex(
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  );
}

const distance = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/** A small deterministic generator (same image → same palette). */
function seeded(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export type SampleOptions = {
  /** Colours wanted (fewer come back when the image has fewer). */
  count?: number;
  /** Pixels below this alpha (0–255) are ignored. */
  alphaMin?: number;
  /** Pixels considered at most (evenly strided). */
  maxSamples?: number;
};

/** The image's main colours, from RGBA bytes (canvas ImageData order). */
export function extractPalette(pixels: Uint8ClampedArray, options: SampleOptions = {}): string[] {
  const count = options.count ?? 5;
  const alphaMin = options.alphaMin ?? 200;
  const maxSamples = options.maxSamples ?? 6000;
  const total = Math.floor(pixels.length / 4);
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const points: Lab[] = [];
  for (let index = 0; index < total; index += stride) {
    const at = index * 4;
    if ((pixels[at + 3] ?? 0) < alphaMin) continue;
    points.push(toOklab(pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0));
  }
  if (points.length === 0) return [];
  const random = seeded(points.length);

  // k-means++ seeding: each next centre far from the ones chosen.
  const centres: Lab[] = [points[Math.floor(random() * points.length)] as Lab];
  const nearest = points.map((point) => distance(point, centres[0] as Lab));
  while (centres.length < count) {
    const sum = nearest.reduce((acc, value) => acc + value, 0);
    if (sum <= 1e-9) break; // every pixel already matches a centre
    let target = random() * sum;
    let chosen = 0;
    for (; chosen < points.length - 1; chosen += 1) {
      target -= nearest[chosen] ?? 0;
      if (target <= 0) break;
    }
    const centre = points[chosen] as Lab;
    centres.push(centre);
    points.forEach((point, index) => {
      nearest[index] = Math.min(nearest[index] ?? Infinity, distance(point, centre));
    });
  }

  // Lloyd iterations.
  const assigned = new Int32Array(points.length);
  for (let iteration = 0; iteration < 14; iteration += 1) {
    let changed = false;
    points.forEach((point, index) => {
      let best = 0;
      let bestDistance = Infinity;
      centres.forEach((centre, c) => {
        const d = distance(point, centre);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      });
      if (assigned[index] !== best) {
        assigned[index] = best;
        changed = true;
      }
    });
    const sums = centres.map(() => [0, 0, 0, 0]);
    points.forEach((point, index) => {
      const sum = sums[assigned[index] ?? 0];
      if (!sum) return;
      sum[0] = (sum[0] ?? 0) + point[0];
      sum[1] = (sum[1] ?? 0) + point[1];
      sum[2] = (sum[2] ?? 0) + point[2];
      sum[3] = (sum[3] ?? 0) + 1;
    });
    sums.forEach((sum, c) => {
      const n = sum[3] ?? 0;
      if (n > 0) centres[c] = [(sum[0] ?? 0) / n, (sum[1] ?? 0) / n, (sum[2] ?? 0) / n];
    });
    if (!changed && iteration > 0) break;
  }

  const sizes = centres.map(() => 0);
  for (const cluster of assigned) sizes[cluster] = (sizes[cluster] ?? 0) + 1;
  // Colours that look the same are one colour: an image with two colours
  // gives two swatches, not five near-copies. Bigger clusters win.
  const kept: Lab[] = [];
  centres
    .map((centre, c) => ({ centre, size: sizes[c] ?? 0 }))
    .filter((entry) => entry.size > 0)
    .sort((a, b) => b.size - a.size)
    .forEach(({ centre }) => {
      if (kept.every((other) => distance(centre, other) > DISTINCT ** 2)) kept.push(centre);
    });
  return kept
    .sort((a, b) => a[0] - b[0])
    .map(oklabToHex)
    .filter((hex, index, all) => all.indexOf(hex) === index);
}

/** OKLab distance below which two sampled colours read as one. */
const DISTINCT = 0.06;
