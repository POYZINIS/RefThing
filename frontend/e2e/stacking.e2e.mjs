/**
 * One paint order for every kind: selecting ANY node brings it to the top,
 * images can cover notes, and the selection chrome sits above all content.
 * Paint order is asserted from real screen pixels, not from the model.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  drag,
  launch,
  openBoard,
  pixel,
  seedBoard,
  settle,
  state,
  worldToClient,
} from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

const BLUE = [40, 90, 230];
// Image under, note on top (created later → higher z), overlapping.
const layout = {
  images: [{ name: 'under.png', x: 100, y: 100, width: 300, height: 200, color: BLUE }],
  notes: [{ name: 'over', x: 250, y: 180, width: 220, height: 160, text: '', fill: '#f5e7ad' }],
};

const isBlue = ([r, , b]) => b > 180 && r < 90;
const isNoteYellow = ([r, g, b]) => r > 220 && g > 200 && b < 200;

test('selecting the image under a note brings it above the note (paint + hit)', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const overlap = await worldToClient(page, { x: 320, y: 240 });
  const imageOnly = await worldToClient(page, { x: 150, y: 140 });

  assert.ok(isNoteYellow(await pixel(page, overlap)), 'note should start on top');
  await page.mouse.click(overlap.x, overlap.y);
  await settle(page);
  assert.deepEqual((await state(page)).selection, [seeded.ids.over], 'top hit is the note');

  await page.mouse.click(imageOnly.x, imageOnly.y);
  await page.waitForTimeout(100);
  await settle(page);
  assert.ok(isBlue(await pixel(page, overlap)), 'selected image must paint above the note');
  await page.mouse.click(overlap.x, overlap.y);
  await settle(page);
  assert.deepEqual(
    (await state(page)).selection,
    [seeded.ids['under.png']],
    'the raised image must also win the hit test',
  );

  // And back: selecting the note raises it again.
  const noteOnly = await worldToClient(page, { x: 440, y: 320 });
  await page.mouse.click(noteOnly.x, noteOnly.y);
  await page.waitForTimeout(100);
  await settle(page);
  assert.ok(isNoteYellow(await pixel(page, overlap)), 'note should come back on top');
});

test('the selection outline is the topmost element along its whole edge', async () => {
  const { page, context } = session;
  // Clear of the floating search bar (UI chrome, deliberately above the board).
  const low = {
    images: layout.images.map((image) => ({ ...image, y: image.y + 250 })),
    notes: layout.notes.map((note) => ({ ...note, y: note.y + 250 })),
  };
  const seeded = await seedBoard(context.request, low);
  await openBoard(page, seeded);
  // Box-select both (mixed kinds) from empty canvas.
  const from = await worldToClient(page, { x: 60, y: 310 });
  const to = await worldToClient(page, { x: 520, y: 630 });
  await drag(page, {
    from,
    samples: Array.from({ length: 30 }, (_, i) => ({
      index: i,
      timeMs: i * 16,
      x: from.x + ((to.x - from.x) * (i + 1)) / 30,
      y: from.y + ((to.y - from.y) * (i + 1)) / 30,
    })),
  });
  const { selection } = await state(page);
  assert.deepEqual(
    [...selection].sort(),
    [seeded.ids['under.png'], seeded.ids.over].sort(),
    'box select must take the note AND the image',
  );
  assert.equal(await page.locator('.selection-overlay').count(), 1, 'exactly one combined box');
  const covered = await page.evaluate(() => {
    const shell = document.querySelector('.selection-overlay');
    const rect = shell.getBoundingClientRect();
    const misses = [];
    for (let i = 0; i <= 20; i += 1) {
      const t = i / 20;
      for (const [x, y] of [
        [rect.left + rect.width * t, rect.top + 1],
        [rect.left + rect.width * t, rect.bottom - 1],
        [rect.left + 1, rect.top + rect.height * t],
        [rect.right - 1, rect.top + rect.height * t],
      ]) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === shell || shell.contains(hit))) {
          misses.push({ x, y, hit: hit?.className ?? null });
        }
      }
    }
    return misses;
  });
  assert.deepEqual(covered, [], 'something covered the selection outline');
});

test('dragging a mixed note+image selection moves both as ONE undo entry', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  await page.keyboard.down('Shift');
  const image = await worldToClient(page, { x: 150, y: 140 });
  const note = await worldToClient(page, { x: 440, y: 320 });
  await page.mouse.click(image.x, image.y);
  await page.mouse.click(note.x, note.y);
  await page.keyboard.up('Shift');
  await settle(page);
  const start = await state(page);
  assert.equal(start.selection.length, 2, 'Shift+click builds a mixed selection');
  const depth = start.undoDepth;
  await drag(page, {
    from: image,
    samples: Array.from({ length: 30 }, (_, i) => ({
      index: i,
      timeMs: i * 16,
      x: image.x + 3 * (i + 1),
      y: image.y + 2 * (i + 1),
    })),
  });
  const moved = await state(page);
  const zoom = moved.viewport.zoom;
  for (const id of start.selection) {
    const before = start.nodes.find((node) => node.id === id);
    const after = moved.nodes.find((node) => node.id === id);
    assert.ok(Math.abs(after.x - before.x - 90 / zoom) < 0.5, `${id} x`);
    assert.ok(Math.abs(after.y - before.y - 60 / zoom) < 0.5, `${id} y`);
  }
  assert.equal(moved.undoDepth, depth + 1, 'one gesture = one undo entry');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  const undone = await state(page);
  for (const id of start.selection) {
    const before = start.nodes.find((node) => node.id === id);
    const after = undone.nodes.find((node) => node.id === id);
    assert.deepEqual([after.x, after.y], [before.x, before.y], `${id} undo`);
  }
});
