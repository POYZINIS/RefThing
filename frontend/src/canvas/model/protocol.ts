import type { ModelSettings } from '../nodes/modelView';

/** Main thread → model worker. */
export type ToWorker =
  | {
      type: 'render';
      /** The item (one pending render per item: a newer request replaces it). */
      id: string;
      reqId: number;
      /** Where the model's bytes are (`/blob/<hash>/model`). */
      url: string;
      /** Output size, device px. */
      width: number;
      height: number;
      settings: ModelSettings;
      /** Live orbit frames jump the queue and never touch the poster cache. */
      live: boolean;
    }
  /** The item left the screen: drop its pending render, if any. */
  | { type: 'cancel'; id: string };

/** Model worker → main thread. */
export type FromWorker =
  | {
      type: 'frame';
      id: string;
      reqId: number;
      bitmap: ImageBitmap;
      /** Served from the poster cache without loading the model. */
      cached: boolean;
    }
  | { type: 'error'; id: string; reqId: number; message: string };
