/**
 * Keyboard map (plan: KEYBOARD) and the §5B context menu, end to end: each
 * command is one undo entry and undo restores the board exactly.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { drag, launch, nodeCenter, openBoard, seedBoard, settle, state } from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

const layout = {
  images: [
    { name: 'a.png', x: 120, y: 160, width: 160, height: 120 },
    { name: 'b.png', x: 340, y: 160, width: 160, height: 120 },
  ],
  notes: [{ name: 'n', x: 560, y: 160, width: 180, height: 120, text: 'note' }],
};

const geometry = (snapshot) =>
  Object.fromEntries(snapshot.nodes.map((node) => [node.id, [node.x, node.y, node.zIndex]]));

async function selectAll(page) {
  await page.keyboard.press('Control+a');
  await settle(page);
}

test('Ctrl+A selects every node; Ctrl+G groups, Ctrl+Shift+G ungroups, both undoable', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  await selectAll(page);
  assert.equal((await state(page)).selection.length, 3, 'Ctrl+A');
  const depth = (await state(page)).undoDepth;
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(150);
  const grouped = await page.evaluate(() => window.__refthing.groups);
  assert.equal(grouped.length, 1, 'one group');
  assert.equal(grouped[0].members.length, 2, 'the two images (notes are not groupable)');
  assert.equal((await state(page)).undoDepth, depth + 1);

  // Clicking one member now frames the whole group (§6 RULE 1).
  await page.keyboard.press('Escape');
  const a = await nodeCenter(page, seeded.ids['a.png']);
  await page.mouse.click(a.x, a.y);
  await settle(page);
  const shell = await page.evaluate(
    () => document.querySelector('.selection-overlay').getBoundingClientRect().width,
  );
  assert.ok(shell > 350, `group shell spans both images (width ${shell})`);

  await page.keyboard.press('Control+Shift+g');
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => window.__refthing.groups)).length, 0, 'ungrouped');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => window.__refthing.groups)).length, 1, 'undo ungroup');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => window.__refthing.groups)).length, 0, 'undo group');
});

test('held arrow keys nudge in screen px and coalesce into ONE undo entry', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const id = seeded.ids['a.png'];
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await settle(page);
  const start = await state(page);
  const before = start.nodes.find((node) => node.id === id);
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(150);
  const moved = await state(page);
  const node = moved.nodes.find((candidate) => candidate.id === id);
  const zoom = moved.viewport.zoom;
  assert.ok(Math.abs(node.x - before.x - 5 / zoom) < 1e-6, `x moved ${node.x - before.x}`);
  assert.ok(Math.abs(node.y - before.y - 10 / zoom) < 1e-6, `y moved ${node.y - before.y}`);
  assert.equal(moved.undoDepth, start.undoDepth + 1, 'a burst of nudges is one entry');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const undone = (await state(page)).nodes.find((candidate) => candidate.id === id);
  assert.deepEqual([undone.x, undone.y], [before.x, before.y]);
});

test('right-click menu: Duplicate copies the selection on top; Delete + undo restore', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const id = seeded.ids['a.png'];
  const center = await nodeCenter(page, id);
  // Right-click an UNSELECTED node retargets the selection to it.
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await settle(page);
  assert.deepEqual((await state(page)).selection, [id]);
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.waitForTimeout(150);
  const afterDuplicate = await state(page);
  assert.equal(afterDuplicate.nodes.length, 4, 'one copy');
  const copyId = afterDuplicate.selection[0];
  assert.notEqual(copyId, id, 'the copy is selected');
  const copy = afterDuplicate.nodes.find((node) => node.id === copyId);
  const original = afterDuplicate.nodes.find((node) => node.id === id);
  assert.deepEqual([copy.x - original.x, copy.y - original.y], [24, 24]);
  assert.ok(
    afterDuplicate.nodes.every((node) => node.id === copyId || node.zIndex < copy.zIndex),
    'the copy paints on top',
  );

  const snapshotBefore = geometry(afterDuplicate);
  const copyCenter = await nodeCenter(page, copyId);
  await page.mouse.click(copyCenter.x, copyCenter.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.waitForTimeout(150);
  assert.equal((await state(page)).nodes.length, 3);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const restored = geometry(await state(page));
  assert.deepEqual(restored[copyId].slice(0, 2), snapshotBefore[copyId].slice(0, 2));
});

test('a right-DRAG does not open the menu; a right-click on empty canvas adds a note there', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const empty = await nodeCenter(page, seeded.ids['a.png']);
  const spot = { x: empty.x, y: empty.y + 300 };
  await drag(page, {
    from: spot,
    button: 'right',
    samples: Array.from({ length: 30 }, (_, i) => ({
      index: i,
      timeMs: i * 16,
      x: spot.x + (i + 1),
      y: spot.y,
    })),
  });
  assert.equal(await page.getByRole('menu').count(), 0, 'right-drag opened the menu');
  await page.mouse.click(spot.x, spot.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add Note' }).click();
  await page.waitForTimeout(150);
  const after = await state(page);
  const added = after.nodes.find((node) => node.id === after.selection[0]);
  assert.equal(added.kind, 'note');
  const world = await page.evaluate(({ x, y }) => {
    const host = document.getElementById('canvas-host').getBoundingClientRect();
    const view = window.__refthing.viewport;
    return { x: (x - host.left - view.x) / view.zoom, y: (y - host.top - view.y) / view.zoom };
  }, spot);
  assert.ok(Math.abs(added.x - world.x) < 1 && Math.abs(added.y - world.y) < 1, 'at the cursor');
});

test('double-click: empty canvas zooms to fit; an image zooms in, again returns', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const a = await nodeCenter(page, seeded.ids['a.png']);
  await page.mouse.dblclick(a.x, a.y);
  await page.waitForTimeout(700);
  const zoomed = (await state(page)).viewport;
  assert.ok(zoomed.zoom > 2, `zoomed onto the image (zoom ${zoomed.zoom})`);
  const again = await nodeCenter(page, seeded.ids['a.png']);
  await page.mouse.dblclick(again.x, again.y);
  await page.waitForTimeout(700);
  assert.ok(Math.abs((await state(page)).viewport.zoom - 1) < 0.01, 'second double-click returns');

  const host = await page.evaluate(() => {
    const rect = document.getElementById('canvas-host').getBoundingClientRect();
    return { x: rect.left + rect.width - 40, y: rect.top + rect.height - 40 };
  });
  await page.mouse.dblclick(host.x, host.y);
  await page.waitForTimeout(700);
  // Everything fits: every painted node lies inside the canvas.
  const inside = await page.evaluate(() => {
    const hook = window.__refthing;
    const rect = document.getElementById('canvas-host').getBoundingClientRect();
    return hook.nodes.every((node) => {
      const painted = hook.painted(node.id);
      return (
        painted &&
        painted.x >= rect.left - 1 &&
        painted.y >= rect.top - 1 &&
        painted.x + painted.width <= rect.right + 1 &&
        painted.y + painted.height <= rect.bottom + 1
      );
    });
  });
  assert.ok(inside, 'zoom to fit left a node off-screen');
});
