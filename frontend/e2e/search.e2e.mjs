/**
 * Phase 6 search bar: colour and duplicate filters narrow what the canvas
 * paints (filtered-out nodes are not painted at all).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BASE_URL, launch, openBoard, seedBoard, settle } from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

const RED = [230, 20, 20];
const BLUE = [20, 40, 230];

/** The pyramid job computes palette + phash asynchronously after ingest. */
async function waitForAnalysis(request, boardId, count) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const snapshot = await (await request.get(`${BASE_URL}/api/boards/${boardId}`)).json();
    const ready = snapshot.items.filter(
      (item) => item.metadata?.dominant_colors && item.metadata?.phash,
    );
    if (ready.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('pyramid analysis never finished');
}

const painted = (page, ids) =>
  page.evaluate(
    (list) => Object.fromEntries(list.map((id) => [id, window.__refthing.painted(id) !== null])),
    ids,
  );

test('Color filter keeps only images near the chosen color; Duplicates keeps only twins', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [
      { name: 'red.png', x: 100, y: 150, width: 120, height: 90, color: RED },
      { name: 'red-copy.png', x: 260, y: 150, width: 120, height: 90, color: RED },
      { name: 'blue.png', x: 420, y: 150, width: 140, height: 70, color: BLUE },
    ],
  });
  await waitForAnalysis(context.request, seeded.boardId, 3);
  await openBoard(page, seeded);
  const ids = Object.values(seeded.ids);
  assert.deepEqual(Object.values(await painted(page, ids)), [true, true, true]);

  // The filters open with the search field.
  // Search opens from Ctrl+F (or Search… in the context menu).
  await page.keyboard.press('Control+f');
  await page.getByRole('button', { name: 'Color', exact: true }).click();
  await page.waitForTimeout(600);
  await settle(page);
  const byColour = await painted(page, ids);
  assert.equal(byColour[seeded.ids['blue.png']], false, 'blue survived a red colour filter');
  assert.equal(byColour[seeded.ids['red.png']], true);

  await page.getByRole('button', { name: 'Color', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicates' }).click();
  await page.waitForTimeout(600);
  await settle(page);
  const twins = await painted(page, ids);
  assert.deepEqual(
    [
      twins[seeded.ids['red.png']],
      twins[seeded.ids['red-copy.png']],
      twins[seeded.ids['blue.png']],
    ],
    [true, true, false],
    'only the identical pair counts as duplicates',
  );
});
