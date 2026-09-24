/**
 * Groups (interaction conventions §6; testing §3 GROUPS): a group selects and
 * moves as one unit; double-click drills into a child; a locked group rejects
 * every group-level move / resize / rotate but still lets you drill in.
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
    { name: 'a.png', x: 140, y: 180, width: 160, height: 120 },
    { name: 'b.png', x: 360, y: 180, width: 160, height: 120 },
  ],
};

const path = (from, dx, dy) =>
  Array.from({ length: 30 }, (_, i) => ({
    index: i,
    timeMs: i * 16,
    x: from.x + (dx * (i + 1)) / 30,
    y: from.y + (dy * (i + 1)) / 30 + 6 * Math.sin(i / 3),
  }));

const positions = async (page) =>
  Object.fromEntries(
    (await state(page)).nodes.map((node) => [node.id, [node.x, node.y, node.width]]),
  );

const shellWidth = (page) =>
  page.evaluate(() => document.querySelector('.selection-overlay')?.getBoundingClientRect().width);

async function groupBoard(page, context, { lock = false } = {}) {
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(150);
  if (lock) {
    const a = await nodeCenter(page, seeded.ids['a.png']);
    await page.mouse.click(a.x, a.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Lock' }).click();
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Escape');
  await settle(page);
  return seeded;
}

test('drill in: double-click selects one child; it moves alone; Escape steps back out', async () => {
  const { page, context } = session;
  const seeded = await groupBoard(page, context);
  const a = await nodeCenter(page, seeded.ids['a.png']);
  const before = await positions(page);
  await page.mouse.dblclick(a.x, a.y);
  await settle(page);
  let snapshot = await state(page);
  assert.deepEqual(snapshot.selection, [seeded.ids['a.png']]);
  const child = snapshot.nodes.find((node) => node.id === seeded.ids['a.png']);
  const childWidth = child.width * snapshot.viewport.zoom;
  assert.ok(
    Math.abs((await shellWidth(page)) - childWidth) < 2,
    'drilled shell frames only the child',
  );

  await drag(page, { from: a, samples: path(a, 60, 40) });
  const after = await positions(page);
  assert.notDeepEqual(after[seeded.ids['a.png']], before[seeded.ids['a.png']], 'child moved');
  assert.deepEqual(after[seeded.ids['b.png']], before[seeded.ids['b.png']], 'mate stayed put');

  await page.keyboard.press('Escape');
  await settle(page);
  snapshot = await state(page);
  assert.equal(snapshot.drillGroupId, null, 'first Escape leaves the group');
  assert.ok((await shellWidth(page)) > childWidth + 100, 'back to group-level selection');
  await page.keyboard.press('Escape');
  await settle(page);
  assert.deepEqual((await state(page)).selection, [], 'second Escape deselects');
});

test('locked group: move, resize and rotate are all rejected; drill-in still works', async () => {
  const { page, context } = session;
  const seeded = await groupBoard(page, context, { lock: true });
  const groups = await page.evaluate(() => window.__refthing.groups);
  assert.equal(groups[0].locked, true, 'Lock from the context menu');
  const a = await nodeCenter(page, seeded.ids['a.png']);
  const before = await positions(page);

  // Move from an unselected member (canvas controller path)…
  await drag(page, { from: a, samples: path(a, 80, 50) });
  assert.deepEqual(await positions(page), before, 'locked group moved via the canvas');
  // …and from the selected shell body, with Ctrl (rotate) and at a corner.
  await drag(page, { from: a, samples: path(a, 80, 50) });
  await drag(page, { from: a, modifiers: ['Control'], samples: path(a, 0, 120) });
  const corner = await page.evaluate(() => {
    const rect = document.querySelector('.selection-overlay').getBoundingClientRect();
    return { x: rect.right, y: rect.bottom };
  });
  await drag(page, { from: corner, samples: path(corner, 60, 60) });
  assert.deepEqual(await positions(page), before, 'a locked group transformed');
  const rotations = (await state(page)).nodes.map((node) => node.rotation);
  assert.ok(
    rotations.every((r) => r === 0),
    'locked group rotated',
  );

  // Drilling in never unlocks the group, but the child itself can move.
  await page.mouse.dblclick(a.x, a.y);
  await settle(page);
  await drag(page, { from: a, samples: path(a, 50, 30) });
  const drilled = await positions(page);
  assert.notDeepEqual(drilled[seeded.ids['a.png']], before[seeded.ids['a.png']], 'child moves');
  assert.equal((await page.evaluate(() => window.__refthing.groups))[0].locked, true);

  // Unlock is one undo entry like every other command.
  await page.keyboard.press('Escape');
  await page.mouse.click(a.x + 50, a.y + 30, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Unlock' }).click();
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => window.__refthing.groups))[0].locked, false);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => window.__refthing.groups))[0].locked, true, 'undo');
});
