// Animated GIF frame decoding for the PixiJS canvas engine (Phase 5 item 7).
//
// The pyramid pipeline generates WebP poster levels from a GIF's *first frame*
// only, and `/blob/{hash}/full` streams the original animated bytes. For GIF
// items we fetch those original bytes and decode them into per-frame
// `ImageBitmap`s (with their individual durations) using the browser-native
// `ImageDecoder` API, so no extra dependency is needed. `BoardCanvas` consumes
// these frames and cycles them on the rAF ticker.
//
// `ImageDecoder` is available in Chromium/Firefox/Safari 17+; if it is missing
// (or a frame fails to decode) we fall back to a single static frame so the
// item still renders.

export type GifFrame = {
  bitmap: ImageBitmap;
  /** Duration of this frame in milliseconds (from the GIF's own timing). */
  durationMs: number;
};

export type GifDecode = {
  frames: GifFrame[];
  /** Total loop duration in ms, used to wrap the timeline. */
  totalMs: number;
};

const ImageDecoderCtor: typeof ImageDecoder | undefined =
  typeof globalThis.ImageDecoder === 'function'
    ? (globalThis.ImageDecoder as typeof ImageDecoder)
    : undefined;

/** True when this environment can genuinely decode animated GIFs to frames. */
export function gifDecodingSupported(): boolean {
  return ImageDecoderCtor !== undefined;
}

/**
 * Fetch and decode an animated GIF into its frames. Deduplicated by the
 * caller keyed on the blob hash. Returns `null` when the browser cannot decode
 * it (unsupported API, network failure, or a non-animated single-frame GIF —
 * the latter yields one frame, which is still renderable as a static sprite).
 */
export async function decodeGif(url: string): Promise<GifDecode | null> {
  if (!ImageDecoderCtor) return null;

  let buffer: ArrayBuffer;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    buffer = await response.arrayBuffer();
  } catch {
    return null;
  }

  let decoder: ImageDecoder;
  try {
    decoder = new ImageDecoderCtor({ type: 'image/gif', data: buffer });
    await decoder.tracks.ready;
  } catch {
    return null;
  }

  const selectedTrack = decoder.tracks.selectedTrack;
  if (!selectedTrack) {
    decoder.close();
    return null;
  }

  const frames: GifFrame[] = [];
  let trackTotal = 0;
  for (let i = 0; i < selectedTrack.frameCount; i += 1) {
    let result: ImageDecodeResult;
    try {
      result = await decoder.decode({ frameIndex: i });
    } catch {
      decoder.close();
      for (const entry of frames) entry.bitmap.close();
      return null;
    }
    const frame = result.image;
    const bitmap = await createImageBitmap(frame);
    const duration = frameDurationMs(frame) ?? 100;
    frame.close();
    trackTotal += duration;
    frames.push({ bitmap, durationMs: duration });
  }
  decoder.close();

  if (frames.length === 0) return null;
  return { frames, totalMs: trackTotal || frames.length * 100 };
}

/**
 * Frame duration comes from the decoded frame's `duration` field (microseconds
 * in the WebCodecs API; recent typings expose it as `duration`). Older typings
 * lack the field, so read it defensively and convert µs → ms.
 */
function frameDurationMs(frame: VideoFrame): number | null {
  if (frame.duration === undefined || frame.duration === null) return null;
  return frame.duration / 1000;
}

/** Release the ImageBitmaps backing a decode result. Call on cleanup. */
export function closeGif(decode: GifDecode): void {
  for (const frame of decode.frames) frame.bitmap.close();
}
