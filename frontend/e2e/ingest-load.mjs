/**
 * Phase 9 ingest load test (not part of the e2e suite).
 *
 *   node e2e/ingest-load.mjs [files=2000] [perRequest=50] [concurrency=4]
 *
 * Boots the isolated e2e stack (temp data dir), uploads `files` distinct PNGs
 * through the real multipart ingest endpoint — 90% 400×300, 10% 3000×2000 to
 * exercise the pyramid — then waits for the background job queue to drain
 * and verifies every item has its derivatives.
 */
import { deflateSync } from 'node:zlib';
import { globalSetup, globalTeardown } from './stack.mjs';

const files = Number(process.argv[2] ?? 2000);
const perRequest = Number(process.argv[3] ?? 50);
const concurrency = Number(process.argv[4] ?? 4);
const API = 'http://localhost:7191';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A distinct gradient PNG per index (unique bytes → unique blob hash). */
function png(index, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = (x + index) & 255;
      row[2 + x * 3] = (y * 3 + index * 7) & 255;
      row[3 + x * 3] = (index * 13) & 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const json = async (response) => {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
};

await globalSetup();
try {
  const board = await json(
    await fetch(`${API}/api/boards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `ingest load ${files}` }),
    }),
  );
  console.log(`generating ${files} PNGs…`);
  const payloads = Array.from({ length: files }, (_, index) =>
    index % 10 === 9 ? png(index, 3000, 2000) : png(index, 400, 300),
  );
  const totalBytes = payloads.reduce((sum, bytes) => sum + bytes.length, 0);

  let next = 0;
  let uploaded = 0;
  const errors = [];
  const started = performance.now();
  async function uploader() {
    while (next < files) {
      const start = next;
      next += perRequest;
      const form = new FormData();
      for (let index = start; index < Math.min(files, start + perRequest); index += 1) {
        form.append(
          'file',
          new Blob([payloads[index]], { type: 'image/png' }),
          `load-${index}.png`,
        );
      }
      try {
        const body = await json(
          await fetch(`${API}/api/boards/${board.id}/items:ingest`, { method: 'POST', body: form }),
        );
        uploaded += body.items.length;
      } catch (error) {
        errors.push(String(error));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, uploader));
  const uploadSeconds = (performance.now() - started) / 1000;

  let health;
  for (;;) {
    health = await json(await fetch(`${API}/api/health`));
    if (health.pending_jobs === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const drainSeconds = (performance.now() - started) / 1000;

  const snapshot = await json(await fetch(`${API}/api/boards/${board.id}`));
  const missing = snapshot.blobs.filter(
    (blob) => !blob.levels || Object.keys(blob.levels).length === 0,
  );
  const mb = totalBytes / 1024 / 1024;
  console.log(
    [
      `files uploaded      ${uploaded}/${files} (${mb.toFixed(0)} MB, ${perRequest}/request × ${concurrency} parallel)`,
      `upload              ${uploadSeconds.toFixed(1)}s  → ${(uploaded / uploadSeconds).toFixed(0)} files/s, ${(mb / uploadSeconds).toFixed(1)} MB/s`,
      `jobs drained        ${drainSeconds.toFixed(1)}s after start (pyramids for every file)`,
      `failed jobs         ${health.failed_jobs}`,
      `items on board      ${snapshot.items.length}`,
      `blobs w/o levels    ${missing.length}`,
      `request errors      ${errors.length}${errors.length ? ` — ${errors[0]}` : ''}`,
    ].join('\n'),
  );
  if (errors.length || health.failed_jobs || missing.length || snapshot.items.length !== files) {
    process.exitCode = 1;
  }
} finally {
  await globalTeardown();
}
