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
import { launch, nodeCenter, openBoard, pixel, seedBoard, state } from './harness.mjs';

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
