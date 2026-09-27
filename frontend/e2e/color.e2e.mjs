/**
 * The colour system in the real app: the colour wheel is an item the corner
 * button brings; its palettes (and ones sampled from images) are items too
 * — click a swatch to copy it, Alt+drag to pull a colour out, drop one at
 * another's end to join them.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch, nodeCenter, openBoard, seedBoard, state } from './harness.mjs';

let session;
before(async () => {
  session = await launch();
  await session.context.grantPermissions(['clipboard-read', 'clipboard-write']);
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

const nodes = (page) => page.evaluate(() => window.__refthing.nodes);
const ofKind = async (page, kind) => (await nodes(page)).filter((node) => node.kind === kind);
const wheelOf = async (page) => (await ofKind(page, 'colorwheel'))[0];
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

/** Pan the board with a middle-button drag. */
async function pan(page, dx, dy) {
  await page.mouse.move(700, 450);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(700 + dx, 450 + dy, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(500);
}

test('the corner button brings the wheel: adds it, moves it into view, pans to it', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'anchor.png', x: 0, y: 0, width: 200, height: 200 }],
  });
  await openBoard(page, seeded);
  const button = page.getByRole('button', { name: 'Color wheel' });
  await button.click();
  await page.getByTestId('color-wheel-panel').waitFor();
  const wheel = await wheelOf(page);
  assert.ok(wheel, 'a colour wheel item');
  assert.deepEqual((await state(page)).selection, [wheel.id], 'selected');
  const screenCenter = async () => {
    const box = await page.evaluate((id) => window.__refthing.painted(id), wheel.id);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  let center = await screenCenter();
  assert.ok(Math.abs(center.x - 700) < 4 && Math.abs(center.y - 450) < 4, 'in the middle');
  // Still one wheel after another click.
  await button.click();
  assert.equal((await ofKind(page, 'colorwheel')).length, 1);

  // Off screen: it moves to the middle of the view.
  await page.keyboard.press('Escape');
  await pan(page, -1300, 0);
  const before = await wheelOf(page);
  await button.click();
  await page.waitForTimeout(500);
  const moved = await wheelOf(page);
  assert.ok(Math.abs(moved.x - before.x) > 100, 'moved to the view');
  center = await screenCenter();
  assert.ok(Math.abs(center.x - 700) < 4, `centred: ${center.x}`);

  // Partly on screen: the view pans to it (the item stays put).
  await page.keyboard.press('Escape');
  await pan(page, 400, 0);
  const placed = await wheelOf(page);
  await button.click();
  await page.waitForTimeout(900);
  const after = await wheelOf(page);
  assert.equal(after.x, placed.x, 'not moved');
  center = await screenCenter();
  assert.ok(Math.abs(center.x - 700) < 4, `panned to centre it: ${center.x}`);
});

test('releasing the wheel saves its palette; Random adds one; settings persist', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'anchor.png', x: -1000, y: 0, width: 100, height: 100 }],
  });
  await openBoard(page, seeded);
  await page.getByRole('button', { name: 'Color wheel' }).click();
  await page.getByTestId('color-wheel-panel').waitFor();
  const first = await wheelOf(page);
  assert.equal(first.wheel.library.length, 0);

  // Drag the base handle across the wheel and let go.
  const disc = await page.locator('.color-wheel-iro').boundingBox();
  const base = first.wheel.colors[2];
  assert.ok(base);
  await page.mouse.move(disc.x + disc.width * 0.5, disc.y + disc.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(disc.x + disc.width * 0.8, disc.y + disc.height * 0.25, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const turned = await wheelOf(page);
  assert.equal(turned.wheel.library.length, 1, 'saved on release');
  assert.deepEqual(turned.wheel.library[0], turned.wheel.colors);
  assert.notDeepEqual(turned.wheel.colors, first.wheel.colors, 'the palette changed');

  // Random: a new palette, saved too.
  await page.getByRole('button', { name: 'Random' }).click();
  await page.waitForTimeout(300);
  const random = await wheelOf(page);
  assert.equal(random.wheel.library.length, 2);
  assert.notDeepEqual(random.wheel.colors, turned.wheel.colors);

  // The harmony and the brightness mode are the item's.
  // The harmony picker is our menu (the right-click menu's look).
  const harmony = page.getByRole('button', { name: /^Harmony/ });
  await harmony.click();
  const list = page.getByRole('menu', { name: 'Harmony' });
  await list.waitFor();
  assert.equal(await list.getByRole('menuitemradio').count(), 9, 'the nine harmonies');
  assert.equal(await list.getByRole('menuitemradio', { checked: true }).count(), 1);
  // Escape closes the list, not the wheel's selection.
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('color-wheel-panel').count(), 1);
  await harmony.click();
  await list.getByRole('menuitemradio', { name: 'Triad' }).click();
  await list.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'HSL', exact: true }).click();
  await page.waitForTimeout(300);
  const set = await wheelOf(page);
  assert.equal(set.wheel.harmony, 'triad');
  assert.equal(set.wheel.mode, 'hsl');
  assert.equal(await page.getByRole('slider', { name: 'Lightness' }).count(), 1);

  // Deselected, the canvas paints it; reselected, the controls return.
  await page.keyboard.press('Escape');
  // It eases back out (no input meanwhile), then the canvas draws it.
  await page.locator('.color-wheel-panel.leaving').waitFor({ timeout: 1000 });
  await page.getByTestId('color-wheel-panel').waitFor({ state: 'detached' });
});

test('palettes: drag one out, click to copy and sample, Alt+drag a colour, join ends', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'anchor.png', x: -1000, y: 0, width: 100, height: 100 }],
  });
  await openBoard(page, seeded);
  await page.getByRole('button', { name: 'Color wheel' }).click();
  await page.getByTestId('color-wheel-panel').waitFor();
  const wheel = await wheelOf(page);

  // Drag the current palette out of the wheel onto the board.
  const row = await page.locator('.color-wheel-swatches').boundingBox();
  await page.mouse.move(row.x + 8, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(300, 780, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const [palette] = await ofKind(page, 'palette');
  assert.ok(palette, 'a palette item');
  assert.deepEqual(palette.colors, wheel.wheel.colors);

  // Click its first swatch: the hex is copied and the wheel samples it.
  await page.keyboard.press('Escape');
  const box = await page.evaluate((id) => window.__refthing.painted(id), palette.id);
  const swatch = (index) => ({
    x: box.x + (box.width * (index + 0.5)) / palette.colors.length,
    y: box.y + box.height / 2,
  });
  const first = swatch(0);
  await page.mouse.click(first.x, first.y);
  await page.waitForTimeout(300);
  assert.equal((await clipboard(page)).toLowerCase(), palette.colors[0]);
  assert.equal((await wheelOf(page)).wheel.base, palette.colors[0], 'sampled into the wheel');

  // Alt+drag the last swatch out: a one-colour palette where it lands.
  const last = swatch(palette.colors.length - 1);
  await page.keyboard.down('Alt');
  await page.mouse.move(last.x, last.y);
  await page.mouse.down();
  await page.mouse.move(last.x + 150, last.y - 220, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(400);
  const palettes = await ofKind(page, 'palette');
  assert.equal(palettes.length, 2, 'a copy pulled out');
  const single = palettes.find((candidate) => candidate.id !== palette.id);
  assert.deepEqual(single.colors, [palette.colors.at(-1)]);
  const original = palettes.find((candidate) => candidate.id === palette.id);
  assert.deepEqual(original.colors, palette.colors, 'the original keeps its colours');

  // Drag the single colour to the original's right end: they join.
  await page.keyboard.press('Escape');
  const singleCenter = await nodeCenter(page, single.id);
  const target = await page.evaluate((id) => window.__refthing.painted(id), palette.id);
  const singleBox = await page.evaluate((id) => window.__refthing.painted(id), single.id);
  await page.mouse.move(singleCenter.x, singleCenter.y);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width + singleBox.width / 2 + 4,
    target.y + target.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.waitForTimeout(500);
  const joined = await ofKind(page, 'palette');
  assert.equal(joined.length, 1, 'joined into one');
  assert.deepEqual(joined[0].colors, [...palette.colors, palette.colors.at(-1)]);
  // One undo step apart.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  assert.equal((await ofKind(page, 'palette')).length, 2, 'undo splits them again');
});

test('Sample Colors turns an image into a palette under it (and the library)', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [
      {
        name: 'two.png',
        x: -900,
        y: 0,
        width: 300,
        height: 200,
        color: [220, 90, 30],
        right: [30, 120, 200],
      },
      { name: 'far.png', x: 900, y: 0, width: 100, height: 100, color: [240, 220, 60] },
    ],
  });
  await openBoard(page, seeded);
  await page.getByRole('button', { name: 'Color wheel' }).click();
  await page.getByTestId('color-wheel-panel').waitFor();
  await page.keyboard.press('Escape');
  const center = await nodeCenter(page, seeded.ids['two.png']);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Sample Colors' }).click();
  await page.waitForFunction(() => window.__refthing.nodes.some((node) => node.kind === 'palette'));
  const [palette] = await ofKind(page, 'palette');
  // Two colours in the image: two swatches, close to them.
  assert.equal(palette.colors.length, 2, palette.colors.join());
  const image = (await nodes(page)).find((node) => node.id === seeded.ids['two.png']);
  assert.ok(palette.y > image.y + image.height, 'under the image');
  const wheel = await wheelOf(page);
  assert.deepEqual(wheel.wheel.library[0], palette.colors, 'saved to the library');

  // A palette's menu saves it to the library too.
  const paletteCenter = await nodeCenter(page, palette.id);
  await page.mouse.click(paletteCenter.x, paletteCenter.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to Palettes' }).click();
  await page.waitForTimeout(300);
  assert.equal((await wheelOf(page)).wheel.library.length, 2);
});

test('zoomed out the wheel shows only its colour; its margins and corners move it', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'anchor.png', x: -1000, y: 0, width: 100, height: 100 }],
  });
  await openBoard(page, seeded);
  await page.getByRole('button', { name: 'Color wheel' }).click();
  const panel = page.getByTestId('color-wheel-panel');
  await panel.waitFor();
  const wheel = await wheelOf(page);
  const painted = () => page.evaluate((id) => window.__refthing.painted(id), wheel.id);
  assert.equal(await panel.getAttribute('data-detail'), 'full');

  // The square around the wheel's disc isn't the wheel: a press in its
  // corner drags the item.
  const disc = await page.locator('.color-wheel-iro').boundingBox();
  const corner = { x: disc.x + 3, y: disc.y + 3 };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60, corner.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const moved = await wheelOf(page);
  assert.ok(Math.abs(moved.x - wheel.x - 60) < 2, `moved by the corner: ${moved.x - wheel.x}`);
  assert.deepEqual(moved.wheel.colors, wheel.wheel.colors, 'the colours are untouched');

  // Zoom out: compact — the text and buttons go, the colour stays live.
  const zoomOut = async (until) => {
    for (let notch = 0; notch < 30 && !until((await painted()).width); notch += 1) {
      await page.mouse.move(1200, 820);
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400);
  };
  await zoomOut((width) => width < 290 && width > 180);
  assert.equal(await panel.getAttribute('data-detail'), 'compact');
  assert.equal(
    await page.getByRole('button', { name: /^Harmony/ }).isVisible(),
    false,
    'no text or buttons',
  );
  assert.equal(await page.getByRole('button', { name: 'Random palette' }).isVisible(), false);
  await page.locator('.color-wheel-swatches').waitFor({ state: 'visible' });

  // Further: the canvas picture alone — a press anywhere moves the item.
  await zoomOut((width) => width < 160);
  assert.equal(await panel.count(), 0, 'no live controls');
  const box = await painted();
  const before = await wheelOf(page);
  const on = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.25 };
  await page.mouse.move(on.x, on.y);
  await page.mouse.down();
  await page.mouse.move(on.x + 30, on.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await wheelOf(page);
  assert.ok(after.x > before.x, 'moved');
  assert.deepEqual(after.wheel.colors, before.wheel.colors, 'handles are not grabbable');
});

test('a hovered palette swatch shows its hex', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'anchor.png', x: -1000, y: 0, width: 100, height: 100 }],
  });
  await openBoard(page, seeded);
  await page.getByRole('button', { name: 'Color wheel' }).click();
  await page.getByTestId('color-wheel-panel').waitFor();
  const row = await page.locator('.color-wheel-swatches').boundingBox();
  await page.mouse.move(row.x + 8, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(300, 780, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  const [palette] = await ofKind(page, 'palette');
  const box = await page.evaluate((id) => window.__refthing.painted(id), palette.id);
  await page.mouse.move(box.x + (box.width * 3.5) / 5, box.y + box.height / 2, { steps: 4 });
  const tip = page.getByTestId('palette-hex-tip');
  await tip.waitFor();
  assert.equal((await tip.textContent()).trim(), palette.colors[3].toUpperCase());
  await page.mouse.move(box.x + box.width / 2, box.y - 120);
  await tip.waitFor({ state: 'detached' });
});
