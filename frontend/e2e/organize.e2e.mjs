/**
 * §5B menu organisation: group background colour/opacity and tags, each one
 * undoable command. Backgrounds are checked from screen pixels.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  launch,
  nodeCenter,
  openBoard,
  pixel,
  seedBoard,
  settle,
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

const layout = {
  images: [
    { name: 'a.png', x: 160, y: 220, width: 120, height: 90 },
    { name: 'b.png', x: 420, y: 220, width: 120, height: 90 },
  ],
};
const hook = (page, key) => page.evaluate((name) => window.__refthing[name], key);

test('Group Color paints a background behind the group; undo removes it', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(150);
  // A point in the padding between the two images, inside the group box.
  const nodes = (await hook(page, 'nodes')).filter((node) => node.kind !== 'note');
  const gapWorld = {
    x: (Math.min(...nodes.map((n) => n.x + n.width)) + Math.max(...nodes.map((n) => n.x))) / 2,
    y: nodes[0].y + 20,
  };
  const gap = await worldToClient(page, gapWorld);
  const before = await pixel(page, gap);
  const a = await nodeCenter(page, seeded.ids['a.png']);
  await page.mouse.click(a.x, a.y, { button: 'right' });
  await page.getByRole('menuitemradio', { name: 'Red' }).click();
  await page.waitForTimeout(150);
  await settle(page);
  const red = await pixel(page, gap);
  // Redder than before, over either theme's workspace.
  assert.ok(
    red[0] - red[2] > before[0] - before[2] + 30,
    `background not red: ${before} -> ${red}`,
  );
  assert.equal((await hook(page, 'groups'))[0].members.length, 2);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await settle(page);
  assert.deepEqual(await pixel(page, gap), before, 'undo removes the background');
});

test('Add Tag from the menu creates the tag and applies it to the whole selection', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  await page.keyboard.press('Control+a');
  const a = await nodeCenter(page, seeded.ids['a.png']);
  await page.mouse.click(a.x, a.y, { button: 'right' });
  const name = `mood ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Add Tag' }).fill(name);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const tag = (await hook(page, 'tags')).find((candidate) => candidate.name === name);
  assert.ok(tag, 'tag was created');
  const itemTags = await hook(page, 'itemTags');
  for (const id of [seeded.ids['a.png'], seeded.ids['b.png']]) {
    assert.ok((itemTags[id] ?? []).includes(tag.id), `${id} not tagged`);
  }
  // Toggling the chip off removes it from both in one undo step.
  await page.mouse.click(a.x, a.y, { button: 'right' });
  await page.getByRole('menuitemradio', { name }).click();
  await page.waitForTimeout(150);
  const cleared = await hook(page, 'itemTags');
  assert.ok(!(cleared[seeded.ids['a.png']] ?? []).includes(tag.id));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const restored = await hook(page, 'itemTags');
  assert.ok((restored[seeded.ids['b.png']] ?? []).includes(tag.id), 'undo re-applies the tag');
});
