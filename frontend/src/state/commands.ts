import type { BatchRequestOp, BoardSnapshot, Group, Item, Note } from '../api/client';
import type { BoardNode, NodeChange } from '../canvas/nodes/types';

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
    locked: false,
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

/** The groups a selection touches. */
export function selectedGroupIds(snapshot: Snapshot, ids: readonly string[]): string[] {
  return [
    ...new Set(
      snapshot.items
        .filter((item) => ids.includes(item.id) && item.group_id)
        .map((item) => item.group_id as string),
    ),
  ];
}

/** Lock / Unlock (§5B, §6 RULE 3) every group the selection touches. */
export function lockOps(
  snapshot: Snapshot,
  ids: readonly string[],
  locked: boolean,
  newId: NewId = opId,
): BatchRequestOp[] {
  return selectedGroupIds(snapshot, ids).map((groupId) => ({
    kind: 'set_group_locked',
    op_id: newId(),
    group_id: groupId,
    locked,
  }));
}

/** Group background colour/opacity (§5B / plan Phase 5) for every group the
 *  selection touches. `bgColor` null removes the background. */
export function groupStyleOps(
  snapshot: Snapshot,
  ids: readonly string[],
  bgColor: string | null,
  opacity: number,
  newId: NewId = opId,
): BatchRequestOp[] {
  return selectedGroupIds(snapshot, ids).map((groupId) => ({
    kind: 'set_group_style',
    op_id: newId(),
    group_id: groupId,
    bg_color: bgColor,
    opacity,
  }));
}

/**
 * Toggle one tag across the selected items as a single command: if every
 * selected item already has it, remove it from all; otherwise add it to the
 * ones missing it. Notes carry no tags.
 */
export function toggleTagOps(
  snapshot: Snapshot,
  ids: readonly string[],
  tagId: string,
  newId: NewId = opId,
): BatchRequestOp[] {
  const items = snapshot.items.filter((item) => ids.includes(item.id));
  const has = (itemId: string) => (snapshot.item_tags[itemId] ?? []).includes(tagId);
  const everyHas = items.length > 0 && items.every((item) => has(item.id));
  return items
    .filter((item) => everyHas || !has(item.id))
    .map((item) => ({
      kind: 'update',
      op_id: newId(),
      item_id: item.id,
      fields: everyHas ? { remove_tag_ids: [tagId] } : { add_tag_ids: [tagId] },
    }));
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

/**
 * "Restore Proportions": give items their source's aspect ratio back (items
 * ingested before Phase 11 were all placed square). The new rect keeps the
 * node's center and its longer edge, so it stays inside its old footprint;
 * the ratio is the VISIBLE one (a crop's share of the source). Nodes without
 * an intrinsic size (file cards) or already in proportion are left alone.
 */
export function restoreProportionsChanges(
  nodes: readonly Pick<BoardNode, 'id' | 'kind' | 'x' | 'y' | 'width' | 'height' | 'crop'>[],
  intrinsic: (node: { id: string }) => { width: number; height: number } | null,
): NodeChange[] {
  const changes: NodeChange[] = [];
  for (const node of nodes) {
    if (node.kind === 'note') continue;
    const source = intrinsic(node);
    if (!source || source.width <= 0 || source.height <= 0) continue;
    const ratio = (source.width * node.crop.w) / (source.height * node.crop.h);
    if (Math.abs(node.width / node.height / ratio - 1) < 0.005) continue;
    const edge = Math.max(node.width, node.height);
    const width = ratio >= 1 ? edge : edge * ratio;
    const height = ratio >= 1 ? edge / ratio : edge;
    changes.push({
      id: node.id,
      kind: 'item',
      patch: {
        x: node.x + (node.width - width) / 2,
        y: node.y + (node.height - height) / 2,
        width,
        height,
      },
    });
  }
  return changes;
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

/** What Ctrl+C / Ctrl+X captured: whole records, so they paste into any
 *  board (blobs are global, so items keep pointing at the same image). */
export type Clipboard = { items: Item[]; notes: Note[]; itemTags: Record<string, string[]> };

export function copySelection(snapshot: Snapshot, ids: readonly string[]): Clipboard {
  const wanted = new Set(ids);
  const items = snapshot.items.filter((item) => wanted.has(item.id));
  return {
    items,
    notes: snapshot.notes.filter((note) => wanted.has(note.id)),
    itemTags: Object.fromEntries(items.map((item) => [item.id, snapshot.item_tags[item.id] ?? []])),
  };
}

/**
 * Paste a clipboard centred on `at` (world px) into `snapshot`'s board: fresh
 * ids, on top of the paint order in the original relative order, ungrouped,
 * tags kept. Returns the new ids so the paste can be selected.
 */
export function pasteOps(
  snapshot: Snapshot,
  clip: Clipboard,
  at: { x: number; y: number },
  newId: NewId = opId,
  now = Date.now(),
): { ops: BatchRequestOp[]; ids: string[] } {
  const records = [...clip.items, ...clip.notes].sort((a, b) => a.z_index - b.z_index);
  if (records.length === 0) return { ops: [], ids: [] };
  const left = Math.min(...records.map((record) => record.x));
  const top = Math.min(...records.map((record) => record.y));
  const right = Math.max(...records.map((record) => record.x + record.width));
  const bottom = Math.max(...records.map((record) => record.y + record.height));
  const dx = at.x - (left + right) / 2;
  const dy = at.y - (top + bottom) / 2;
  let z = topZ(snapshot);
  const ops: BatchRequestOp[] = [];
  const ids: string[] = [];
  for (const record of records) {
    z += 1;
    const id = newId();
    ids.push(id);
    const placed = {
      id,
      board_id: snapshot.board.id,
      x: record.x + dx,
      y: record.y + dy,
      z_index: z,
      created_at: now,
      updated_at: now,
    };
    if ('content_json' in record) {
      ops.push({ kind: 'put_note', op_id: newId(), note: { ...record, ...placed } });
    } else {
      ops.push({
        kind: 'restore_item',
        op_id: newId(),
        item: { ...record, ...placed, group_id: null },
        tag_ids: clip.itemTags[record.id] ?? [],
      });
    }
  }
  return { ops, ids };
}
