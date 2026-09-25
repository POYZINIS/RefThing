/**
 * Visual capture of the chrome for design review (not a test). Seeds its own
 * boards on the stack at BASE_URL and writes PNGs to SHOTS_DIR.
 *   BASE_URL=http://localhost:5191 SHOTS_DIR=... node e2e/shots.mjs [tag] [--empty]
 * Point it at a throwaway stack (e2e/stack.mjs's ports), never real boards.
 * `--empty` also deletes EVERY board on that stack to capture the first-run
 * screen, so it additionally requires SHOTS_ALLOW_WIPE=1.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, request as pwRequest } from 'playwright';
import { BASE_URL, seedBoard, settle } from './harness.mjs';

const out = process.env.SHOTS_DIR ?? 'shots';
const tag = process.argv[2] ?? 'now';
const wipe = process.argv.includes('--empty');
if (wipe && process.env.SHOTS_ALLOW_WIPE !== '1') {
  throw new Error('--empty deletes every board on the stack: set SHOTS_ALLOW_WIPE=1 to confirm');
}
mkdirSync(out, { recursive: true });

const api = await pwRequest.newContext();
const seeded = await seedBoard(api, {
  images: [
    { name: 'a.png', x: -420, y: -160, width: 360, height: 240, color: [196, 120, 88] },
    { name: 'b.png', x: 0, y: -220, width: 260, height: 360, color: [88, 132, 170] },
    { name: 'c.png', x: 320, y: -120, width: 300, height: 200, color: [120, 160, 110] },
  ],
  notes: [{ x: -380, y: 140, width: 280, height: 150, text: 'Lighting: warm key, cool rim.' }],
  files: [{ name: 'brief.pdf', x: 340, y: 140, buffer: Buffer.from('%PDF-1.4\n%%EOF\n') }],
});
const empty = await seedBoard(api, {});
for (const name of ['lighting', 'palette']) {
  await api.post(`${BASE_URL}/api/tags`, { data: { name } });
}

const browser = await chromium.launch();
const views = [
  ['desk', { width: 1400, height: 900 }],
  ['mid', { width: 900, height: 700 }],
  ['phone', { width: 390, height: 844 }],
];
for (const scheme of ['dark', 'light']) {
  for (const [label, viewport] of views) {
    const context = await browser.newContext({ viewport, colorScheme: scheme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const shot = (name) =>
      page.screenshot({ path: join(out, `${tag}-${scheme}-${label}-${name}.png`) });
    // Frame the board freshly each run (a previous run saved its camera).
    await api.patch(`${BASE_URL}/api/boards/${seeded.boardId}`, {
      data: { viewport_state: null },
    });
    await page.goto(`${BASE_URL}/?board=${seeded.boardId}`);
    await page.waitForFunction(() => (window.__refthing?.nodes?.length ?? 0) >= 5, null, {
      timeout: 15000,
    });
    await page.waitForTimeout(900);
    await settle(page);
    await shot('1-board');

    await page.getByRole('button', { name: /^Boards/ }).click();
    await page.waitForTimeout(250);
    await shot('2-boards');
    await page.keyboard.press('Escape');

    await page.mouse.move(viewport.width / 2 - 150, 120);
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(250);
    await shot('3-search');
    await page.keyboard.press('Escape');

    if (label !== 'phone') {
      await page.mouse.click(viewport.width - 120, viewport.height - 130, { button: 'right' });
      await page.waitForTimeout(250);
      await shot('4-canvas-menu');
      await page.keyboard.press('Escape');
    }

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForTimeout(300);
    await shot('6-settings');
    await page.keyboard.press('Escape');

    await page.goto(`${BASE_URL}/?board=${empty.boardId}`);
    await page.waitForTimeout(1200);
    await shot('7-empty-board');
    if (errors.length) console.log(scheme, label, 'page errors:', errors);
    await context.close();
  }
}

if (wipe) {
  const boards = await (await api.get(`${BASE_URL}/api/boards`)).json();
  for (const board of boards) await api.delete(`${BASE_URL}/api/boards/${board.id}`);
  for (const scheme of ['dark', 'light']) {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await page.goto(BASE_URL);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(out, `${tag}-${scheme}-desk-0-first-run.png`) });
    await context.close();
  }
}
await browser.close();
await api.dispose();
console.log(`shots written to ${out}`);
