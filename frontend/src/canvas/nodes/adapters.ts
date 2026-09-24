import type { Item, ItemPatch, Note } from '@/api/client';
import { noteText } from './noteText';
import { nodeKindRegistry } from './registry';
import { type NodePatch, type NoteNode, nodeGeometry, type SpriteNode } from './types';

/** Item → node. `isGif` comes from the blob's MIME (image/gif), not the item. */
export function itemToNode(
  item: Item & { blob_hash: string },
  isGif: boolean,
  locked = false,
): SpriteNode {
  const kind = isGif ? 'gif' : 'image';
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
    zIndex: item.z_index,
    groupId: item.group_id,
    locked,
    blobHash: item.blob_hash,
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
  const { flipX, flipY, opacity, ...geometry } = patch;
  const metadata: Record<string, unknown> = {};
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
  const { flipX: _flipX, flipY: _flipY, ...fields } = patch;
  return { ...note, ...fields };
}
