import type { Item, Note } from '@/api/client';
import { nodeKindRegistry } from './registry';
import { type BoardNode, nodeGeometry, type SpriteNode } from './types';

/** Item → node. `isGif` comes from the blob's MIME (image/gif), not the item. */
export function itemToNode(item: Item & { blob_hash: string }, isGif: boolean): SpriteNode {
  const kind = isGif ? 'gif' : 'image';
  return {
    id: item.id,
    kind,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    zIndex: item.z_index,
    groupId: item.group_id,
    blobHash: item.blob_hash,
    capabilities: nodeKindRegistry[kind].capabilities,
    ...nodeGeometry,
  };
}

export function noteToNode(note: Note): BoardNode {
  return {
    id: note.id,
    kind: 'note',
    x: note.x,
    y: note.y,
    width: note.width,
    height: note.height,
    rotation: note.rotation,
    zIndex: note.z_index,
    groupId: null,
    capabilities: nodeKindRegistry.note.capabilities,
    ...nodeGeometry,
  };
}
