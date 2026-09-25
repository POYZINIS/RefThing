/**
 * Plan: "CONTROL SCHEME AS CONFIG". A bindings.toml in the data folder
 * rebinds keys, presses and gesture roles without touching code.
 *
 * The override file is stack-wide state: this suite relies on the files
 * running one at a time (`npm run test:e2e` passes --test-concurrency=1).
 */
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { drag, launch, nodeCenter, openBoard, seedBoard, settle, state } from './harness.mjs';

const dataDir = process.env.E2E_DATA_DIR;
const file = dataDir ? join(dataDir, 'bindings.toml') : null;

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  if (file) rmSync(file, { force: true });
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

test('bindings.toml rebinds undo and swaps the move modifier roles', { skip: !file }, async () => {
  writeFileSync(
    file,
    `
[keys.undo]
key = "u"

# Alt now locks the move axis (constrain), Shift does nothing special.
[gesture]
constrain = ["alt"]
center = ["shift"]

[actions.move_selection]
button = "left"
target = "selection"
optional = ["alt"]

[actions.reset_aspect]
button = "left"
modifiers = ["ctrl"]
target = "selection"
`,
  );
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 120, height: 90 }],
  });
  await openBoard(page, seeded); // loads the override on app start
  const id = seeded.ids['a.png'];
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await settle(page);
  const start = (await state(page)).nodes.find((node) => node.id === id);

  // Alt + diagonal drag on the selection → axis-locked (constrain role).
  await drag(page, {
    from: center,
    modifiers: ['Alt'],
    samples: Array.from({ length: 30 }, (_, i) => ({
      index: i,
      timeMs: i * 16,
      x: center.x + 4 * (i + 1),
      y: center.y + 1.5 * (i + 1),
    })),
  });
  const moved = (await state(page)).nodes.find((node) => node.id === id);
  assert.ok(moved.x > start.x + 50, 'moved horizontally');
  assert.equal(moved.y, start.y, 'Alt (rebound to constrain) locked the axis');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal(
    (await state(page)).nodes.find((node) => node.id === id).x,
    moved.x,
    'Ctrl+Z is no longer undo',
  );
  await page.keyboard.press('u');
  await page.waitForTimeout(150);
  assert.equal((await state(page)).nodes.find((node) => node.id === id).x, start.x, 'u undoes');
});
