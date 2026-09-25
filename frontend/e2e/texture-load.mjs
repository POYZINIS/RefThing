/**
 * Phase 9 texture-streaming measurement (not part of the e2e suite).
 *
 *   npm run build -w frontend && E2E_RELEASE=1 GPU=1 node e2e/texture-load.mjs
 *
 * Seeds N distinct 1600×1200 images on the isolated stack, serves the
 * PRODUCTION build (vite preview), then sweeps the camera (fit-all, zoom in,
 * pan across) so every pyramid level streams in. Reports main-thread long
 * tasks, frame times, and how many full-size originals were downloaded.
 */
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { launch } from './harness.mjs';
import { globalSetup, globalTeardown } from './stack.mjs';

const count = Number(process.argv[2] ?? 600);
const API = 'http://localhost:7191';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
function png(index, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = (x * 2 + index * 5) & 255;
      row[2 + x * 3] = (y + index * 11) & 255;
      row[3 + x * 3] = ((x ^ y) + index) & 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await globalSetup();
const preview = spawn('npx', ['vite', 'preview', '--port', '5192', '--strictPort'], {
  cwd: import.meta.dirname + '/..',
  shell: true,
  stdio: 'ignore',
  env: { ...process.env, REFTHING_API_PORT: '7191' },
});
const session = await launch();
try {
  const board = await (
    await fetch(`${API}/api/boards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'texture load' }),
    })
  ).json();
  const columns = Math.ceil(Math.sqrt(count));
  for (let start = 0; start < count; start += 50) {
    const form = new FormData();
    const meta = {};
    for (let index = start; index < Math.min(count, start + 50); index += 1) {
      const name = `t-${index}.png`;
      meta[name] = { x: (index % columns) * 1700, y: Math.floor(index / columns) * 1300 };
      form.append('file', new Blob([png(index, 1600, 1200)], { type: 'image/png' }), name);
    }
    form.append('meta', JSON.stringify(meta));
    await fetch(`${API}/api/boards/${board.id}/items:ingest`, { method: 'POST', body: form });
  }
  for (;;) {
    const health = await (await fetch(`${API}/api/health`)).json();
    if (health.pending_jobs === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch('http://localhost:5192/')).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const { page } = session;
  let fullRequests = 0;
  page.on('request', (request) => {
    if (/\/blob\/[0-9a-f]{64}\/full$/.test(request.url())) fullRequests += 1;
  });
  await page.goto('http://localhost:5192/');
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__long.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
    window.__frames = [];
    let last = performance.now();
    const tick = (now) => {
      window.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('.board-row', { hasText: 'texture load' }).click();
  await page.waitForTimeout(1500);
  const host = await page.evaluate(() => {
    const rect = document.getElementById('canvas-host').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  // Fit everything (thumbs), then zoom in step by step (small → medium →
  // full) and pan across the board at close zoom.
  await page.mouse.dblclick(host.x + 300, host.y + 300);
  await page.waitForTimeout(2500);
  for (let step = 0; step < 14; step += 1) {
    await page.mouse.move(host.x, host.y);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(250);
  }
  await page.mouse.move(host.x + 400, host.y + 250);
  await page.mouse.down({ button: 'middle' });
  for (let i = 0; i < 60; i += 1) {
    await page.mouse.move(host.x + 400 - i * 14, host.y + 250 - i * 6);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(2500);
  const result = await page.evaluate(() => ({ long: window.__long, frames: window.__frames }));
  const frames = result.frames.slice(5).sort((a, b) => a - b);
  const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))].toFixed(1);
  const blocked = result.long.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0);
  console.log(
    [
      `images                ${count} (1600×1200, distinct)`,
      `long tasks            ${result.long.length}  (total blocking ${blocked.toFixed(0)}ms, worst ${Math.max(0, ...result.long).toFixed(0)}ms)`,
      `frames                p50 ${pct(0.5)}ms  p95 ${pct(0.95)}ms  p99 ${pct(0.99)}ms`,
      `full originals fetched ${fullRequests}`,
    ].join('\n'),
  );
} finally {
  await session.browser.close();
  spawn('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { stdio: 'ignore' });
  await globalTeardown();
}
