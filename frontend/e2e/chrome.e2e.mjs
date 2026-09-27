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

test('the theme setting restyles the chrome, persists, and never touches board pixels', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'a.png', x: 200, y: 200, width: 200, height: 150, color: [200, 60, 40] }],
  });
  await openBoard(page, seeded);
  const inside = await worldToClient(page, { x: 300, y: 275 });
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const before = await theme();
  const imagePixel = await pixel(page, inside);
  // The theme lives in Settings (the corner button is the colour wheel).
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Theme').selectOption(before === 'dark' ? 'light' : 'dark');
  await page.keyboard.press('Escape');
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

test('added things are sized to the camera: the same on screen at any zoom', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'anchor.png', x: 0, y: 0, width: 200, height: 200 }],
  });
  await openBoard(page, seeded);
  // Zoom far out.
  await page.mouse.move(700, 450);
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 100);
  await page.waitForTimeout(800);
  const zoom = await page.evaluate(() => window.__refthing.viewport.zoom);
  assert.ok(zoom < 0.1, `zoomed out: ${zoom}`);

  // A note from the menu: 280 px wide on screen, whatever the zoom.
  await page.mouse.click(500, 400, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add Note' }).click();
  await page.waitForTimeout(300);
  const noteId = (await state(page)).selection[0];
  const note = await page.evaluate((id) => window.__refthing.painted(id), noteId);
  assert.ok(Math.abs(note.width - 280) < 3, `note on screen: ${note.width}px`);

  // A dropped 160x100 image: 160 px on screen.
  const drop = { x: 900, y: 560 };
  await page.evaluate(async ({ x, y }) => {
    const canvas = new OffscreenCanvas(160, 100);
    const context2d = canvas.getContext('2d');
    context2d.fillStyle = '#3070c0';
    context2d.fillRect(0, 0, 160, 100);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'far.png', { type: 'image/png' }));
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
  await page.waitForFunction(() => window.__refthing.nodes.length === 3, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const dropped = (await state(page)).nodes.find(
    (candidate) => candidate.kind !== 'note' && candidate.id !== seeded.ids['anchor.png'],
  );
  const painted = await page.evaluate((id) => window.__refthing.painted(id), dropped.id);
  assert.ok(Math.abs(painted.width - 160) < 3, `image on screen: ${painted.width}px`);
  assert.ok(Math.abs(painted.x + painted.width / 2 - drop.x) < 3, 'centred on the drop');
});

test('note sizing: Size clips; width truncates; height scales text down once it meets it', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    notes: [
      { name: 'fits', x: 100, y: 100, width: 260, height: 90, text: 'Label' },
      { name: 'room', x: 500, y: 100, width: 260, height: 200, text: 'Two lines\nof text' },
      {
        name: 'clipped',
        x: 100,
        y: 400,
        width: 200,
        height: 50,
        text: 'A long note\nwith many\nlines that\ndo not fit',
      },
    ],
  });
  await openBoard(page, seeded);
  const note = async (name) => {
    await page.waitForTimeout(350);
    const board = await (
      await context.request.get(`${BASE_URL}/api/boards/${seeded.boardId}`)
    ).json();
    return board.notes.find((candidate) => candidate.id === seeded.ids[name]);
  };
  const scaleOf = (record) => record.content_json.scale ?? 1;
  const zoom = () => page.evaluate(() => window.__refthing.viewport.zoom);
  /** Drag a zone of the selected note's box (`at` picks it from the rect). */
  const zoneDrag = async (id, at, dx, dy) => {
    const center = await nodeCenter(page, id);
    await page.mouse.click(center.x, center.y);
    const rect = await page.evaluate(() => {
      const r = document.querySelector('.selection-overlay').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    const from = at(rect);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
    await page.mouse.up();
  };
  const corner = (r) => ({ x: r.right - 2, y: r.bottom - 2 });
  const bottom = (r) => ({ x: (r.left + r.right) / 2, y: r.bottom - 2 });
  const right = (r) => ({ x: r.right - 2, y: (r.top + r.bottom) / 2 });

  // Size from the menu: the text grows, the box does not.
  const before = await note('fits');
  const center = await nodeCenter(page, seeded.ids.fits);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await page.getByRole('menuitemradio', { name: 'L', exact: true }).click();
  await page.keyboard.press('Escape');
  const sized = await note('fits');
  assert.equal(sized.content_json.style.size, 20);
  assert.equal(sized.height, before.height, 'the box keeps its size (text clips)');

  // Growing never scales the text.
  await zoneDrag(seeded.ids.fits, corner, 200, 80);
  const grown = await note('fits');
  assert.ok(grown.width > sized.width + 100, 'it did resize');
  assert.equal(scaleOf(grown), scaleOf(sized), 'growing keeps the text size');

  // Width truncates: narrowing reflows, the text size stays.
  const room = await note('room');
  await zoneDrag(seeded.ids.room, right, -150, 0);
  const narrow = await note('room');
  assert.ok(narrow.width < room.width - 100, 'narrowed');
  assert.equal(scaleOf(narrow), scaleOf(room), 'narrowing keeps the text size');

  // Height: shrinking with room below the text leaves it alone ...
  await zoneDrag(seeded.ids.room, bottom, 0, -40 * (await zoom()));
  const shorter = await note('room');
  assert.ok(shorter.height < narrow.height - 30, 'shortened');
  assert.equal(scaleOf(shorter), scaleOf(narrow), 'room left: text unchanged');
  // ... and past the text's bottom, scales it down to just fit.
  const target = 40;
  await zoneDrag(seeded.ids.room, bottom, 0, -(shorter.height - target) * (await zoom()));
  const squeezed = await note('room');
  assert.ok(Math.abs(squeezed.height - target) < 3, `height ${squeezed.height}`);
  assert.ok(scaleOf(squeezed) < scaleOf(shorter) * 0.9, `text shrank: ${scaleOf(squeezed)}`);
  assert.ok(scaleOf(squeezed) > 0.1);
  const fitted = await page.evaluate((id) => window.__refthing.noteTextHeight(id), seeded.ids.room);
  assert.ok(fitted <= squeezed.height + 0.5, `fits: ${fitted} <= ${squeezed.height}`);
  assert.ok(fitted > squeezed.height * 0.8, `just fits: ${fitted} vs ${squeezed.height}`);

  // A note already clipping: shrinking moves the box over the text.
  const clippedBefore = await note('clipped');
  await zoneDrag(seeded.ids.clipped, bottom, 0, -15 * (await zoom()));
  const clippedAfter = await note('clipped');
  assert.ok(clippedAfter.height < clippedBefore.height - 5, 'it did resize');
  assert.equal(scaleOf(clippedAfter), scaleOf(clippedBefore), 'text size unchanged');
});

test('the wheel zooms over a selected item too (not only bare canvas)', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'wheel.png', x: 0, y: 0, width: 400, height: 300 }],
  });
  await openBoard(page, seeded);
  const center = await nodeCenter(page, seeded.ids['wheel.png']);
  await page.mouse.click(center.x, center.y);
  await page.locator('.selection-overlay').waitFor();
  const before = await page.evaluate(() => window.__refthing.viewport.zoom);
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__refthing.viewport.zoom);
  assert.ok(after > before * 1.1, `zoomed in over the selection: ${before} -> ${after}`);
});

test('drops land at any time: over a selection, with a menu open, one after another', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'base.png', x: 0, y: 0, width: 400, height: 300 }],
  });
  await openBoard(page, seeded);
  const board = await (
    await context.request.get(`${BASE_URL}/api/boards/${seeded.boardId}`)
  ).json();
  // Count board refetches: a drop must show its files without one.
  let refetches = 0;
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/boards/${board.board.id}`) && request.method() === 'GET') {
      refetches += 1;
    }
  });
  const dropAt = (point, name) =>
    page.evaluate(
      async ({ x, y, name: fileName }) => {
        const canvas = new OffscreenCanvas(120, 80);
        const context2d = canvas.getContext('2d');
        context2d.fillStyle = '#c07030';
        context2d.fillRect(0, 0, 120, 80);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], fileName, { type: 'image/png' }));
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
      },
      { ...point, name },
    );

  // Onto the selected item (the selection shell is on top of it).
  const base = await nodeCenter(page, seeded.ids['base.png']);
  await page.mouse.click(base.x, base.y);
  await dropAt(base, 'one.png');
  await page.waitForFunction(() => window.__refthing.nodes.length === 2, null, {
    timeout: 15000,
  });
  await page.waitForTimeout(600);
  // A drop shows its file from the upload's own response: no board refetch.
  // (Drops overlapping each other below may still resync once, when one's
  // placement races another's upload — the queue's normal recovery.)
  assert.equal(refetches, 0, 'no board refetch for a drop');
  // With the context menu open (dropped onto the menu itself).
  await page.mouse.click(base.x + 300, base.y + 200, { button: 'right' });
  const menuBox = await page.locator('.board-context-menu').boundingBox();
  await dropAt({ x: menuBox.x + 20, y: menuBox.y + 20 }, 'two.png');
  // And straight away another, before the first ones have finished.
  await dropAt({ x: base.x - 250, y: base.y }, 'three.png');
  await page.waitForFunction(() => window.__refthing.nodes.length === 4, null, {
    timeout: 15000,
  });
  await page.waitForTimeout(600);
  // They stay where they were placed (a replayed create never snaps them back).
  const nodes = (await state(page)).nodes.filter((node) => node.id !== seeded.ids['base.png']);
  for (const node of nodes) {
    assert.ok(
      Math.abs(node.width - 120 / (await page.evaluate(() => window.__refthing.viewport.zoom))) < 1,
      'camera-sized',
    );
  }
  const server = await (
    await context.request.get(`${BASE_URL}/api/boards/${seeded.boardId}`)
  ).json();
  for (const node of nodes) {
    const stored = server.items.find((item) => item.id === node.id);
    assert.ok(
      Math.abs(stored.x - node.x) < 0.5 && Math.abs(stored.y - node.y) < 0.5,
      'placement saved',
    );
  }
});

test('resizing the window from its left or top edge crops: items stay put on screen', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'focus.png', x: 0, y: 0, width: 200, height: 150 }],
  });
  await openBoard(page, seeded);
  const size = page.viewportSize();
  // The window's screen position, as the page reads it (stubbed: a test
  // browser can't drag its own window edge).
  await page.evaluate(() => {
    const frame = { x: 300, y: 200 };
    window.__frame = frame;
    Object.defineProperty(window, 'screenX', { configurable: true, get: () => frame.x });
    Object.defineProperty(window, 'screenY', { configurable: true, get: () => frame.y });
    // A headless browser's screen is the page's size (it would read as
    // maximized): give it a real monitor.
    Object.defineProperty(window.screen, 'availWidth', { configurable: true, get: () => 3840 });
    Object.defineProperty(window.screen, 'availHeight', { configurable: true, get: () => 2160 });
  });
  await page.waitForTimeout(200);
  const onScreen = async () => {
    const box = await page.evaluate((id) => window.__refthing.painted(id), seeded.ids['focus.png']);
    const frame = await page.evaluate(() => window.__frame);
    return { x: box.x + frame.x, y: box.y + frame.y };
  };
  const before = await onScreen();

  // Drag the top-left corner in by (120, 80): origin moves, window shrinks.
  await page.evaluate(() => {
    window.__frame.x += 120;
    window.__frame.y += 80;
  });
  await page.setViewportSize({ width: size.width - 120, height: size.height - 80 });
  await page.waitForTimeout(400);
  const cropped = await onScreen();
  assert.ok(Math.abs(cropped.x - before.x) < 1.5, `x stays on screen: ${before.x} -> ${cropped.x}`);
  assert.ok(Math.abs(cropped.y - before.y) < 1.5, `y stays on screen: ${before.y} -> ${cropped.y}`);

  // The bottom-right edge (origin fixed) keeps its usual behaviour too.
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(400);
  const grown = await onScreen();
  assert.ok(Math.abs(grown.x - before.x) < 1.5 && Math.abs(grown.y - before.y) < 1.5);

  // A plain window move carries the board along (no camera shift).
  const camera = await page.evaluate(() => window.__refthing.viewport);
  await page.evaluate(() => {
    window.__frame.x += 200;
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__refthing.viewport);
  assert.equal(after.x, camera.x, 'moving the window never pans the board');
});

test('Smooth edge drag: the camera eases after the window, then plants exactly', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'smooth.png', x: 0, y: 0, width: 200, height: 150 }],
  });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('refthing.appearance') || '{}');
    localStorage.setItem(
      'refthing.appearance',
      JSON.stringify({ ...saved, windowResize: 'smooth' }),
    );
  });
  await openBoard(page, seeded);
  const size = page.viewportSize();
  await page.evaluate(() => {
    const frame = { x: 300, y: 200 };
    window.__frame = frame;
    Object.defineProperty(window, 'screenX', { configurable: true, get: () => frame.x });
    Object.defineProperty(window, 'screenY', { configurable: true, get: () => frame.y });
    Object.defineProperty(window.screen, 'availWidth', { configurable: true, get: () => 3840 });
    Object.defineProperty(window.screen, 'availHeight', { configurable: true, get: () => 2160 });
  });
  await page.waitForTimeout(200);
  const onScreen = async () => {
    const box = await page.evaluate(
      (id) => window.__refthing.painted(id),
      seeded.ids['smooth.png'],
    );
    const frame = await page.evaluate(() => window.__frame);
    return { x: box.x + frame.x, y: box.y + frame.y };
  };
  const before = await onScreen();
  await page.evaluate(() => {
    window.__frame.x += 120;
    window.__frame.y += 80;
  });
  await page.setViewportSize({ width: size.width - 120, height: size.height - 80 });
  // Right after a step the curve hasn't caught up (it runs a little behind)...
  const riding = await onScreen();
  assert.ok(riding.x - before.x > 60, `eased, not snapped: ${before.x} -> ${riding.x}`);
  // ...and once the edge stops it glides back to where it was on screen.
  await page.waitForTimeout(1200);
  const settled = await onScreen();
  assert.ok(Math.abs(settled.x - before.x) < 1.5, `settled x: ${before.x} -> ${settled.x}`);
  assert.ok(Math.abs(settled.y - before.y) < 1.5, `settled y: ${before.y} -> ${settled.y}`);

  await page.setViewportSize(size);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('refthing.appearance') || '{}');
    delete saved.windowResize;
    localStorage.setItem('refthing.appearance', JSON.stringify(saved));
  });
});

test('the 10 fps testing cap still paints and still follows window resizes', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'capped.png', x: 0, y: 0, width: 200, height: 150, color: [30, 160, 90] }],
  });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('refthing.appearance') || '{}');
    localStorage.setItem('refthing.appearance', JSON.stringify({ ...saved, frameCap: 10 }));
  });
  await openBoard(page, seeded);
  await page.waitForTimeout(600);
  const center = await nodeCenter(page, seeded.ids['capped.png']);
  const color = await pixel(page, center);
  assert.ok(color[1] > color[0] + 60, `painted at 10 fps: ${color}`);
  // A resize lands on the next allowed frame: the canvas takes the window.
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width - 200, height: size.height - 100 });
  await page.waitForTimeout(400);
  const canvasSize = await page.evaluate(() => {
    const canvas = document.querySelector('#canvas-host canvas');
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  });
  assert.deepEqual(canvasSize, { width: size.width - 200, height: size.height - 100 });
  await page.setViewportSize(size);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('refthing.appearance') || '{}');
    delete saved.frameCap;
    localStorage.setItem('refthing.appearance', JSON.stringify(saved));
  });
});
