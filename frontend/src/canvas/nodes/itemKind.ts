import type { BlobInfo, Item } from '@/api/client';
import { features } from '@/features';
import type { SpriteKind } from './types';

/**
 * How an item draws. The item's `type` (set by the server's type handler)
 * picks the family; the blob refines it (image/gif animates). A media type
 * whose feature flag is off degrades to a plain file card.
 */
export function itemKind(item: Pick<Item, 'type'>, blob: BlobInfo | undefined): SpriteKind {
  switch (item.type) {
    case 'image':
      return blob?.mime_type === 'image/gif' ? 'gif' : 'image';
    case 'video':
      return features.video ? 'video' : 'file';
    case 'audio':
      return features.audio ? 'audio' : 'file';
    case 'model':
      return features.model ? 'model' : 'file';
    case 'palette':
      return 'palette';
    case 'colorwheel':
      return 'colorwheel';
    default:
      return 'file';
  }
}

/** Poster pyramid levels (the server never makes `full` for a poster). */
export const POSTER_LEVELS = ['thumb', 'small', 'medium'];

/** "MP4 · 12.4 MB · 0:14" — the card's second line. */
export function cardDetail(blob: BlobInfo, duration: unknown): string {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(blob.original_filename ?? '')?.[1];
  const subtype = blob.mime_type.split('/')[1]?.split(/[;+]/)[0];
  const parts = [(extension ?? subtype ?? 'file').toUpperCase(), formatBytes(blob.byte_size)];
  if (typeof duration === 'number' && Number.isFinite(duration))
    parts.push(formatDuration(duration));
  return parts.join(' · ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Seconds → m:ss (h:mm:ss past an hour). */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
