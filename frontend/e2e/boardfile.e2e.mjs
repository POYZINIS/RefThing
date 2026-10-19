/**
 * `.ref` board files in the browser build: the board menu downloads the
 * open board as a `.ref` (the desktop keeps it in a file instead), and
 * "Open board file…" brings one back as a new board — everything in it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch, openBoard, seedBoard } from './harness.mjs';

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
