/**
 * Write-path robustness: a board refetch (another writer's change arriving)
 * must never erase an optimistic edit whose batch is still in flight, and
 * our own viewport saves must not trigger refetches at all.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BASE_URL, launch, nodeCenter, openBoard, seedBoard, settle, state } from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

const layout = { images: [{ name: 'a.png', x: 200, y: 200, width: 120, height: 90 }] };

test('a refetch mid-flight keeps the optimistic edit on screen', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const id = seeded.ids['a.png'];
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await settle(page);
  const x0 = (await state(page)).nodes.find((node) => node.id === id).x;

  // Hold our next batch on the wire for 1.2s (only that one: the rebased
  // resend after the conflict goes straight through).
  let held = 0;
  await page.route(`**/api/boards/${seeded.boardId}/items/batch`, async (route) => {
    if (held++ === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.keyboard.press('Shift+ArrowRight'); // +10 screen px, in flight
  const zoom = (await state(page)).viewport.zoom;
  // Another writer creates a note → op-less diff → this client refetches.
  await context.request.post(`${BASE_URL}/api/boards/${seeded.boardId}/notes`, {
    data: { x: 600, y: 200, width: 160, height: 100, content_json: { text: 'remote' } },
  });
  await page.waitForTimeout(500); // refetch done, batch still held
  const during = await state(page);
  assert.ok(
    during.nodes.some((node) => node.kind === 'note'),
    'the refetch should have brought the remote note in',
  );
  assert.equal(
    during.nodes.find((node) => node.id === id).x,
    x0 + 10 / zoom,
    'the in-flight nudge was erased by the refetch',
  );
  await page.waitForTimeout(2000); // held batch conflicts, rebases, resends
  await page.unroute(`**/api/boards/${seeded.boardId}/items/batch`);
  assert.ok(held >= 2, 'expected the conflict to trigger a rebased resend');
  const server = await (
    await context.request.get(`${BASE_URL}/api/boards/${seeded.boardId}`)
  ).json();
  assert.equal(server.items[0].x, x0 + 10 / zoom, 'the nudge reached the server');
});

test('our own viewport saves never refetch the board', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  let refetches = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().endsWith(`/api/boards/${seeded.boardId}`)) {
      refetches += 1;
    }
  });
  for (let pan = 0; pan < 3; pan += 1) {
    await page.mouse.move(900, 600);
    await page.mouse.down({ button: 'middle' });
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(900 + i * 8, 600);
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(500); // the debounced save fires and echoes
  }
  assert.equal(refetches, 0, `${refetches} full refetches after our own viewport saves`);
});
