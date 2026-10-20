/**
 * `.ref` board files in the browser build: the board menu downloads the
 * open board as a `.ref` (the desktop keeps it in a file instead), and
 * "Open board file…" brings one back as a new board — everything in it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch, nodeCenter, openBoard, seedBoard } from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

test('a board downloads as a .ref file and opens again as a new board', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [
      { name: 'one.png', x: 0, y: 0, width: 200, height: 160, color: [200, 60, 30] },
      { name: 'two.png', x: 260, y: 40, width: 120, height: 120, color: [30, 90, 200] },
    ],
  });
  await openBoard(page, seeded);

  // The menu offers the download (the browser can't keep a file).
  await page.getByRole('button', { name: /^Boards/ }).click();
  const link = page.getByRole('link', { name: 'Download .ref' });
  await link.waitFor();
  const href = await link.getAttribute('href');
  const response = await context.request.get(new URL(href, page.url()).toString());
  assert.equal(response.status(), 200);
  const bytes = await response.body();
  assert.equal(bytes.subarray(0, 8).toString('latin1'), 'REFBOARD', 'a .ref file');
  assert.ok(!bytes.includes(Buffer.from('manifest.json')), 'nothing readable inside');

  // Open it: a new board with both images, opened.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open board file…' }).click();
  await (await chooser).setFiles({
    name: `${seeded.name}.ref`,
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await page.waitForFunction(
    (id) => window.__refthing?.boardId && window.__refthing.boardId !== id,
    seeded.boardId,
  );
  await page.waitForFunction(() => window.__refthing.nodes.length === 2);
  const nodes = await page.evaluate(() => window.__refthing.nodes);
  const sizes = nodes.map((node) => [node.width, node.height]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(sizes, [
    [120, 120],
    [200, 160],
  ]);
});

test('a .ref file dropped on the window opens as its board, images and all', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [
      { name: 'red.png', x: 0, y: 0, width: 240, height: 200, color: [200, 40, 30] },
      { name: 'blue.png', x: 300, y: 0, width: 160, height: 160, color: [30, 80, 210] },
    ],
  });
  await openBoard(page, seeded);
  await page.getByRole('button', { name: /^Boards/ }).click();
  const href = await page.getByRole('link', { name: 'Download .ref' }).getAttribute('href');
  const bytes = await (await context.request.get(new URL(href, page.url()).toString())).body();
  await page.keyboard.press('Escape');

  // Dropped onto the open board, the way Explorer drops it.
  await page.evaluate(async (data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(data)], 'Dropped board.ref', { type: 'application/octet-stream' }),
    );
    const target = document.elementFromPoint(700, 450);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 700,
          clientY: 450,
          dataTransfer: transfer,
        }),
      );
    }
  }, Array.from(bytes));

  await page.waitForFunction(
    (id) => window.__refthing?.boardId && window.__refthing.boardId !== id,
    seeded.boardId,
    { timeout: 15000 },
  );
  await page.waitForFunction(() => window.__refthing.nodes.length === 2);
  // Images, with their pictures — not file cards.
  await page.waitForFunction(
    () => window.__refthing.nodes.every((node) => node.kind === 'image' && node.poster),
    null,
    { timeout: 15000 },
  );
  // The board it was dropped on is untouched.
  const before = await (
    await context.request.get(new URL(`/api/boards/${seeded.boardId}`, page.url()).toString())
  ).json();
  assert.equal(before.items.length, 2, 'nothing landed on the open board');
});

test('a .ref file sitting on a board as a card opens as its board', async () => {
  const { page, context } = session;
  const source = await seedBoard(context.request, {
    images: [{ name: 'green.png', x: 0, y: 0, width: 180, height: 140, color: [40, 170, 60] }],
  });
  const bytes = await (
    await context.request.get(
      new URL(`/api/boards/${source.boardId}/download.ref`, page.url()).toString(),
    )
  ).body();
  // A card left by an older version, which took the file for an ordinary one.
  const holder = await seedBoard(context.request, {
    files: [{ name: 'Old board.ref', x: 0, y: 0, buffer: bytes }],
  });
  await openBoard(page, holder);
  const center = await nodeCenter(page, holder.ids['Old board.ref']);
  await page.mouse.dblclick(center.x, center.y);

  await page.waitForFunction(
    (ids) => window.__refthing?.boardId && !ids.includes(window.__refthing.boardId),
    [holder.boardId, source.boardId],
    { timeout: 15000 },
  );
  await page.waitForFunction(
    () =>
      window.__refthing.nodes.length === 1 &&
      window.__refthing.nodes[0].kind === 'image' &&
      window.__refthing.nodes[0].poster,
    null,
    { timeout: 15000 },
  );
});
