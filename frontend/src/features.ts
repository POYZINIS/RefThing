/**
 * Feature flags (plan Phase 11: "gate new/rough item types behind a simple
 * flag system"). A disabled item type degrades to a generic file card — it
 * stays on the board and downloadable, it just loses its poster/live modes.
 *
 * Override per machine from the dev console:
 *   localStorage.setItem('refthing.features', JSON.stringify({ video: false }))
 */
export type Features = {
  /** Video items: frame posters + live <video> playback. */
  video: boolean;
  /** Audio items: waveform posters + live mini-player. */
  audio: boolean;
  /** 3D model items (GLB / glTF / FBX / .blend): rendered views + orbit. */
  model: boolean;
};

const DEFAULTS: Features = { video: true, audio: true, model: true };

function load(): Features {
  try {
    const raw = globalThis.localStorage?.getItem('refthing.features');
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Features>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export const features: Features = load();
