/**
 * Notes (interaction conventions §4; testing §3 NOTES SPECIFICALLY):
 * double-click is the only way into Editing, from every prior state; zones are
 * non-interactive while Editing; every exit path commits ONE undo entry.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { drag, launch, nodeCenter, openBoard, seedBoard, settle, state } from './harness.mjs';

let session;
before(async () => {
  session = await launch();
});
after(async () => {
  await session.browser.close();
  assert.deepEqual(session.errors, [], 'page threw');
});

const layout = {
  images: [{ name: 'other.png', x: 600, y: 120, width: 200, height: 150 }],
  notes: [{ name: 'n', x: 120, y: 120, width: 260, height: 160, text: 'before' }],
};

async function textOf(page, id) {
  return page.evaluate(
    (noteId) => window.__refthing.notes?.find((note) => note.id === noteId)?.text ?? null,
    id,
  );
}

function editingTextarea(page) {
  return page.locator('textarea.note-editor');
}

for (const prior of ['idle', 'hovered', 'selected']) {
  test(`double-click enters Editing from ${prior}`, async () => {
    const { page, context } = session;
    const seeded = await seedBoard(context.request, layout);
    await openBoard(page, seeded);
    const id = seeded.ids.n;
    const center = await nodeCenter(page, id);
    if (prior === 'hovered') await page.mouse.move(center.x, center.y);
    if (prior === 'selected') await page.mouse.click(center.x, center.y);
    await settle(page);
    await page.mouse.dblclick(center.x, center.y);
    await settle(page);
    const editor = editingTextarea(page);
    assert.equal(await editor.count(), 1, 'editor did not open');
    assert.equal((await state(page)).editing, id);
    assert.ok(
      await editor.evaluate((element) => element === document.activeElement),
      'editor must take focus',
    );
    await page.keyboard.press('Escape');
    await settle(page);
  });
}

for (const exit of ['escape', 'click-outside', 'select-other']) {
  test(`exit via ${exit} commits the whole session as ONE undo entry`, async () => {
    const { page, context } = session;
    const seeded = await seedBoard(context.request, layout);
    await openBoard(page, seeded);
    const id = seeded.ids.n;
    const center = await nodeCenter(page, id);
    await page.mouse.dblclick(center.x, center.y);
    await settle(page);
    const depth = (await state(page)).undoDepth;
    await page.keyboard.type('hello world, several keystrokes', { delay: 5 });
    if (exit === 'escape') {
      await page.keyboard.press('Escape');
    } else if (exit === 'click-outside') {
      await page.mouse.click(center.x, center.y + 400);
    } else {
      const other = await nodeCenter(page, seeded.ids['other.png']);
      await page.mouse.click(other.x, other.y);
    }
    await page.waitForTimeout(100);
    await settle(page);
    const after = await state(page);
    assert.equal(after.editing, null, 'still editing');
    assert.equal(await editingTextarea(page).count(), 0, 'editor still mounted');
    assert.equal(await textOf(page, id), 'hello world, several keystrokes');
    assert.equal(after.undoDepth, depth + 1, 'one session = one undo entry');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    assert.equal(await textOf(page, id), 'before', 'undo restores the pre-session text');
  });
}

test('zones are NON-interactive while Editing (a corner drag resizes nothing)', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const id = seeded.ids.n;
  const center = await nodeCenter(page, id);
  await page.mouse.dblclick(center.x, center.y);
  await settle(page);
  const before = (await state(page)).nodes.find((node) => node.id === id);
  const corner = await page.evaluate(() => {
    const rect = document.querySelector('.selection-overlay').getBoundingClientRect();
    return { x: rect.right - 2, y: rect.bottom - 2 };
  });
  await drag(page, {
    from: corner,
    samples: Array.from({ length: 30 }, (_, i) => ({
      index: i,
      timeMs: i * 16,
      x: corner.x + 4 * (i + 1),
      y: corner.y + 3 * (i + 1) + 10 * Math.sin(i / 3),
    })),
  });
  const after = (await state(page)).nodes.find((node) => node.id === id);
  assert.deepEqual(
    [after.x, after.y, after.width, after.height],
    [before.x, before.y, before.width, before.height],
    'editing note was transformed',
  );
  assert.equal((await state(page)).editing, id, 'caret placement must not exit editing');
});

test('typing past the bottom auto-grows the note (§4 RULE 6) in the same undo entry', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const id = seeded.ids.n;
  const center = await nodeCenter(page, id);
  await page.mouse.dblclick(center.x, center.y);
  await settle(page);
  const depth = (await state(page)).undoDepth;
  await page.keyboard.type(Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const after = await state(page);
  const note = after.nodes.find((node) => node.id === id);
  assert.ok(note.height > 160, `note did not grow (height ${note.height})`);
  assert.equal(note.width, 260, 'typing must never change width');
  assert.equal(after.undoDepth, depth + 1);
});
