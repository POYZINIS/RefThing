/**
 * Browser gesture harness (RefThing_Testing_Conventions.txt).
 *
 * - Drives REAL input through Playwright's mouse (CDP → genuine
 *   PointerEvents with correct button/buttons, consistent pointerId,
 *   pointerType 'mouse'), one pointermove per sampled path point (§2).
 * - Every test builds its own board through the API — never touches boards
 *   it did not create.
 * - Assertions read `window.__refthing` (dev-only hook in App.tsx), which
 *   exposes the model next to where Pixi actually PAINTED each node.
 *
 * Needs the dev stack running (`npm run dev`, ideally with REFTHING_DATA_DIR
 * pointed at a scratch directory). BASE_URL overrides http://localhost:5173.
 */
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';

// ------------------------------------------------------------ fixtures --

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-color RGB PNG — test fixtures need no image files on disk. */
export function solidPng(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Create an isolated board: `images` [{name, x, y, width, height, color}],
 * `notes` [{x, y, width, height, text}]. Returns { boardId, name }.
 */
export async function seedBoard(request, { images = [], notes = [] } = {}) {
  await request.post(`${BASE_URL}/api/auth/session`);
  const name = `e2e ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`;
  const board = await (await request.post(`${BASE_URL}/api/boards`, { data: { name } })).json();
  const ids = {};
  for (const image of images) {
    const response = await request.post(`${BASE_URL}/api/boards/${board.id}/items:ingest`, {
      multipart: {
        meta: JSON.stringify({ [image.name]: { x: image.x, y: image.y } }),
        file: {
          name: image.name,
          mimeType: 'image/png',
          buffer: solidPng(image.width, image.height, image.color ?? [90, 140, 220]),
        },
      },
    });
    const body = await response.json();
    ids[image.name] = body.items[0].item_id;
  }
  for (const note of notes) {
    const response = await request.post(`${BASE_URL}/api/boards/${board.id}/notes`, {
      data: {
        x: note.x,
        y: note.y,
        width: note.width,
        height: note.height,
        content_json: { text: note.text ?? 'note' },
      },
    });
    const body = await response.json();
    ids[note.name ?? note.text] = body.note.id;
  }
  return { boardId: board.id, name, ids };
}

// ------------------------------------------------------------- browser --

export async function launch() {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  return { browser, context, page, errors };
}

/** Open a seeded board in the UI and wait until its nodes are painted. */
export async function openBoard(page, seeded) {
  await page.goto(BASE_URL);
  await page.locator('.board-row', { hasText: seeded.name }).click();
  await page.waitForFunction(
    (count) => (window.__refthing?.nodes?.length ?? 0) >= count,
    Object.keys(seeded.ids).length,
  );
  await settle(page);
}

/** Two animation frames: React commits, then Pixi paints. */
export function settle(page) {
  return page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

export function state(page) {
  return page.evaluate(() => {
    const hook = window.__refthing;
    return {
      selection: hook.selection,
      editing: hook.editing,
      viewport: hook.viewport,
      nodes: hook.nodes,
      undoDepth: hook.undoDepth,
    };
  });
}

/** Screen-space (client px) center of a node from the model. */
export async function nodeCenter(page, id) {
  return page.evaluate((nodeId) => {
    const hook = window.__refthing;
    const node = hook.nodes.find((candidate) => candidate.id === nodeId);
    const host = document.getElementById('canvas-host').getBoundingClientRect();
    const { x, y, zoom } = hook.viewport;
    return {
      x: host.left + x + (node.x + node.width / 2) * zoom,
      y: host.top + y + (node.y + node.height / 2) * zoom,
    };
  }, id);
}

/**
 * Per-frame alignment probe: where Pixi painted each id and where the
 * selection shell's outline sits, as client-px AABBs — all read in ONE
 * evaluate so every value comes from the same frame. `painted` is keyed by id
 * when given an array.
 */
export function probe(page, ids) {
  return page.evaluate((nodeIds) => {
    const hook = window.__refthing;
    const rect = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      painted: Array.isArray(nodeIds)
        ? Object.fromEntries(nodeIds.map((id) => [id, hook.painted(id)]))
        : hook.painted(nodeIds),
      shell: rect(document.querySelector('.selection-overlay')),
      selection: hook.selection,
    };
  }, ids);
}

export function sameRect(a, b, tolerance = 1.5) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/**
 * Dispatch a sampled path as real pointer input: down at the first sample's
 * origin, one move per sample, `onSample` after each (post-paint), then up.
 * `button`: 'left' | 'middle' | 'right'. `modifiers`: keys held throughout.
 */
export async function drag(page, { from, samples, button = 'left', modifiers = [], onSample }) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (const sample of samples) {
    await page.mouse.move(sample.x, sample.y);
    await settle(page);
    if (onSample) await onSample(sample);
  }
  await page.mouse.up({ button });
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  await settle(page);
}
