/**
 * Phase 11 item types in the real app: any file lands as a card, audio (and
 * video) get server posters and — once selected — a player with custom
 * controls that each reveal on hover, and squashed items get their
 * proportions back.
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

  // The card is painted on the canvas (its dark face, CARD_BG #2b2f2d — not
  // the board).
  const corner = await page.evaluate((nodeId) => window.__refthing.painted(nodeId), id);
  assert.ok(corner, 'painted');
  const face = await pixel(page, { x: corner.x + 6, y: corner.y + 6 });
  assert.ok(Math.abs(face[0] - 0x2b) < 8 && Math.abs(face[2] - 0x2d) < 8, `card face ${face}`);

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

const opacityOf = (locator) =>
  locator.evaluate((element) => Number(getComputedStyle(element).opacity));

test('audio: selecting mounts the player; each control reveals on its own', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'tone.wav', x: 200, y: 200, buffer: wav(2) }],
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

  const player = page.locator('[data-testid="live-media"]');
  assert.equal(await player.count(), 0, 'no player until selected');
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await player.waitFor({ state: 'attached' });
  assert.equal(await player.evaluate((element) => element.tagName), 'AUDIO');
  assert.match(await player.getAttribute('src'), /\/blob\/[0-9a-f]{64}\/full$/);

  // Controls reveal independently: near the play button only it shows.
  const play = page.locator('.media-play');
  const scrub = page.locator('.media-scrub');
  await page.mouse.move(center.x, center.y);
  await page.waitForTimeout(700);
  assert.equal(await opacityOf(play), 0, 'nothing shows away from the controls');
  const playBox = await play.boundingBox();
  await page.mouse.move(playBox.x + playBox.width / 2, playBox.y + playBox.height / 2);
  await page.waitForTimeout(300);
  assert.equal(await opacityOf(play), 1, 'the play button shows near it');
  assert.equal(await opacityOf(scrub), 0, 'the scrub bar stays hidden');

  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="live-media"]').paused);
  assert.equal(await page.getByRole('button', { name: 'Pause' }).count(), 1);

  // Scrub to the middle.
  const track = page.getByRole('slider', { name: 'Seek' });
  const trackBox = await track.boundingBox();
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height / 2);
  await page.waitForTimeout(300);
  assert.equal(await opacityOf(scrub), 1, 'the scrub bar shows near it');
  await page.mouse.click(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height / 2);
  const at = await player.evaluate((element) => element.currentTime / element.duration);
  assert.ok(Math.abs(at - 0.5) < 0.12, `seeked to the middle: ${at}`);
  assert.deepEqual((await state(page)).selection, [id], 'controls never change the selection');

  // Deselecting stops it.
  await page.keyboard.press('Escape');
  await player.waitFor({ state: 'detached' });
});

test('video: probed to its frame size, poster painted, double-click plays over the item', async (t) => {
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
  const player = page.locator('[data-testid="live-media"]');
  // Double-click on an unselected clip selects it AND starts it.
  await page.mouse.dblclick(center.x, center.y);
  await player.waitFor();
  assert.equal(await player.evaluate((element) => element.tagName), 'VIDEO');
  await page.waitForFunction(() => !document.querySelector('[data-testid="live-media"]').paused);
  // Sits exactly over the item.
  const box = await player.boundingBox();
  const painted = await page.evaluate((nodeId) => window.__refthing.painted(nodeId), id);
  assert.ok(Math.abs(box.x - painted.x) < 1.5 && Math.abs(box.width - painted.width) < 1.5);
  // Double-click again pauses.
  await page.mouse.dblclick(center.x, center.y);
  await page.waitForFunction(() => document.querySelector('[data-testid="live-media"]').paused);
  // Videos loop by default; the loop control turns it off.
  assert.equal(await player.evaluate((element) => element.loop), true);
  const loop = page.getByRole('button', { name: 'Loop' });
  const loopBox = await loop.boundingBox();
  await page.mouse.move(loopBox.x + loopBox.width / 2, loopBox.y + loopBox.height / 2);
  await loop.click();
  assert.equal(await player.evaluate((element) => element.loop), false);
  // Seeking needs Range support on the original.
  const range = await context.request.get(`${BASE_URL}${await player.getAttribute('src')}`, {
    headers: { Range: 'bytes=0-9' },
  });
  assert.equal(range.status(), 206);
  await page.keyboard.press('Escape');
  await player.waitFor({ state: 'detached' });
});

test('volume slides out from its button, works, and nothing sticks after a click', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'level.wav', x: 200, y: 200, buffer: wav(2) }],
  });
  await openBoard(page, seeded);
  const center = await nodeCenter(page, seeded.ids['level.wav']);
  await page.mouse.click(center.x, center.y);
  const player = page.locator('[data-testid="live-media"]');
  await player.waitFor({ state: 'attached' });

  // Button → across the gap → slider: the slider stays out the whole way.
  const mute = await page.getByRole('button', { name: /Mute|Unmute/ }).boundingBox();
  await page.mouse.move(mute.x + mute.width / 2, mute.y + mute.height / 2);
  await page.waitForTimeout(250);
  const slider = page.getByRole('slider', { name: 'Volume' });
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.waitForTimeout(300);
  assert.equal(await opacityOf(slider), 1, 'the slider stays while the pointer is on it');
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  assert.ok((await player.evaluate((element) => element.volume)) < 0.5, 'volume set');

  // Moving off hides it even though the click focused it.
  await page.mouse.move(center.x, center.y);
  await page.waitForTimeout(300);
  assert.equal(await opacityOf(slider), 0, 'gone after moving off');

  // Same for the play button after clicking it.
  const play = await page.locator('.media-play').boundingBox();
  await page.mouse.move(play.x + play.width / 2, play.y + play.height / 2);
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Play' }).click();
  await page.mouse.move(center.x + 120, center.y);
  await page.waitForTimeout(300);
  assert.equal(await opacityOf(page.locator('.media-play')), 0, 'play hides after a click');
  await page.keyboard.press('Escape');
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
