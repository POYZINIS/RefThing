import type { BlobInfo, Item, ItemPatch, Note } from '@/api/client';
import { paletteColors, wheelState } from '@/color/items';
import { type Crop, FULL_CROP } from '../transform';
import { cardDetail, itemKind, POSTER_LEVELS } from './itemKind';
import { modelSettings } from './modelView';
import { layoutNoteDocument, noteScale, noteStyle, noteText } from './noteText';
import { nodeKindRegistry } from './registry';
import { type NodePatch, type NoteNode, nodeGeometry, type SpriteNode } from './types';

/** Item → node. The blob supplies gif-ness, card text and poster presence. */
export function itemToNode(item: Item, blob: BlobInfo | undefined, locked = false): SpriteNode {
  const kind = itemKind(item, blob);
  const hash = item.blob_hash ?? '';
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
    blobHash: hash,
    label: blob?.original_filename ?? hash.slice(0, 12),
    detail: blob ? cardDetail(blob, item.metadata.duration) : '',
    poster: !!blob && POSTER_LEVELS.some((level) => level in blob.levels),
    capabilities: nodeKindRegistry[kind].capabilities,
    ...(kind === 'model' ? { model: modelSettings(item.metadata.model) } : {}),
    ...(kind === 'palette' ? { colors: paletteColors(item.metadata) } : {}),
    ...(kind === 'colorwheel' ? { wheel: wheelState(item.metadata) } : {}),
    ...nodeGeometry,
  };
}

export function noteToNode(note: Note): NoteNode {
  return {
    id: note.id,
    kind: 'note',
    text: noteText(note.content_json),
    textScale: noteScale(note.content_json),
    style: noteStyle(note.content_json),
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

/** The height of a note's laid-out text (world px, padding included), at
 *  its own width and scale unless given. */
export function noteTextHeight(
  note: Note,
  width = note.width,
  scale = noteScale(note.content_json),
): number {
  return layoutNoteDocument(noteText(note.content_json), width, scale, noteStyle(note.content_json))
    .contentHeight;
}

/**
 * A note resized by a patch (`note` is the note before the gesture).
 * - Width never scales the text: it reflows at the new width and whatever
 *   no longer fits is truncated at the bottom.
 * - Height scales the text DOWN, and only once the box's bottom meets the
 *   text's: shrinking past it shrinks the text to just fit. Growing never
 *   scales text up (text size is the Size setting's job).
 * - Text that is already clipped keeps its size; the box moves over it.
 * Moves pass through.
 */
export function noteWithResize(note: Note, patch: NodePatch | undefined): Note {
  const next = noteWithPatch(note, patch);
  if (patch?.height === undefined || patch.height >= note.height) return next;
  const scale = noteScale(note.content_json);
  // Measured at the gesture's starting width: the vertical edge meets the
  // text as it was, so a narrowing in the same drag only truncates.
  const textHeight = noteTextHeight(note, note.width, scale);
  if (textHeight > note.height + 0.5 || patch.height >= textHeight) return next;
  // The largest scale whose text fits the new height (reflow makes the
  // height only roughly proportional to the scale, so bisect).
  let low = 0;
  let high = scale;
  for (let step = 0; step < 14; step += 1) {
    const mid = (low + high) / 2;
    if (noteTextHeight(note, note.width, mid) <= patch.height) low = mid;
    else high = mid;
  }
  if (low <= 0) return next;
  const content = (note.content_json ?? {}) as Record<string, unknown>;
  return { ...next, content_json: { ...content, scale: low } };
}
