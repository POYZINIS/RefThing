import type { BlobInfo, Item, ItemPatch, Note } from '@/api/client';
import { type Crop, FULL_CROP } from '../transform';
import { cardDetail, itemKind, POSTER_LEVELS } from './itemKind';
import { noteText } from './noteText';
import { nodeKindRegistry } from './registry';
import { type NodePatch, type NoteNode, nodeGeometry, type SpriteNode } from './types';

/** Item → node. The blob supplies gif-ness, card text and poster presence. */
export function itemToNode(
  item: Item & { blob_hash: string },
  blob: BlobInfo | undefined,
  locked = false,
): SpriteNode {
  const kind = itemKind(item, blob);
  return {
    id: item.id,
    kind,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    flipX: item.metadata.flip_x === true,
    flipY: item.metadata.flip_y === true,
    opacity: typeof item.metadata.opacity === 'number' ? item.metadata.opacity : 1,
    crop: parseCrop(item.metadata.crop),
    zIndex: item.z_index,
    groupId: item.group_id,
    locked,
    blobHash: item.blob_hash,
    label: blob?.original_filename ?? item.blob_hash.slice(0, 12),
    detail: blob ? cardDetail(blob, item.metadata.duration) : '',
    poster: !!blob && POSTER_LEVELS.some((level) => level in blob.levels),
    capabilities: nodeKindRegistry[kind].capabilities,
    ...nodeGeometry,
  };
}

export function noteToNode(note: Note): NoteNode {
  return {
    id: note.id,
    kind: 'note',
    text: noteText(note.content_json),
    bgColor: note.bg_color,
    x: note.x,
    y: note.y,
    width: note.width,
    height: note.height,
    rotation: note.rotation,
    flipX: false,
    flipY: false,
    opacity: note.opacity,
    crop: FULL_CROP,
    zIndex: note.z_index,
    groupId: null,
    locked: false,
    capabilities: nodeKindRegistry.note.capabilities,
    ...nodeGeometry,
  };
}

/**
 * Node-level patch → item wire fields. Geometry maps 1:1; flip and opacity
 * live in the item's metadata (merge-patched server-side, so pipeline keys
 * such as the palette are never touched).
 */
export function itemFields(patch: NodePatch): ItemPatch {
  const { flipX, flipY, opacity, crop, ...geometry } = patch;
  const metadata: Record<string, unknown> = {};
  // A full-image crop is stored as no crop at all (null deletes the key).
  if (crop !== undefined) metadata.crop = isFullCrop(crop) ? null : crop;
  if (flipX !== undefined) metadata.flip_x = flipX;
  if (flipY !== undefined) metadata.flip_y = flipY;
  if (opacity !== undefined) metadata.opacity = opacity;
  return Object.keys(metadata).length > 0 ? { ...geometry, metadata } : geometry;
}

/** An item with a live (uncommitted) node patch applied, for previews. */
export function itemWithPatch<T extends Item>(item: T, patch: NodePatch | undefined): T {
  if (!patch) return item;
  const { metadata, ...fields } = itemFields(patch);
  return {
    ...item,
    ...fields,
    ...(metadata ? { metadata: { ...item.metadata, ...metadata } } : {}),
  };
}

/** A note with a node patch applied (notes carry opacity natively; no flip). */
export function noteWithPatch(note: Note, patch: NodePatch | undefined): Note {
  if (!patch) return note;
  const { flipX: _flipX, flipY: _flipY, crop: _crop, ...fields } = patch;
  return { ...note, ...fields };
}

const isFullCrop = (crop: Crop) => crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1;

/** A stored crop, validated; anything malformed means the full image. */
function parseCrop(value: unknown): Crop {
  if (typeof value !== 'object' || value === null) return FULL_CROP;
  const { x, y, w, h } = value as Record<string, unknown>;
  const valid = [x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!valid) return FULL_CROP;
  const crop = { x: x as number, y: y as number, w: w as number, h: h as number };
  return crop.w > 0 &&
    crop.h > 0 &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.x + crop.w <= 1 + 1e-9 &&
    crop.y + crop.h <= 1 + 1e-9
    ? crop
    : FULL_CROP;
}
