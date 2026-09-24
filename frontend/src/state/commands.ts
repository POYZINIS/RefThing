import type { BatchRequestOp, BoardSnapshot, Group, Item, Note } from '../api/client';

/**
 * Board commands as pure functions: snapshot + selection → batch ops. Every
 * interactive command (keyboard, context menu) is built here and committed
 * through the one history pipeline (App.commitBoardOps → prepareCommand), so
 * each is exactly one undo entry. No I/O; unit-tested in tests/commands.
 */

type Snapshot = Pick<BoardSnapshot, 'board' | 'items' | 'notes' | 'groups' | 'item_tags'>;
type NewId = () => string;

const opId: NewId = () => crypto.randomUUID();

/** Group-aware expansion: a grouped item brings its whole group (§6 RULE 1). */
export function withGroupMates(snapshot: Snapshot, ids: readonly string[]): string[] {
  const selected = new Set(ids);
  const groups = new Set(
    snapshot.items.filter((item) => selected.has(item.id) && item.group_id).map((i) => i.group_id),
  );
  for (const item of snapshot.items)
    if (item.group_id && groups.has(item.group_id)) selected.add(item.id);
  return [...selected];
}

/**
 * Ctrl+G: put the selected items in one new group. Notes aren't groupable
 * (no group_id column); items already grouped move to the new group. Needs at
 * least two items — a group of one is not a group.
 */
export function groupOps(
  snapshot: Snapshot,
  ids: readonly string[],
  newId: NewId = opId,
  now = Date.now(),
): BatchRequestOp[] {
  const itemIds = snapshot.items.filter((item) => ids.includes(item.id)).map((item) => item.id);
  if (itemIds.length < 2) return [];
  const group: Group = {
    id: newId(),
    board_id: snapshot.board.id,
    parent_group_id: null,
    name: 'Group',
    collapsed: false,
    bg_color: null,
    opacity: 1,
    created_at: now,
  };
  return [
    { kind: 'restore_group', op_id: newId(), group },
    { kind: 'set_group', op_id: newId(), item_ids: itemIds, group_id: group.id },
  ];
}

/** Ctrl+Shift+G: dissolve every group touched by the selection. */
export function ungroupOps(
  snapshot: Snapshot,
  ids: readonly string[],
  newId: NewId = opId,
): BatchRequestOp[] {
  const groupIds = new Set(
    snapshot.items
      .filter((item) => ids.includes(item.id) && item.group_id)
      .map((item) => item.group_id as string),
  );
  const ops: BatchRequestOp[] = [];
  for (const groupId of groupIds) {
    const members = snapshot.items.filter((item) => item.group_id === groupId).map((i) => i.id);
    ops.push({ kind: 'set_group', op_id: newId(), item_ids: members, group_id: null });
    // Only empty groups can be removed — members leave first, same batch.
    const hasChildren = snapshot.groups.some((group) => group.parent_group_id === groupId);
    if (!hasChildren) ops.push({ kind: 'remove_group', op_id: newId(), group_id: groupId });
  }
  return ops;
}

/** Highest z across items AND notes — they share one paint order. */
export function topZ(snapshot: Pick<Snapshot, 'items' | 'notes'>): number {
  let max = 0;
  for (const item of snapshot.items) max = Math.max(max, item.z_index);
  for (const note of snapshot.notes) max = Math.max(max, note.z_index);
  return max;
}

function bottomZ(snapshot: Pick<Snapshot, 'items' | 'notes'>): number {
  let min = 0;
  for (const item of snapshot.items) min = Math.min(min, item.z_index);
  for (const note of snapshot.notes) min = Math.min(min, note.z_index);
  return min;
}

/** Restack the selection above (front) or below (back) everything else,
 *  keeping its internal order. */
export function restackOps(
  snapshot: Snapshot,
  ids: readonly string[],
  where: 'front' | 'back',
  now = Date.now(),
  newId: NewId = opId,
): BatchRequestOp[] {
  const chosen = [
    ...snapshot.items.filter((item) => ids.includes(item.id)),
    ...snapshot.notes.filter((note) => ids.includes(note.id)),
  ].sort((a, b) => a.z_index - b.z_index);
  const start = where === 'front' ? topZ(snapshot) + 1 : bottomZ(snapshot) - chosen.length;
  return chosen.map((node, index) => {
    const z = start + index;
    return 'content_json' in node
      ? { kind: 'put_note', op_id: newId(), note: { ...node, z_index: z, updated_at: now } }
      : { kind: 'update', op_id: newId(), item_id: node.id, fields: { z_index: z } };
  });
}

/** Offset a duplicate lands at, so it is visibly a copy (world px). */
export const DUPLICATE_OFFSET = 24;

/**
 * Duplicate (context menu — §5B's canonical menu-only action). Copies land on
 * top, offset, ungrouped, with the originals' tags. Returns the new ids so
 * the caller can select the copies.
 */
export function duplicateOps(
  snapshot: Snapshot,
  ids: readonly string[],
  newId: NewId = opId,
  now = Date.now(),
): { ops: BatchRequestOp[]; ids: string[] } {
  let z = topZ(snapshot);
  const ops: BatchRequestOp[] = [];
  const created: string[] = [];
  const items = snapshot.items.filter((item) => ids.includes(item.id));
  const notes = snapshot.notes.filter((note) => ids.includes(note.id));
  for (const source of [...items, ...notes].sort((a, b) => a.z_index - b.z_index)) {
    z += 1;
    const id = newId();
    created.push(id);
    const geometry = {
      id,
      x: source.x + DUPLICATE_OFFSET,
      y: source.y + DUPLICATE_OFFSET,
      z_index: z,
      created_at: now,
      updated_at: now,
    };
    if ('content_json' in source) {
      const note: Note = { ...source, ...geometry };
      ops.push({ kind: 'put_note', op_id: newId(), note });
    } else {
      const item: Item = { ...source, ...geometry, group_id: null };
      ops.push({
        kind: 'restore_item',
        op_id: newId(),
        item,
        tag_ids: snapshot.item_tags[source.id] ?? [],
      });
    }
  }
  return { ops, ids: created };
}

export type WorldRect = { left: number; top: number; right: number; bottom: number };

/**
 * Camera that fits `bounds` into a `width`×`height` viewport with a margin
 * (double-click empty canvas / "Zoom to Fit"). Zoom is clamped to the
 * canvas's own range.
 */
export function fitViewport(
  bounds: WorldRect | null,
  width: number,
  height: number,
  margin = 48,
  zoomRange: [number, number] = [0.1, 4],
): { x: number; y: number; zoom: number } | null {
  if (!bounds || width <= 0 || height <= 0) return null;
  const boundsWidth = Math.max(1, bounds.right - bounds.left);
  const boundsHeight = Math.max(1, bounds.bottom - bounds.top);
  const zoom = Math.min(
    zoomRange[1],
    Math.max(
      zoomRange[0],
      Math.min((width - margin * 2) / boundsWidth, (height - margin * 2) / boundsHeight),
    ),
  );
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return { x: width / 2 - centerX * zoom, y: height / 2 - centerY * zoom, zoom };
}

/** Union of rects, or null for none. */
export function unionRect(rects: WorldRect[]): WorldRect | null {
  if (rects.length === 0) return null;
  return rects.reduce((union, rect) => ({
    left: Math.min(union.left, rect.left),
    top: Math.min(union.top, rect.top),
    right: Math.max(union.right, rect.right),
    bottom: Math.max(union.bottom, rect.bottom),
  }));
}
