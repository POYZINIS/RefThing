// Headless perf driver for the synthetic dev board.
// Usage: node frontend/src/dev/measure-perf.mjs [baseUrl] [counts] [seed]
//   node frontend/src/dev/measure-perf.mjs http://localhost:5173 5000,20000,50000 1
// Prints one JSON perf summary per count (parsed from document.title, which
// the DevBoard tour sets to `PERF {json}` when finished).

import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5173';
const counts = (process.argv[3] ?? '5000,20000,50000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const seed = process.argv[4] ?? '1';
// UNCAPPED=1 disables vsync/frame-rate limiting so frame time reflects real
// per-frame cost instead of the ~160Hz headless BeginFrame cadence.
const uncapped = process.env.UNCAPPED === '1';
const rateArgs = uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [];

let browser;
try {
  // Full chromium channel uses the new headless mode, which can use a real
  // GPU; fall back to the default headless shell (SwiftShader) if missing.
  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', ...rateArgs],
  });
} catch {
  browser = await chromium.launch({ headless: true, args: rateArgs });
}

for (const count of counts) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('console', (message) => {
    if (message.text().startsWith('[refthing-perf]')) console.log(message.text());
  });
  page.on('pageerror', (error) => console.error(`[pageerror:${count}]`, error.message));

  // Prefer the canonical app route; fall back to the standalone harness if
  // the app does not mount DevBoard there yet.
  await page.goto(`${base}/dev/board/${count}?seed=${seed}&tour=1`);
  const mounted = await page
    .waitForSelector('[data-dev-board]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!mounted) {
    await page.goto(`${base}/src/dev/board.html?count=${count}&seed=${seed}&tour=1`);
  }

  await page.waitForFunction(() => document.title.startsWith('PERF '), null, {
    timeout: 240000,
  });
  const title = await page.title();
  console.log(`RESULT count=${count} ${title.slice('PERF '.length)}`);
  await page.close();
}

await browser.close();
