/**
 * Plan: Shift+Space + drag snaps the moving selection's edges/centers onto
 * other nodes' (smart alignment guides), from both drag paths.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch, nodeCenter, openBoard, seedBoard, settle, state } from './harness.mjs';

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
    { name: 'a.png', x: 100, y: 200, width: 150, height: 100 },
    { name: 'b.png', x: 700, y: 420, width: 150, height: 100 },
  ],
};

async function snapDrag(page, from, to, { selectFirst }) {
  if (selectFirst) {
    await page.mouse.click(from.x, from.y);
    await settle(page);
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Shift+Space goes down after the press (a Shift press toggles selection).
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  let guidesSeen = 0;
  for (let i = 1; i <= 30; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 30, from.y + ((to.y - from.y) * i) / 30);
    await settle(page);
    guidesSeen = Math.max(guidesSeen, await page.locator('.snap-guide').count());
  }
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.keyboard.up('Shift');
  await settle(page);
  return guidesSeen;
}

for (const selectFirst of [false, true]) {
  test(`Shift+Space snaps the dragged edge onto a neighbour (${selectFirst ? 'selection shell' : 'unselected node'})`, async () => {
    const { page, context } = session;
    const seeded = await seedBoard(context.request, layout);
    await openBoard(page, seeded);
    const nodes = (await state(page)).nodes;
    const a = nodes.find((node) => node.id === seeded.ids['a.png']);
    const b = nodes.find((node) => node.id === seeded.ids['b.png']);
    const zoom = (await state(page)).viewport.zoom;
    const from = await nodeCenter(page, a.id);
    // Aim A's right edge 3 screen px short of B's left edge, and A's top a
    // little below B's top: both axes are within snapping reach.
    const dx = (b.x - (a.x + a.width)) * zoom - 3;
    const dy = (b.y - a.y) * zoom + 4;
    const guides = await snapDrag(page, from, { x: from.x + dx, y: from.y + dy }, { selectFirst });
    const moved = (await state(page)).nodes.find((node) => node.id === a.id);
    assert.ok(
      Math.abs(moved.x + moved.width - b.x) < 1e-6,
      `right edge ${moved.x + moved.width} vs ${b.x}`,
    );
    assert.ok(Math.abs(moved.y - b.y) < 1e-6, `top ${moved.y} vs ${b.y}`);
    assert.ok(guides >= 1, 'no alignment guide was shown while snapping');
    assert.equal(await page.locator('.snap-guide').count(), 0, 'guides stay after release');
  });
}
