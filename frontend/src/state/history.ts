import type {
  BatchOp,
  BatchRequestOp,
  BoardSnapshot,
  Group,
  Item,
  ItemPatch,
  Note,
} from '../api/client';

export interface HistoryEntry {
  label: string;
  forward: BatchRequestOp[];
  inverse: BatchRequestOp[];
}

const opId = () => crypto.randomUUID();
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * RFC 7396 JSON merge patch — the server's semantics for `metadata` updates
 * (SQLite json_patch): named keys are set, `null` deletes, the rest is kept.
 */
export function mergePatch(target: Json, patch: Json): Json {
  const result: Json = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isObject(value))
      result[key] = mergePatch(isObject(result[key]) ? result[key] : {}, value);
    else result[key] = value;
  }
  return result;
}

/** The merge patch that undoes `patch` applied to `target`: every key the
 *  patch names goes back to its old value, or `null` if it didn't exist. */
function inverseMergePatch(target: Json, patch: Json): Json {
  const inverse: Json = {};
  for (const key of Object.keys(patch)) {
    inverse[key] = key in target ? target[key] : null;
  }
  return inverse;
}

/** An item with an update's fields applied (metadata merges, never replaces). */
function applyItemFields(item: Item, fields: Omit<ItemPatch, 'add_tag_ids' | 'remove_tag_ids'>) {
  const { metadata, ...rest } = fields;
  return {
    ...item,
    ...rest,
    ...(metadata ? { metadata: mergePatch(item.metadata, metadata) } : {}),
  };
}

/** A history entry retains only changed fields/deleted records, never a board copy. */
export function prepareCommand(
  snapshot: BoardSnapshot,
  requested: BatchRequestOp[],
  label: string,
): HistoryEntry {
  const items = new Map(snapshot.items.map((item) => [item.id, item]));
  const notes = new Map(snapshot.notes.map((note) => [note.id, note]));
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  const tags = new Map(Object.entries(snapshot.item_tags));
  const forward: BatchRequestOp[] = [];
  const undoGroups: BatchRequestOp[][] = [];
  for (const op of requested) {
    const undo: BatchRequestOp[] = [];
    switch (op.kind) {
      case 'move':
        if (op.dx === 0 && op.dy === 0) continue;
        for (const id of op.item_ids) {
          const item = items.get(id);
          if (!item) throw new Error('An item in this command no longer exists');
          items.set(id, { ...item, x: item.x + op.dx, y: item.y + op.dy });
        }
        undo.push({ ...op, op_id: opId(), dx: -op.dx, dy: -op.dy });
        break;
      case 'update': {
        const item = items.get(op.item_id);
        if (!item) throw new Error('An item in this command no longer exists');
        const { add_tag_ids = [], remove_tag_ids = [], ...fields } = op.fields;
        const previous: ItemPatch = {};
        for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
          if (key === 'metadata') continue;
          if (!equal(item[key], fields[key])) Object.assign(previous, { [key]: item[key] });
        }
        if (fields.metadata && !equal(mergePatch(item.metadata, fields.metadata), item.metadata)) {
          previous.metadata = inverseMergePatch(item.metadata, fields.metadata);
        }
        const oldTags = new Set(tags.get(item.id) ?? []);
        const newTags = new Set(oldTags);
        for (const id of remove_tag_ids) newTags.delete(id);
        for (const id of add_tag_ids) newTags.add(id);
        const restoreTags = [...oldTags].filter((id) => !newTags.has(id));
        const removeTags = [...newTags].filter((id) => !oldTags.has(id));
        if (restoreTags.length) previous.add_tag_ids = restoreTags;
        if (removeTags.length) previous.remove_tag_ids = removeTags;
        if (!Object.keys(previous).length) continue;
        const { group_id, ...patch } = previous;
        if (Object.keys(patch).length)
          undo.push({ kind: 'update', op_id: opId(), item_id: item.id, fields: patch });
        if (group_id !== undefined)
          undo.push({ kind: 'set_group', op_id: opId(), item_ids: [item.id], group_id });
        items.set(item.id, applyItemFields(item, fields));
        tags.set(item.id, [...newTags]);
        break;
      }
      case 'delete':
        for (const id of op.item_ids) {
          const item = items.get(id);
          if (!item) throw new Error('An item in this command no longer exists');
          undo.push({ kind: 'restore_item', op_id: opId(), item, tag_ids: tags.get(id) ?? [] });
          items.delete(id);
          tags.delete(id);
        }
        break;
      case 'set_group':
        for (const id of op.item_ids) {
          const item = items.get(id);
          if (!item) throw new Error('An item in this command no longer exists');
          if (item.group_id === op.group_id) continue;
          undo.push({ kind: 'set_group', op_id: opId(), item_ids: [id], group_id: item.group_id });
          items.set(id, { ...item, group_id: op.group_id });
        }
        break;
      case 'set_z':
        op.order.forEach((id, index) => {
          const item = items.get(id);
          if (!item) throw new Error('An item in this command no longer exists');
          if (item.z_index === index) return;
          undo.push({
            kind: 'update',
            op_id: opId(),
            item_id: id,
            fields: { z_index: item.z_index },
          });
          items.set(id, { ...item, z_index: index });
        });
        break;
      case 'restore_item':
        if (items.has(op.item.id)) throw new Error('An item with this identity already exists');
        undo.push({ kind: 'delete', op_id: opId(), item_ids: [op.item.id] });
        items.set(op.item.id, op.item);
        tags.set(op.item.id, op.tag_ids);
        break;
      case 'put_note': {
        const note = notes.get(op.note.id);
        if (equal(note, op.note)) continue;
        undo.push(
          note
            ? { kind: 'put_note', op_id: opId(), note }
            : { kind: 'delete_notes', op_id: opId(), note_ids: [op.note.id] },
        );
        notes.set(op.note.id, op.note);
        break;
      }
      case 'delete_notes':
        for (const id of op.note_ids) {
          const note = notes.get(id);
          if (!note) throw new Error('A note in this command no longer exists');
          undo.push({ kind: 'put_note', op_id: opId(), note });
          notes.delete(id);
        }
        break;
      case 'restore_group':
        if (groups.has(op.group.id)) throw new Error('A group with this identity already exists');
        undo.push({ kind: 'remove_group', op_id: opId(), group_id: op.group.id });
        groups.set(op.group.id, op.group);
        break;
      case 'remove_group': {
        const group = groups.get(op.group_id);
        if (!group) throw new Error('This group no longer exists');
        undo.push({ kind: 'restore_group', op_id: opId(), group });
        groups.delete(group.id);
        break;
      }
      case 'set_group_style': {
        const group = groups.get(op.group_id);
        if (!group) throw new Error('This group no longer exists');
        if (group.bg_color === op.bg_color && group.opacity === op.opacity) continue;
        undo.push({ ...op, op_id: opId(), bg_color: group.bg_color, opacity: group.opacity });
        groups.set(group.id, { ...group, bg_color: op.bg_color, opacity: op.opacity });
        break;
      }
      case 'set_group_locked': {
        const group = groups.get(op.group_id);
        if (!group) throw new Error('This group no longer exists');
        if (group.locked === op.locked) continue;
        undo.push({ ...op, op_id: opId(), locked: group.locked });
        groups.set(group.id, { ...group, locked: op.locked });
        break;
      }
    }
    if (undo.length) {
      forward.push(op);
      undoGroups.push(undo);
    }
  }
  return { label, forward, inverse: undoGroups.reverse().flat() };
}

/** One indexed pass per acknowledged batch, including recovery event variants. */
export function applyBoardOps(
  snapshot: BoardSnapshot,
  ops: BatchOp[],
  seq = snapshot.seq,
): BoardSnapshot {
  const items = new Map<string, Item>(snapshot.items.map((item) => [item.id, item]));
  const notes = new Map<string, Note>(snapshot.notes.map((note) => [note.id, note]));
  const groups = new Map<string, Group>(snapshot.groups.map((group) => [group.id, group]));
  const itemTags = { ...snapshot.item_tags };
  for (const op of ops) {
    switch (op.kind) {
      case 'move':
        for (const id of op.item_ids) {
          const item = items.get(id);
          if (item) items.set(id, { ...item, x: item.x + op.dx, y: item.y + op.dy });
        }
        break;
      case 'update': {
        const item = items.get(op.item_id);
        if (!item) break;
        const { add_tag_ids = [], remove_tag_ids = [], ...fields } = op.fields;
        items.set(item.id, applyItemFields(item, fields));
        const tags = new Set(itemTags[item.id] ?? []);
        for (const id of remove_tag_ids) tags.delete(id);
        for (const id of add_tag_ids) tags.add(id);
        if (tags.size) itemTags[item.id] = [...tags];
        else delete itemTags[item.id];
        break;
      }
      case 'delete':
        for (const id of op.item_ids) {
          items.delete(id);
          delete itemTags[id];
        }
        break;
      case 'set_group':
        for (const id of op.item_ids) {
          const item = items.get(id);
          if (item) items.set(id, { ...item, group_id: op.group_id });
        }
        break;
      case 'set_z':
        op.order.forEach((id, z_index) => {
          const item = items.get(id);
          if (item) items.set(id, { ...item, z_index });
        });
        break;
      case 'create':
        items.set(op.item.id, op.item);
        break;
      case 'restore_item':
        items.set(op.item.id, op.item);
        if (op.tag_ids.length) itemTags[op.item.id] = op.tag_ids;
        break;
      case 'put_note':
      case 'create_note':
      case 'update_note':
        notes.set(op.note.id, op.note);
        break;
      case 'delete_notes':
        for (const id of op.note_ids) notes.delete(id);
        break;
      case 'delete_note':
        notes.delete(op.id);
        break;
      case 'restore_group':
      case 'create_group':
      case 'update_group':
        groups.set(op.group.id, op.group);
        break;
      case 'remove_group':
        groups.delete(op.group_id);
        break;
      case 'set_group_locked': {
        const group = groups.get(op.group_id);
        if (group) groups.set(group.id, { ...group, locked: op.locked });
        break;
      }
      case 'set_group_style': {
        const group = groups.get(op.group_id);
        if (group) groups.set(group.id, { ...group, bg_color: op.bg_color, opacity: op.opacity });
        break;
      }
      case 'delete_group': {
        const removed = new Set([op.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const group of groups.values()) {
            if (
              group.parent_group_id &&
              removed.has(group.parent_group_id) &&
              !removed.has(group.id)
            ) {
              removed.add(group.id);
              changed = true;
            }
          }
        }
        for (const id of removed) groups.delete(id);
        for (const item of items.values()) {
          if (item.group_id && removed.has(item.group_id))
            items.set(item.id, { ...item, group_id: null });
        }
        break;
      }
    }
  }
  return {
    ...snapshot,
    board: { ...snapshot.board, seq },
    seq,
    items: [...items.values()].sort((a, b) => a.z_index - b.z_index),
    notes: [...notes.values()].sort((a, b) => a.z_index - b.z_index),
    groups: [...groups.values()],
    item_tags: itemTags,
  };
}
