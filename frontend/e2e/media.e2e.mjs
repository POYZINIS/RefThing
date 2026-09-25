/**
 * Phase 11 item types in the real app: any file lands as a card, audio (and
 * video) get server posters and a live player on double-click, and squashed
 * items get their proportions back.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
} from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

/** A mono 16-bit PCM WAV: a 440 Hz tone. */
function wav(seconds = 1, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const ffmpeg = spawnSync(process.env.REFTHING_FFMPEG ?? 'ffmpeg', ['-version']).status === 0;

const node = async (page, id) => (await state(page)).nodes.find((n) => n.id === id);

test('any file lands as a card that paints and opens', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'brief.txt', x: 200, y: 200, buffer: Buffer.from('plain text brief') }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['brief.txt'];
  const card = await node(page, id);
  assert.equal(card.kind, 'file');
  assert.deepEqual([card.width, card.height], [200, 240], 'placed at the card size');

  // The card is painted on the canvas (its dark face, not the board).
  const corner = await page.evaluate((nodeId) => window.__refthing.painted(nodeId), id);
  assert.ok(corner, 'painted');
  const face = await pixel(page, { x: corner.x + 6, y: corner.y + 6 });
  assert.ok(Math.abs(face[0] - 0x1b) < 8 && Math.abs(face[2] - 0x27) < 8, `card face ${face}`);

  // Double-click opens the original in a new tab.
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(url);
      return null;
    };
  });
  const center = await nodeCenter(page, id);
  await page.mouse.dblclick(center.x, center.y);
  const opened = await page.evaluate(() => window.__opened);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^\/blob\/[0-9a-f]{64}\/full$/);
});

test('audio: poster when ffmpeg exists, live player on double-click, Escape exits', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'tone.wav', x: 200, y: 200, buffer: wav() }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['tone.wav'];
  const audio = await node(page, id);
  assert.equal(audio.kind, 'audio');
  assert.deepEqual([audio.width, audio.height], [480, 120]);
  if (ffmpeg) {
    await page.waitForFunction(
      (nodeId) => window.__refthing.nodes.find((n) => n.id === nodeId)?.poster === true,
      id,
      { timeout: 20_000 },
    );
  }

  const center = await nodeCenter(page, id);
  await page.mouse.dblclick(center.x, center.y);
  const player = page.locator('[data-testid="live-media"]');
  await player.waitFor();
  assert.equal(await player.evaluate((element) => element.tagName), 'AUDIO');
  assert.match(await player.getAttribute('src'), /\/blob\/[0-9a-f]{64}\/full$/);
  assert.deepEqual((await state(page)).selection, [id]);
  // The shell goes inert while live: presses reach the player's controls.
  assert.equal(
    await page.locator('.selection-overlay').evaluate((el) => getComputedStyle(el).pointerEvents),
    'none',
  );

  await page.keyboard.press('Escape');
  await player.waitFor({ state: 'detached' });
  assert.deepEqual((await state(page)).selection, [id], 'Escape leaves live mode only');

  // A press outside also exits.
  await page.mouse.dblclick(center.x, center.y);
  await player.waitFor();
  await page.mouse.click(center.x, center.y + 300);
  await player.waitFor({ state: 'detached' });
});

test('video: probed to its frame size, poster painted, live <video> plays', async (t) => {
  if (!ffmpeg) {
    t.skip('ffmpeg not installed');
    return;
  }
  const { page, context } = session;
  const out = `${process.env.TEMP ?? '/tmp'}/refthing-e2e-clip-${Date.now()}.mp4`;
  const made = spawnSync(process.env.REFTHING_FFMPEG ?? 'ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x180:rate=10',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  const { readFileSync, rmSync } = await import('node:fs');
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'clip.mp4', x: 200, y: 200, buffer: readFileSync(out) }],
  });
  rmSync(out, { force: true });
  await openBoard(page, seeded);
  const id = seeded.ids['clip.mp4'];
  const video = await node(page, id);
  assert.equal(video.kind, 'video');
  assert.deepEqual([video.width, video.height], [320, 180]);
  await page.waitForFunction(
    (nodeId) => window.__refthing.nodes.find((n) => n.id === nodeId)?.poster === true,
    id,
    { timeout: 20_000 },
  );

  const center = await nodeCenter(page, id);
  await page.mouse.dblclick(center.x, center.y);
  const player = page.locator('[data-testid="live-media"]');
  await player.waitFor();
  assert.equal(await player.evaluate((element) => element.tagName), 'VIDEO');
  // Sits exactly over the item.
  const box = await player.boundingBox();
  const painted = await page.evaluate((nodeId) => window.__refthing.painted(nodeId), id);
  assert.ok(Math.abs(box.x - painted.x) < 1.5 && Math.abs(box.width - painted.width) < 1.5);
  // Seeking needs Range support on the original.
  const range = await context.request.get(`${BASE_URL}${await player.getAttribute('src')}`, {
    headers: { Range: 'bytes=0-9' },
  });
  assert.equal(range.status(), 206);
  await page.keyboard.press('Escape');
  await player.waitFor({ state: 'detached' });
});

test('Restore Proportions un-squashes an item in one undo step', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    images: [{ name: 'wide.png', x: 200, y: 200, width: 400, height: 100 }],
  });
  const id = seeded.ids['wide.png'];
  // Squash it the way pre-Phase-11 ingest placed everything: 256×256.
  await context.request.patch(`${BASE_URL}/api/boards/${seeded.boardId}/items/${id}`, {
    data: { width: 256, height: 256 },
  });
  await openBoard(page, seeded);
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  const depth = (await state(page)).undoDepth;
  await page.getByRole('menuitem', { name: 'Restore Proportions' }).click();
  await page.waitForTimeout(150);
  await settle(page);
  const fixed = await node(page, id);
  assert.deepEqual([fixed.width, fixed.height], [256, 64]);
  assert.deepEqual([fixed.x, fixed.y], [200, 296], 'center kept');
  assert.equal((await state(page)).undoDepth, depth + 1);
});
