/**
 * The DOM chrome must sit exactly on what Pixi painted, on EVERY sampled
 * frame (testing §4 rule 1: no mid-gesture drift). Covers the user-reported
 * regressions: the outline not following a node on its very first drag, and
 * notes/outlines running ahead of the eased canvas while panning.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { at, figureEight } from '../tests/gesture-paths.mjs';
import {
  drag,
  launch,
  nodeCenter,
  openBoard,
  probe,
  sameRect,
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

const layout = {
  images: [{ name: 'a.png', x: 120, y: 120, width: 240, height: 160 }],
  notes: [{ name: 'n', x: 520, y: 140, width: 200, height: 140, text: 'hello' }],
};

for (const kind of ['image', 'note']) {
  test(`${kind}: outline tracks the node through its FIRST drag (figure-8)`, async () => {
    const { page, context } = session;
    const seeded = await seedBoard(context.request, layout);
    await openBoard(page, seeded);
    const id = kind === 'image' ? seeded.ids['a.png'] : seeded.ids.n;
    const center = await nodeCenter(page, id);
    const start = (await state(page)).nodes.find((node) => node.id === id);
    const path = figureEight({
      centerX: center.x,
      centerY: center.y,
      amplitudeX: 160,
      amplitudeY: 90,
      durationMs: 800,
    });
    await drag(page, {
      from: center,
      samples: path,
      onSample: async (sample) => {
        const frame = await probe(page, id);
        assert.deepEqual(frame.selection, [id], at(sample, 'press did not select'));
        const target = kind === 'image' ? frame.painted : frame.note;
        assert.ok(
          sameRect(frame.shell, target),
          at(sample, `outline ${JSON.stringify(frame.shell)} vs node ${JSON.stringify(target)}`),
        );
      },
    });
    // §4 rule 1: the final position matches the path's total displacement
    // (a full figure-8 returns to its origin).
    const last = path.at(-1);
    const zoom = (await state(page)).viewport.zoom;
    const end = (await state(page)).nodes.find((node) => node.id === id);
    assert.ok(Math.abs(end.x - (start.x + (last.x - center.x) / zoom)) < 0.5, `x ${end.x}`);
    assert.ok(Math.abs(end.y - (start.y + (last.y - center.y) / zoom)) < 0.5, `y ${end.y}`);
  });
}

test('pan: notes and the selection outline never lead the eased canvas', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const imageId = seeded.ids['a.png'];
  const noteId = seeded.ids.n;
  const imageCenter = await nodeCenter(page, imageId);
  await page.mouse.click(imageCenter.x, imageCenter.y);
  await settle(page);
  const start = { x: 900, y: 600 };
  const path = figureEight({
    centerX: start.x,
    centerY: start.y,
    amplitudeX: 220,
    amplitudeY: 120,
    durationMs: 600,
  });
  const before = await probe(page, noteId);
  const beforeImage = await probe(page, imageId);
  await drag(page, {
    from: start,
    samples: path,
    button: 'middle',
    onSample: async (sample) => {
      const note = await probe(page, noteId);
      const image = await probe(page, imageId);
      // Image outline vs painted sprite: same camera, same frame.
      assert.ok(
        sameRect(image.shell, image.painted),
        at(
          sample,
          `outline ${JSON.stringify(image.shell)} vs sprite ${JSON.stringify(image.painted)}`,
        ),
      );
      // Note ↔ sprite rigid relationship: both are drawn from the same
      // camera, so their offset never changes during a pan.
      const dx = note.note.x - image.painted.x;
      const dy = note.note.y - image.painted.y;
      const dx0 = before.note.x - beforeImage.painted.x;
      const dy0 = before.note.y - beforeImage.painted.y;
      assert.ok(
        Math.abs(dx - dx0) <= 1.5 && Math.abs(dy - dy0) <= 1.5,
        at(sample, `note drifted from the canvas by (${dx - dx0}, ${dy - dy0})`),
      );
    },
  });
  const final = await state(page);
  assert.deepEqual(final.selection, [imageId], 'pan changed the selection');
});

test('middle-drag starting on a SELECTED node pans instead of moving it', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, layout);
  await openBoard(page, seeded);
  const id = seeded.ids['a.png'];
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await settle(page);
  const before = (await state(page)).nodes.find((node) => node.id === id);
  const viewportBefore = (await state(page)).viewport;
  await drag(page, {
    from: center,
    button: 'middle',
    samples: figureEight({
      centerX: center.x,
      centerY: center.y,
      amplitudeX: 120,
      amplitudeY: 60,
      durationMs: 400,
    }).map((sample) => ({ ...sample, x: sample.x + 80 * (sample.index / 30) })),
  });
  // Let the eased camera arrive.
  await page.waitForTimeout(400);
  const after = await state(page);
  const node = after.nodes.find((candidate) => candidate.id === id);
  assert.deepEqual([node.x, node.y], [before.x, before.y], 'middle-drag moved the item');
  assert.notEqual(after.viewport.x, viewportBefore.x, 'middle-drag did not pan');
});
