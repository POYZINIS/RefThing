/**
 * 3D model items in the real app: GLB / FBX / .blend become viewports the
 * model worker renders, the sky background toggles without relighting the
 * model, shading switches, and the view only moves in orbit mode — entered
 * by double-clicking a model, never by a first press on it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { glb, sphere } from './glb.mjs';
import {
  BASE_URL,
  launch,
  nodeCenter,
  openBoard,
  pixel,
  seedBoard,
  solidPng,
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

const status = (page, id) => page.evaluate((nodeId) => window.__refthing.model(nodeId), id);
const settings = (page, id) =>
  page.evaluate((nodeId) => window.__refthing.modelSettings(nodeId), id);
/** A view is up: rendered now, or a poster cached by an earlier render of
 *  the same model and view (identical fixtures share one). */
const rendered = (page, id, timeout = 30_000) =>
  page.waitForFunction(
    (nodeId) => ['rendered', 'cached'].includes(window.__refthing.model(nodeId)),
    id,
    { timeout },
  );
const painted = (page, id) => page.evaluate((nodeId) => window.__refthing.painted(nodeId), id);
const close = (actual, expected, epsilon, message) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: ${actual} vs ${expected}`);
/** The default sun's x (normalize(0.45, 0.8, 0.4)). */
const DEFAULT_SUN_X = 0.45 / Math.hypot(0.45, 0.8, 0.4);
const distance = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));

/** Poll a pixel until `done` holds (a new render landed) or time runs out. */
async function pixelUntil(page, point, done, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let value = await pixel(page, point);
  while (!done(value) && Date.now() < deadline) {
    await page.waitForTimeout(150);
    value = await pixel(page, point);
  }
  return value;
}

async function menuPick(page, at, role, name) {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.getByRole(role, { name, exact: true }).click();
  await page.keyboard.press('Escape');
}

test('a GLB is a lit viewport; Background off keeps the model exactly as lit', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'ball.glb', x: 100, y: 100, buffer: glb(sphere()) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['ball.glb'];
  assert.equal((await state(page)).nodes.find((n) => n.id === id)?.kind, 'model');
  await rendered(page, id);

  const box = await painted(page, id);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const corner = { x: box.x + 8, y: box.y + box.height - 8 };
  const outside = { x: box.x + box.width + 40, y: center.y };
  const ball = await pixel(page, center);
  const sky = await pixel(page, corner);
  const board = await pixel(page, outside);
  assert.ok(ball[0] > ball[1] + 40, `the red ball is drawn and lit: ${ball}`);
  assert.ok(distance(sky, board) > 12, `the sky fills behind it: ${sky} vs board ${board}`);

  // Background off: the sky's pixels become the board; the model's don't
  // change at all (it is lit by the same sky either way).
  await menuPick(page, center, 'menuitemcheckbox', 'Background');
  assert.equal((await settings(page, id)).background, false);
  const cleared = await pixelUntil(page, corner, (value) => distance(value, board) <= 12);
  assert.ok(distance(cleared, board) <= 12, `transparent behind: ${cleared} vs ${board}`);
  assert.ok(distance(await pixel(page, center), ball) <= 3, 'the model is lit the same');

  // And back.
  await menuPick(page, center, 'menuitemcheckbox', 'Background');
  const again = await pixelUntil(page, corner, (value) => distance(value, sky) <= 3);
  assert.ok(distance(again, sky) <= 3);
});

test('Shade Flat facets a smooth model; Original brings its own normals back', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'smooth.glb', x: 100, y: 100, buffer: glb(sphere(10, 6)) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['smooth.glb'];
  await rendered(page, id);
  const box = await painted(page, id);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const clip = {
    x: Math.round(center.x - 80),
    y: Math.round(center.y - 80),
    width: 160,
    height: 160,
  };
  const original = await page.screenshot({ clip });

  await menuPick(page, center, 'menuitemradio', 'Flat');
  assert.equal((await settings(page, id)).shading, 'flat');
  await page.waitForTimeout(800);
  const flat = await page.screenshot({ clip });
  assert.ok(!flat.equals(original), 'flat shading looks different');

  await menuPick(page, center, 'menuitemradio', 'Smooth');
  assert.equal((await settings(page, id)).shading, 'smooth');
  await menuPick(page, center, 'menuitemradio', 'Original');
  assert.equal((await settings(page, id)).shading, 'original');
});

test('the view only moves in orbit mode: double-click, drag, wheel, one undo step', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'orbit.glb', x: 100, y: 100, buffer: glb(sphere()) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['orbit.glb'];
  await rendered(page, id);
  const before = await settings(page, id);

  // Never edit without clicking first: a first press on the model moves
  // the item, and the view stays put. So does a drag once it's selected.
  let center = await nodeCenter(page, id);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 60, center.y + 20, { steps: 8 });
  await page.mouse.up();
  const moved = (await state(page)).nodes.find((n) => n.id === id);
  assert.ok(Math.abs(moved.x - 100) > 30, 'the item moved');
  assert.deepEqual(await settings(page, id), before, 'the view did not');
  assert.equal(await page.evaluate(() => window.__refthing.orbiting), null);

  // Double-click: orbit mode on that model.
  center = await nodeCenter(page, id);
  await page.mouse.dblclick(center.x, center.y);
  await page.waitForFunction((nodeId) => window.__refthing.orbiting === nodeId, id);
  const depth = await page.evaluate(() => window.__refthing.undoDepth);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 120, center.y + 40, { steps: 10 });
  await page.mouse.up();
  for (let notch = 0; notch < 3; notch += 1) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(500);
  const turned = await settings(page, id);
  assert.ok(turned.yaw < before.yaw - 0.3, `dragging right turned it: ${turned.yaw}`);
  assert.ok(turned.pitch > before.pitch, 'dragging down raised the camera');
  assert.ok(turned.distance < before.distance, 'the wheel moved in');
  const after = (await state(page)).nodes.find((n) => n.id === id);
  assert.deepEqual([after.x, after.y], [moved.x, moved.y], 'orbiting never moves the item');
  assert.equal(
    await page.evaluate(() => window.__refthing.undoDepth),
    depth + 1,
    'the whole session is one undo step',
  );

  // Escape leaves orbit mode (the model stays selected); undo restores.
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__refthing.orbiting), null);
  assert.deepEqual((await state(page)).selection, [id]);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const restored = await settings(page, id);
  assert.equal(restored.yaw, before.yaw);
  assert.equal(restored.distance, before.distance);
});

test('Alt+drag turns a selected model camera; the item stays put', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'alt.glb', x: 100, y: 100, buffer: glb(sphere(12, 8)) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['alt.glb'];
  await rendered(page, id);
  const before = await settings(page, id);
  const center = await nodeCenter(page, id);

  // Unselected: Alt+drag never touches the view (click first).
  const altDrag = async (dx) => {
    await page.keyboard.down('Alt');
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + dx, center.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
  };
  await altDrag(-80);
  assert.deepEqual(await settings(page, id), before, 'no view change before a click');

  await page.keyboard.press('Escape');
  await page.mouse.click(center.x, center.y);
  const depth = await page.evaluate(() => window.__refthing.undoDepth);
  const placed = (await state(page)).nodes.find((n) => n.id === id);
  await altDrag(120);
  const turned = await settings(page, id);
  assert.ok(turned.yaw < before.yaw - 0.3, `the camera turned: ${turned.yaw}`);
  close(turned.pitch, before.pitch, 1e-6, 'a level drag keeps the horizon (turntable)');
  const after = (await state(page)).nodes.find((n) => n.id === id);
  assert.deepEqual([after.x, after.y], [placed.x, placed.y], 'the item stayed put');
  assert.equal(await page.evaluate(() => window.__refthing.orbiting), null, 'no orbit mode');
  assert.equal(await page.evaluate(() => window.__refthing.undoDepth), depth + 1);

  // Alt+CLICK (no drag) keeps its meaning: reset the aspect to square.
  await page.keyboard.down('Alt');
  await page.mouse.click(center.x, center.y);
  await page.keyboard.up('Alt');
  await page.waitForTimeout(300);
  const square = (await state(page)).nodes.find((n) => n.id === id);
  close(square.width, square.height, 1e-6, 'squared');
  assert.equal((await settings(page, id)).yaw, turned.yaw, 'and the view untouched');
});

/** A selected model's gizmo, and where its marks are on screen. */
async function gizmoMarks(page) {
  const gizmo = page.getByTestId('model-gizmo');
  const middle = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const axis = (label) =>
    middle(gizmo.locator('g.model-gizmo-axis', { hasText: label }).locator('circle'));
  const sun = await middle(gizmo.locator('g.model-gizmo-sun circle'));
  // Somewhere on the ball away from every mark (so a drag there orbits).
  const box = await gizmo.boundingBox();
  const centers = await gizmo.locator('circle').evaluateAll((circles) =>
    circles.map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }),
  );
  let ball = null;
  let best = -1;
  for (let dy = -22; dy <= 22; dy += 4) {
    for (let dx = -22; dx <= 22; dx += 4) {
      if (Math.hypot(dx, dy) > 26) continue;
      const point = { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
      const clear = Math.min(...centers.map((c) => Math.hypot(c.x - point.x, c.y - point.y)));
      if (clear > best) {
        best = clear;
        ball = point;
      }
    }
  }
  return { gizmo, axis, sun, ball };
}

async function dragFrom(page, from, dx, dy = 0) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
}

test('the gizmo: drag the ball to orbit, drag the sun to move the light', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'sun.glb', x: 100, y: 100, buffer: glb(sphere(24, 16), [0.7, 0.7, 0.7, 1]) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['sun.glb'];
  await rendered(page, id);
  assert.equal(await page.getByTestId('model-gizmo').count(), 0, 'nothing until selected');
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await page.getByTestId('model-gizmo').waitFor();
  const before = await settings(page, id);

  // Drag the ball: the camera orbits, the sun stays where it was.
  let marks = await gizmoMarks(page);
  await dragFrom(page, marks.ball, 40);
  const orbited = await settings(page, id);
  assert.ok(orbited.yaw < before.yaw - 0.1, `orbited: ${orbited.yaw}`);
  close(orbited.sunX, before.sunX, 1e-9, 'the sun did not move');

  // Drag the sun: the light swings round; the camera stays.
  const box = await painted(page, id);
  const left = { x: box.x + box.width / 2 - box.height * 0.4, y: box.y + box.height / 2 };
  const right = { x: box.x + box.width / 2 + box.height * 0.4, y: box.y + box.height / 2 };
  const brightness = async (point) => (await pixel(page, point)).reduce((a, b) => a + b, 0);
  await page.waitForTimeout(600);
  const [leftBefore, rightBefore] = [await brightness(left), await brightness(right)];
  marks = await gizmoMarks(page);
  await dragFrom(page, marks.sun, -30);
  const lit = await settings(page, id);
  assert.notEqual(lit.sunX, orbited.sunX, 'the sun moved');
  close(lit.yaw, orbited.yaw, 1e-9, 'the camera did not');
  const placed = (await state(page)).nodes.find((n) => n.id === id);
  assert.deepEqual([placed.x, placed.y], [100, 100], 'the gizmo never moves the item');
  await page.waitForTimeout(800);
  assert.ok((await brightness(left)) > leftBefore + 20, 'lit from the left now');
  assert.ok((await brightness(right)) < rightBefore - 20, 'the right side falls into shade');

  // Double-click the sun: back to the default; deselecting hides the gizmo.
  marks = await gizmoMarks(page);
  await page.mouse.dblclick(marks.sun.x, marks.sun.y);
  await page.waitForTimeout(300);
  close((await settings(page, id)).sunX, DEFAULT_SUN_X, 1e-6, 'default sun');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByTestId('model-gizmo').count(), 0);
});

test('clicking an axis eases to an ortho view down it; orbiting returns to persp', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'axes.glb', x: 100, y: 100, buffer: glb(sphere(12, 8)) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['axes.glb'];
  await rendered(page, id);
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y);
  await page.getByTestId('model-gizmo').waitFor();

  // X: the camera on the +X side, looking straight at it, orthographic.
  let marks = await gizmoMarks(page);
  const x = await marks.axis('X');
  await page.mouse.click(x.x, x.y);
  await page.waitForFunction(
    (nodeId) => window.__refthing.modelSettings(nodeId).projection === 'orthographic',
    id,
  );
  let view = await settings(page, id);
  close(view.yaw, Math.PI / 2, 1e-6, 'facing +X');
  close(view.pitch, 0, 1e-6, 'level');
  assert.equal(view.axisView, true);

  // Clicked again: the opposite side.
  marks = await gizmoMarks(page);
  const again = await marks.axis('X');
  await page.mouse.click(again.x, again.y);
  await page.waitForTimeout(500);
  view = await settings(page, id);
  close(Math.abs(view.yaw), Math.PI / 2, 1e-6, 'facing -X');
  assert.ok(view.yaw < 0);

  // Z (Blender's up): straight down from above.
  marks = await gizmoMarks(page);
  const z = await marks.axis('Z');
  await page.mouse.click(z.x, z.y);
  await page.waitForTimeout(500);
  assert.ok((await settings(page, id)).pitch > Math.PI / 2 - 0.01, 'top view');

  // Orbiting away from an axis view: back to perspective.
  marks = await gizmoMarks(page);
  await dragFrom(page, marks.ball, 30, 10);
  view = await settings(page, id);
  assert.equal(view.projection, 'perspective');
  assert.equal(view.axisView, false);

  // Ortho chosen in the menu stays through an orbit.
  await menuPick(page, center, 'menuitemradio', 'Ortho');
  assert.equal((await settings(page, id)).projection, 'orthographic');
  await page.mouse.click(center.x, center.y);
  marks = await gizmoMarks(page);
  await dragFrom(page, marks.ball, 30);
  assert.equal((await settings(page, id)).projection, 'orthographic', 'menu ortho sticks');
  await menuPick(page, center, 'menuitemradio', 'Persp');
  assert.equal((await settings(page, id)).projection, 'perspective');
});

/** Right-click → Textures → `label`, then pick `png` in the file chooser. */
async function importTexture(page, at, label, png) {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Textures' }).hover();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
  await (await chooser).setFiles({ name: 'texture.png', mimeType: 'image/png', buffer: png });
}

test('textures from the menu: colour, metal + roughness (invertible), packed MRO', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'tex.glb', x: 100, y: 100, buffer: glb(sphere(24, 16), [0.8, 0.8, 0.8, 1]) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['tex.glb'];
  await rendered(page, id);
  const center = await nodeCenter(page, id);
  const box = await painted(page, id);
  // A point on the sphere a little off-centre (lit, with some reflection).
  const probe = { x: box.x + box.width / 2 - box.height * 0.12, y: box.y + box.height * 0.4 };
  const bare = await pixel(page, probe);
  const textures = async () => (await settings(page, id)).textures;

  // Colour: a blue image paints the (white) model blue.
  await importTexture(page, center, 'Color…', solidPng(8, 8, [40, 90, 230]));
  await page.waitForFunction(
    (nodeId) => !!window.__refthing.modelSettings(nodeId).textures.color,
    id,
  );
  const blue = await pixelUntil(page, probe, (value) => value[2] > value[0] + 60);
  assert.ok(blue[2] > blue[0] + 60, `blue now: ${blue}`);

  // Fully metallic (still rough: no roughness map yet) — the look changes.
  await importTexture(page, center, 'Metalness…', solidPng(8, 8, [255, 255, 255]));
  await page.waitForFunction(
    (nodeId) => !!window.__refthing.modelSettings(nodeId).textures.metalness,
    id,
  );
  const roughMetal = await pixelUntil(page, probe, (value) => distance(value, blue) > 12);
  assert.ok(distance(roughMetal, blue) > 12, `metal differs: ${roughMetal} vs ${blue}`);
  // And smooth (a black roughness map): the sky shows in it. Each map's
  // own change is awaited — a pixel read before the roughness map lands
  // is still the rough-metal look.
  await importTexture(page, center, 'Roughness…', solidPng(8, 8, [0, 0, 0]));
  await page.waitForFunction(
    (nodeId) => !!window.__refthing.modelSettings(nodeId).textures.roughness,
    id,
  );
  const metal = await pixelUntil(page, probe, (value) => distance(value, roughMetal) > 6);
  assert.ok(distance(metal, roughMetal) > 6, `smooth differs: ${metal} vs ${roughMetal}`);

  // Invert Roughness (a smoothness map): black now means rough.
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Textures' }).hover();
  await page.getByRole('menuitemcheckbox', { name: 'Invert Roughness' }).click();
  await page.keyboard.press('Escape');
  assert.equal((await settings(page, id)).roughnessInvert, true);
  const inverted = await pixelUntil(page, probe, (value) => distance(value, metal) > 6);
  assert.ok(distance(inverted, metal) > 6, `rough now: ${inverted} vs ${metal}`);

  // Packed MRO: one texture replaces metalness / roughness / AO.
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Textures' }).hover();
  await page.getByRole('menuitemcheckbox', { name: 'Packed MRO' }).click();
  await page.keyboard.press('Escape');
  assert.equal((await settings(page, id)).packedMro, true);
  await importTexture(page, center, 'MRO…', solidPng(8, 8, [0, 255, 255]));
  await page.waitForFunction(
    (nodeId) => !!window.__refthing.modelSettings(nodeId).textures.mro,
    id,
  );

  // The texture is a blob of its own, served like any other.
  const hash = (await textures()).color;
  const served = await context.request.get(`${BASE_URL}/blob/${hash}/full`);
  assert.equal(served.status(), 200);

  // Clear Textures: back to the model's own look; one undo brings them back.
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Textures' }).hover();
  await page.getByRole('menuitem', { name: 'Clear Textures' }).click();
  assert.deepEqual(await textures(), {});
  const back = await pixelUntil(page, probe, (value) => distance(value, bare) <= 4);
  assert.ok(distance(back, bare) <= 4, `bare again: ${back} vs ${bare}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  assert.ok((await textures()).color, 'undo restores them');
});

test('the Textures submenu opens with the keyboard and closes with ←', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'keys.glb', x: 100, y: 100, buffer: glb(sphere(8, 6)) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['keys.glb'];
  await rendered(page, id);
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  const row = page.getByRole('menuitem', { name: 'Textures' });
  await row.focus();
  await page.keyboard.press('ArrowRight');
  const submenu = page.getByRole('menu', { name: 'Textures' });
  await submenu.waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    'Color…',
    'focus moves into the submenu',
  );
  await page.keyboard.press('ArrowLeft');
  assert.equal(await submenu.count(), 0, 'closed');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Textures');
  await page.keyboard.press('Escape');
});

test('Sample Colors on a model samples the model, never its sky', async () => {
  const { page, context } = session;
  const seeded = await seedBoard(context.request, {
    files: [{ name: 'red.glb', x: 100, y: 100, buffer: glb(sphere(24, 16), [0.8, 0.08, 0.05, 1]) }],
  });
  await openBoard(page, seeded);
  const id = seeded.ids['red.glb'];
  await rendered(page, id);
  assert.equal((await settings(page, id)).background, true, 'the sky is on');
  const center = await nodeCenter(page, id);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Sample Colors' }).click();
  await page.waitForFunction(
    () => window.__refthing.nodes.some((node) => node.kind === 'palette'),
    null,
    {
      timeout: 20_000,
    },
  );
  const palette = (await page.evaluate(() => window.__refthing.nodes)).find(
    (node) => node.kind === 'palette',
  );
  assert.ok(palette.colors.length >= 1);
  for (const hex of palette.colors) {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    // The lit red sphere, dark to bright: red leads every swatch — no sky
    // blue, no pale horizon, no grey ground.
    assert.ok(r >= g && r >= b && r - b > 20, `a model colour, not sky: ${hex}`);
  }
});

// ------------------------------------------------------------ Blender files

/** Blender, where the server would find it too (env, PATH, Steam). */
function findBlender() {
  if (process.env.REFTHING_BLENDER) return process.env.REFTHING_BLENDER;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], {
    encoding: 'utf8',
  });
  const onPath = which.status === 0 ? which.stdout.split(/\r?\n/)[0]?.trim() : '';
  if (onPath) return onPath;
  const steam = 'C:/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe';
  return existsSync(steam) ? steam : null;
}
const blender = findBlender();

/** Run a Blender script headless in a temp dir; returns the file it wrote. */
function withBlender(script, name) {
  const dir = mkdtempSync(join(tmpdir(), 'refthing-blend-'));
  const out = join(dir, name).replaceAll('\\', '/');
  const run = spawnSync(
    blender,
    ['--background', '--factory-startup', '--python-exit-code', '1', '--python-expr', script(out)],
    { encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const bytes = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** The default cube with a dark red base colour (linear 0.2, 0.02, 0.02). */
const redCube = `
import bpy
material = bpy.data.materials.new("Red")
material.diffuse_color = (0.2, 0.02, 0.02, 1)
material.use_nodes = True
material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.2, 0.02, 0.02, 1)
bpy.data.objects["Cube"].data.materials.clear()
bpy.data.objects["Cube"].data.materials.append(material)
`;

test('a .blend opens through Blender; a Blender FBX keeps its colours', {
  skip: blender ? false : 'Blender not installed',
  timeout: 180_000,
}, async () => {
  const { page, context } = session;
  const blend = withBlender(
    (out) => `${redCube}\nbpy.ops.wm.save_as_mainfile(filepath="${out}", compress=True)`,
    'cube.blend',
  );
  const fbx = withBlender(
    (out) => `${redCube}\nbpy.ops.export_scene.fbx(filepath="${out}", object_types={"MESH"})`,
    'cube.fbx',
  );
  const seeded = await seedBoard(context.request, {
    files: [
      { name: 'cube.blend', x: 0, y: 0, buffer: blend },
      { name: 'cube.fbx', x: 700, y: 0, buffer: fbx },
    ],
  });
  await openBoard(page, seeded);
  for (const name of ['cube.blend', 'cube.fbx']) {
    const id = seeded.ids[name];
    await page.waitForFunction((nodeId) => window.__refthing.model(nodeId) !== 'card', id, {
      timeout: 120_000,
    });
    assert.equal(await status(page, id), 'rendered', `${name}: ${await status(page, id)}`);
    // The cube's lit faces: red, and not crushed towards black (FBX colours
    // are linear; reading them as sRGB would darken this to ~60).
    const box = await painted(page, id);
    let reddest = [0, 0, 0];
    for (let row = 1; row < 6; row += 1) {
      for (let column = 1; column < 6; column += 1) {
        const value = await pixel(page, {
          x: box.x + (box.width * column) / 6,
          y: box.y + (box.height * row) / 6,
        });
        if (value[0] - value[1] > reddest[0] - reddest[1]) reddest = value;
      }
    }
    assert.ok(reddest[0] > 100 && reddest[0] > reddest[1] * 2, `${name} is red: ${reddest}`);
  }
});
