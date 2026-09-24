/**
 * Full-app frame timing on a large board (not part of the e2e suite — run
 * `node e2e/perf.mjs [count]` with the dev stack up). Unlike the dev board
 * (/dev/board/N, canvas only), this drives the real App: React chrome,
 * selection shell, previews and the write queue included.
 *
 * Seeds `count` items sharing one blob through batched restore_item ops, then
 * reports frame-interval percentiles while (1) dragging an unselected image,
 * (2) dragging the selection shell, and (3) panning.
 */
import { BASE_URL, launch, nodeCenter, openBoard, seedBoard, settle } from './harness.mjs';

const count = Number(process.argv[2] ?? 5000);
const session = await launch();
const { page, context } = session;
const request = context.request;

const seeded = await seedBoard(request, {
  images: [{ name: 'seed.png', x: 0, y: 0, width: 96, height: 72 }],
});
const board = await (await request.get(`${BASE_URL}/api/boards/${seeded.boardId}`)).json();
const template = board.items[0];
let seq = board.seq;
const columns = Math.ceil(Math.sqrt(count));
for (let start = 1; start < count; start += 1000) {
  const ops = [];
  for (let i = start; i < Math.min(count, start + 1000); i += 1) {
    ops.push({
      kind: 'restore_item',
      op_id: crypto.randomUUID(),
      item: {
        ...template,
        id: crypto.randomUUID(),
        x: (i % columns) * 110,
        y: Math.floor(i / columns) * 86,
        z_index: i,
      },
      tag_ids: [],
    });
  }
  const response = await request.post(`${BASE_URL}/api/boards/${seeded.boardId}/items/batch`, {
    data: { base_seq: seq, client_id: 'perf', ops },
  });
  seq = (await response.json()).seq;
}
await openBoard(page, seeded);
await page.waitForFunction((n) => window.__refthing.nodes.length >= n, count, { timeout: 120000 });
await settle(page);

async function measure(label, action) {
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (now) => {
      window.__frames.push(now - last);
      last = now;
      if (window.__recording) requestAnimationFrame(tick);
    };
    window.__recording = true;
    requestAnimationFrame(tick);
  });
  await action();
  const frames = await page.evaluate(() => {
    window.__recording = false;
    return window.__frames.slice(2);
  });
  frames.sort((a, b) => a - b);
  const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))].toFixed(1);
  console.log(
    `${label.padEnd(28)} frames=${String(frames.length).padStart(4)}  p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  p99=${pct(0.99)}ms`,
  );
}

const target = await nodeCenter(page, seeded.ids['seed.png']);
const samples = (from) =>
  Array.from({ length: 90 }, (_, i) => ({
    index: i,
    timeMs: i * 16,
    x: from.x + 200 * Math.sin((i / 90) * 2 * Math.PI),
    y: from.y + 100 * Math.sin((i / 90) * 4 * Math.PI),
  }));
// Real-time pacing: one move per frame, like a user.
const paced = async (from, button = 'left') => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (const sample of samples(from)) {
    await page.mouse.move(sample.x, sample.y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button });
};

console.log(`board: ${count} items`);
await measure('idle (1s)', () => page.waitForTimeout(1000));
await page.keyboard.press('Escape');
await measure('drag unselected image', () => paced(target));
await measure('drag selection shell', () => paced(target));
await measure('pan (middle drag)', () => paced({ x: 900, y: 600 }, 'middle'));
await session.browser.close();
