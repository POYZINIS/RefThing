/**
 * §3 FLIP (Alt+Shift+drag) and §5B Adjust Opacity, verified from real screen
 * pixels, each one undo entry.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  drag,
  launch,
  openBoard,
  pixel,
  seedBoard,
  settle,
  state,
  worldToClient,
} from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

const RED = [220, 30, 30];
const BLUE = [30, 60, 220];
const layout = {
  images: [{ name: 'split.png', x: 150, y: 200, width: 240, height: 160, color: RED, right: BLUE }],
};
const isRed = ([r, , b]) => r > 180 && b < 90;
const isBlue = ([r, , b]) => b > 180 && r < 90;

test('Alt+Shift+horizontal drag mirrors the image left↔right; undo restores', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const leftSide = await worldToClient(page, { x: 190, y: 280 });
  const center = await worldToClient(page, { x: 270, y: 280 });
  assert.ok(isRed(await pixel(page, leftSide)), 'left half starts red');
  await page.mouse.click(center.x, center.y);
  await settle(page);
  const depth = (await state(page)).undoDepth;
  await drag(page, {
    from: center,
    modifiers: ['Alt', 'Shift'],
    samples: Array.from({ length: 30 }, (_, i) => ({
      index: i,
      timeMs: i * 16,
      x: center.x + 2 * (i + 1),
      y: center.y + Math.sin(i / 4),
    })),
  });
  await page.waitForTimeout(100);
  assert.ok(isBlue(await pixel(page, leftSide)), 'left half is blue after the flip');
  const node = (await state(page)).nodes.find((n) => n.id === seeded.ids['split.png']);
  assert.deepEqual([node.x, node.y], [150, 200], 'a flip does not move the item');
  assert.equal((await state(page)).undoDepth, depth + 1);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.ok(isRed(await pixel(page, leftSide)), 'undo un-flips');
});

test('context menu Opacity 50% fades the image; undo restores full opacity', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const leftSide = await worldToClient(page, { x: 190, y: 280 });
  const opaque = await pixel(page, leftSide);
  await page.mouse.click(leftSide.x, leftSide.y, { button: 'right' });
  await page.getByRole('menuitemradio', { name: '50%' }).click();
  await page.waitForTimeout(150);
  const faded = await pixel(page, leftSide);
  assert.ok(faded[0] < opaque[0] - 60, `red channel should drop (was ${opaque}, now ${faded})`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.deepEqual(await pixel(page, leftSide), opaque);
});

test('Crop: dragging the right edge in hides the right half; content stays put', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const id = seeded.ids['split.png'];
  const node = (await state(page)).nodes.find((candidate) => candidate.id === id);
  const leftSide = await worldToClient(page, {
    x: node.x + node.width * 0.2,
    y: node.y + node.height / 2,
  });
  const rightSide = await worldToClient(page, {
    x: node.x + node.width * 0.8,
    y: node.y + node.height / 2,
  });
  assert.ok(isBlue(await pixel(page, rightSide)), 'right half starts blue');
  await page.mouse.click(leftSide.x, leftSide.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Crop' }).click();
  await settle(page);
  assert.equal(await page.evaluate(() => window.__refthing.cropNodeId), id, 'crop mode on');
  const edge = await worldToClient(page, {
    x: node.x + node.width - 1,
    y: node.y + node.height / 2,
  });
  const zoom = (await state(page)).viewport.zoom;
  await drag(page, {
    from: edge,
    samples: Array.from({ length: 30 }, (_, i) => ({
      index: i,
      timeMs: i * 16,
      x: edge.x - ((node.width / 2) * zoom * (i + 1)) / 30,
      y: edge.y + 8 * Math.sin(i / 3), // along-edge wobble must not matter
    })),
  });
  await page.waitForTimeout(150);
  await settle(page);
  const cropped = (await state(page)).nodes.find((candidate) => candidate.id === id);
  assert.ok(Math.abs(cropped.width - node.width / 2) < 1, `width ${cropped.width}`);
  assert.equal(cropped.height, node.height, 'a right-edge crop keeps the height');
  assert.ok(Math.abs(cropped.crop.w - 0.5) < 0.01, JSON.stringify(cropped.crop));
  assert.ok(isRed(await pixel(page, leftSide)), 'content did not move: left is still red');
  assert.ok(!isBlue(await pixel(page, rightSide)), 'the blue half is cropped away');

  await page.keyboard.press('Enter');
  assert.equal(
    await page.evaluate(() => window.__refthing.cropNodeId),
    null,
    'Enter ends cropping',
  );
  await page.mouse.click(leftSide.x, leftSide.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset Crop' }).click();
  await page.waitForTimeout(150);
  await settle(page);
  const reset = (await state(page)).nodes.find((candidate) => candidate.id === id);
  assert.deepEqual(
    [reset.x, reset.y, reset.width, reset.height].map(Math.round),
    [node.x, node.y, node.width, node.height].map(Math.round),
  );
  assert.ok(isBlue(await pixel(page, rightSide)), 'reset brings the blue half back');
});
