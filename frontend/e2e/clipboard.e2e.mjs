/**
 * Phase 10 muscle memory: Ctrl+C / Ctrl+X / Ctrl+V for board items (pasted
 * centred on the cursor, into any board) and Z + drag zoom.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  launch,
  nodeCenter,
  openBoard,
  seedBoard,
  settle,
  state,
  switchBoard,
} from './harness.mjs';

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
    { name: 'a.png', x: 150, y: 180, width: 120, height: 90 },
    { name: 'b.png', x: 330, y: 180, width: 120, height: 90 },
  ],
  notes: [{ name: 'n', x: 150, y: 400, width: 200, height: 100, text: 'copy me' }],
};

test('copy → paste at the cursor; cut removes; each is one undo step', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  const cursor = await page.evaluate(() => {
    const rect = document.getElementById('canvas-host').getBoundingClientRect();
    return { x: rect.left + rect.width - 250, y: rect.top + rect.height - 200 };
  });
  await page.mouse.move(cursor.x, cursor.y);
  const depth = (await state(page)).undoDepth;
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(200);
  await settle(page);
  const pasted = await state(page);
  assert.equal(pasted.nodes.length, 6, 'three copies added');
  assert.equal(pasted.selection.length, 3, 'the paste is selected');
  assert.equal(pasted.undoDepth, depth + 1);
  const copies = pasted.nodes.filter((node) => pasted.selection.includes(node.id));
  const world = await page.evaluate(({ x, y }) => {
    const host = document.getElementById('canvas-host').getBoundingClientRect();
    const view = window.__refthing.viewport;
    return { x: (x - host.left - view.x) / view.zoom, y: (y - host.top - view.y) / view.zoom };
  }, cursor);
  const cx =
    (Math.min(...copies.map((n) => n.x)) + Math.max(...copies.map((n) => n.x + n.width))) / 2;
  const cy =
    (Math.min(...copies.map((n) => n.y)) + Math.max(...copies.map((n) => n.y + n.height))) / 2;
  assert.ok(Math.abs(cx - world.x) < 1 && Math.abs(cy - world.y) < 1, 'centred on the cursor');

  // Cut the pasted copies: gone, and undo brings them back.
  await page.keyboard.press('Control+x');
  await page.waitForTimeout(150);
  assert.equal((await state(page)).nodes.length, 3);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal((await state(page)).nodes.length, 6);
});

test('paste into a different board keeps the images (blobs are global)', async () => {
  const { page, context } = session;
  const source = await seedBoard(context.request, layout);
  const target = await seedBoard(context.request, {});
  await openBoard(page, source);
  const a = await nodeCenter(page, source.ids['a.png']);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.press('Control+c');
  await switchBoard(page, target);
  await page.mouse.move(700, 500);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(300);
  await settle(page);
  const nodes = (await state(page)).nodes;
  assert.equal(nodes.length, 1);
  assert.ok(
    await page.evaluate((id) => window.__refthing.painted(id) !== null, nodes[0].id),
    'the pasted image is painted',
  );
});

test('Z + drag zooms around the press point', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const a = await nodeCenter(page, seeded.ids['a.png']);
  const initial = await state(page);
  const before = initial.viewport;
  const start = initial.nodes.find((node) => node.id === seeded.ids['a.png']);
  await page.keyboard.down('z');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i += 1) await page.mouse.move(a.x + i * 4, a.y - i * 2);
  await page.mouse.up();
  await page.keyboard.up('z');
  await page.waitForTimeout(700);
  const after = await state(page);
  assert.ok(after.viewport.zoom > before.zoom * 1.5, `zoomed in (${after.viewport.zoom})`);
  const stillUnder = await nodeCenter(page, seeded.ids['a.png']);
  assert.ok(
    Math.hypot(stillUnder.x - a.x, stillUnder.y - a.y) < 2,
    'the pressed point stays under the press position',
  );
  const moved = after.nodes.find((node) => node.id === seeded.ids['a.png']);
  assert.deepEqual([moved.x, moved.y], [start.x, start.y], 'Z+drag never moves the item');
});
