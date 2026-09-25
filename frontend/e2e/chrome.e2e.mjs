/**
 * The floating chrome (DESIGN.md): opening a board framed, drops that land
 * where they're dropped, the board switcher, popovers, theme and search.
 * Every test builds (and only ever deletes) its own boards.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  BASE_URL,
  launch,
  nodeCenter,
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

const hook = (page, key) => page.evaluate((name) => window.__refthing[name], key);

test('a board that was never framed opens fitted to its content', async () => {
  const { page, context } = session;
  // Everything left of and above the world origin: at the old default
  // camera (0,0 @ 100%) none of it would be on screen.
  const seeded = await seedBoard(context.request, {
    images: [
      { name: 'far-left.png', x: -2400, y: -1600, width: 300, height: 200 },
      { name: 'near.png', x: -600, y: -400, width: 200, height: 300 },
    ],
  });
  await openBoard(page, seeded);
  const viewport = page.viewportSize();
  for (const id of Object.values(seeded.ids)) {
    const rect = await page.evaluate((nodeId) => window.__refthing.painted(nodeId), id);
    assert.ok(rect, `${id} painted`);
    assert.ok(
      rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= viewport.width &&
        rect.y + rect.height <= viewport.height,
      `node on screen: ${JSON.stringify(rect)}`,
    );
  }
});

test('files dropped on the board land centred on the drop point', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'anchor.png', x: 0, y: 0, width: 200, height: 200 }],
  });
  await openBoard(page, seeded);
  const drop = { x: 900, y: 560 };
  await page.evaluate(async ({ x, y }) => {
    const canvas = new OffscreenCanvas(160, 100);
    const context2d = canvas.getContext('2d');
    context2d.fillStyle = '#3070c0';
    context2d.fillRect(0, 0, 160, 100);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
    const target = document.elementFromPoint(x, y);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: transfer,
        }),
      );
    }
  }, drop);
  await page.waitForFunction(() => window.__refthing.nodes.length === 2, null, {
    timeout: 15000,
  });
  await settle(page);
  const dropped = (await state(page)).nodes.find((node) => node.id !== seeded.ids['anchor.png']);
  const center = await nodeCenter(page, dropped.id);
  assert.ok(
    Math.abs(center.x - drop.x) < 3 && Math.abs(center.y - drop.y) < 3,
    `centred on the drop: ${JSON.stringify(center)}`,
  );
  assert.equal(await page.locator('.drop-overlay').count(), 0, 'drop feedback cleared');
});

test('board switcher: create, rename, and delete behind an inline confirm', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {});
  await openBoard(page, seeded);
  const name = `chrome ${Date.now()}`;

  await page.getByRole('button', { name: /^Boards/ }).click();
  await page.getByRole('textbox', { name: 'New board name' }).fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForFunction(
    (previous) => window.__refthing.boardId && window.__refthing.boardId !== previous,
    seeded.boardId,
  );
  const created = await hook(page, 'boardId');
  await assert.doesNotReject(page.getByRole('button', { name: `Boards: ${name}` }).waitFor());

  await page.getByRole('button', { name: /^Boards/ }).click();
  // The open popover focuses the current board's row, which reveals its
  // actions for the keyboard; a pointer user hovers the row.
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-current')),
    'true',
    'the current board row takes focus',
  );
  await page.locator('.board-row', { hasText: name }).hover();
  await page.getByRole('button', { name: `Rename ${name}` }).click();
  const renamed = `${name} renamed`;
  const field = page.getByRole('textbox', { name: `Rename ${name}` });
  await field.fill(renamed);
  await field.press('Enter');
  await assert.doesNotReject(page.getByRole('button', { name: `Boards: ${renamed}` }).waitFor());

  await page.locator('.board-row', { hasText: renamed }).hover();
  await page.getByRole('button', { name: `Delete ${renamed}` }).click();
  // The prompt's safe default is focused: Enter keeps the board.
  await page.keyboard.press('Enter');
  const listed = async () =>
    (await (await context.request.get(`${BASE_URL}/api/boards`)).json()).some(
      (board) => board.id === created,
    );
  assert.equal(await listed(), true, 'Keep board is the default');
  await page.locator('.board-row', { hasText: renamed }).hover();
  await page.getByRole('button', { name: `Delete ${renamed}` }).click();
  await page.getByRole('button', { name: 'Delete board' }).click();
  await page.waitForFunction((id) => window.__refthing.boardId !== id, created);
  assert.equal(await listed(), false, 'deleted on the server');
});

test('Escape closes a popover and leaves the selection alone', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150 }],
  });
  await openBoard(page, seeded);
  const a = await nodeCenter(page, seeded.ids['a.png']);
  await page.mouse.click(a.x, a.y);
  assert.deepEqual((await state(page)).selection, [seeded.ids['a.png']]);
  await page.getByRole('button', { name: /^Boards/ }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Boards' }).count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Boards' }).count(), 0, 'closed');
  assert.deepEqual((await state(page)).selection, [seeded.ids['a.png']], 'still selected');
});

test('the theme toggle restyles the chrome, persists, and never touches board pixels', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150, color: [200, 60, 40] }],
  });
  await openBoard(page, seeded);
  const inside = await worldToClient(page, { x: 300, y: 275 });
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const before = await theme();
  const imagePixel = await pixel(page, inside);
  await page
    .getByRole('button', {
      name: before === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    })
    .click();
  const after = await theme();
  assert.notEqual(after, before, 'theme flipped');
  assert.deepEqual(await pixel(page, inside), imagePixel, 'board content keeps its colours');
  await page.reload();
  await page.waitForFunction(() => window.__refthing?.boardId);
  assert.equal(await theme(), after, 'persists across a reload');
  // Put it back for the suites that follow.
  await page.evaluate(() => localStorage.removeItem('refthing.appearance'));
});

test('search lives in the context menu: it opens where you right-clicked', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150 }],
  });
  await openBoard(page, seeded);
  const field = page.getByRole('textbox', { name: 'Search board items' });
  assert.equal(await field.count(), 0, 'no search field on the board at rest');

  await page.mouse.click(900, 600, { button: 'right' });
  await page.getByRole('menuitem', { name: /^Search/ }).click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    'Search board items',
    'the field takes focus',
  );
  const panel = await page.getByRole('dialog', { name: 'Search' }).boundingBox();
  assert.ok(
    Math.abs(panel.x - 900) < 2 && Math.abs(panel.y - 600) < 2,
    `opens at the click: ${JSON.stringify(panel)}`,
  );
  await page.keyboard.press('Escape');
  assert.equal(await field.count(), 0, 'Escape closes it');

  await page.mouse.move(300, 300);
  await page.keyboard.press('Control+f');
  assert.equal(await field.count(), 1, 'Ctrl+F opens it at the cursor');
  await page.keyboard.press('Escape');
});

test('a filter that holds shows a pill with Edit and Clear once the panel closes', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150 }],
  });
  await openBoard(page, seeded);
  const pill = page.locator('.filter-pill');
  await page.keyboard.press('Control+f');
  await page.keyboard.type('nothing matches this');
  await page.waitForTimeout(400);
  assert.equal(await pill.count(), 0, 'no pill while the panel is open');
  await page.keyboard.press('Escape');
  assert.equal(await pill.count(), 1, 'the pill says the board is filtered');
  assert.match(await pill.textContent(), /nothing matches this/);
  await pill.getByRole('button', { name: 'Edit' }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'Search board items' }).inputValue(),
    'nothing matches this',
    'Edit reopens the panel with the filter',
  );
  await page.keyboard.press('Escape');
  await pill.getByRole('button', { name: 'Clear search and filters' }).click();
  assert.equal(await pill.count(), 0, 'Clear removes the filter and the pill');
});

test('the corner groups hide until the pointer comes near', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150 }],
  });
  await openBoard(page, seeded);
  const corner = page.locator('.chrome-corner').first();
  const opacity = () => corner.evaluate((element) => Number(getComputedStyle(element).opacity));
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  assert.equal(await opacity(), 0, 'hidden while the pointer is out on the board');
  await page.mouse.move(60, 40);
  await page.waitForTimeout(400);
  assert.equal(await opacity(), 1, 'revealed near the corner');
  // Leaving hides it quickly (a short grace, then a fast fade).
  await page.mouse.move(700, 500);
  await page.waitForTimeout(250);
  assert.equal(await opacity(), 0, 'gone within a quarter second of leaving');
  await page.mouse.move(60, 40);
  await page.waitForTimeout(400);

  // An open panel keeps it up even after the pointer leaves.
  await page.getByRole('button', { name: /^Boards/ }).click();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  assert.equal(await opacity(), 1, 'pinned while the board list is open');
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 500);
  await page.waitForTimeout(800);
  assert.equal(await opacity(), 0, 'hides again after');

  // A drag passing the corner never reveals it.
  await page.mouse.move(700, 500);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(60, 40, { steps: 8 });
  await page.waitForTimeout(400);
  assert.equal(await opacity(), 0, 'no reveal mid-drag');
  await page.mouse.up({ button: 'middle' });
});

test('the bottom edge stays clear: no toolbar, only a status line while working', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150 }],
  });
  await openBoard(page, seeded);
  assert.equal(await page.locator('.chrome-bottom').count(), 0, 'nothing at rest');
  assert.equal(await page.getByRole('toolbar', { name: 'View' }).count(), 0);
});

test('wheel zoom is 25% a notch by default, scaled by the speed setting', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150 }],
  });
  await openBoard(page, seeded);
  const zoomAfter = async (notches) => {
    const target = await page.evaluate(() => window.__refthing.targetViewport.zoom);
    await page.mouse.move(700, 450);
    for (let i = 0; i < notches; i += 1) await page.mouse.wheel(0, -100);
    await page.waitForFunction(
      (before) => window.__refthing.targetViewport.zoom !== before,
      target,
    );
    await page.waitForTimeout(100);
    return (await page.evaluate(() => window.__refthing.targetViewport.zoom)) / target;
  };
  // Two quick notches compound (the target zoom, not the eased one).
  const two = await zoomAfter(2);
  assert.ok(Math.abs(two - 1.25 ** 2) < 0.02, `two notches: ${two}`);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('slider', { name: 'Scroll zoom speed' }).fill('2');
  await page.keyboard.press('Escape');
  const fast = await zoomAfter(1);
  assert.ok(Math.abs(fast - 1.25 ** 2) < 0.02, `one notch at 2x: ${fast}`);
  await page.evaluate(() => localStorage.removeItem('refthing.appearance'));
});

test('right-clicking a note gives text controls; the menu stays open while styling', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    notes: [{ name: 'label', x: 300, y: 250, width: 260, height: 90, text: 'Hello **world**' }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids.label;
  const style = async () => {
    await page.waitForTimeout(400);
    const board = await (
      await context.request.get(`${BASE_URL}/api/boards/${seeded.boardId}`)
    ).json();
    const note = board.notes.find((candidate) => candidate.id === id);
    return {
      style: note.content_json.style ?? {},
      fill: note.bg_color,
      text: note.content_json.text,
    };
  };
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'Bold' }).click();
  await page.getByRole('menuitemradio', { name: 'Center' }).click();
  await page.getByRole('menuitemradio', { name: 'Serif' }).click();
  await page.getByRole('menuitemradio', { name: 'XL', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Sticky' }).click();
  assert.equal(await page.getByRole('menu').count(), 1, 'still open after five picks');
  assert.equal(
    await page.getByRole('menuitemcheckbox', { name: 'Bold' }).getAttribute('aria-checked'),
    'true',
    'the menu reflects the change',
  );
  await page.keyboard.press('Escape');
  const styled = await style();
  assert.deepEqual(styled.style, { bold: true, align: 'center', font: 'serif', size: 28 });
  assert.equal(styled.fill, '#f5e7ad');

  // Ctrl+I on the selected note; undo takes the last style change back.
  await page.mouse.click(center.x, center.y);
  await page.keyboard.press('Control+i');
  assert.equal((await style()).style.italic, true, 'Ctrl+I italicises the selected note');
  await page.keyboard.press('Control+z');
  assert.equal((await style()).style.italic, undefined, 'undo');

  // Editing: Ctrl+B wraps the selection in markdown.
  await page.mouse.dblclick(center.x, center.y);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Escape');
  assert.equal((await style()).text, '**Hello **world****', 'selection wrapped as markdown');
});
