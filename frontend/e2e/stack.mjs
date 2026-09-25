/**
 * Global setup for `npm run test:e2e`: boots an ISOLATED RefThing stack — a
 * backend on 7191 whose data dir is a fresh temp folder, and a Vite dev
 * server on 5191 proxying to it — and tears both down afterwards.
 *
 * Tests therefore never touch real boards, no matter what else is running
 * (a dev server, the desktop app, `RefThing Dev`). Set BASE_URL to aim the
 * suite at an already-running stack instead (you own the data it writes).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const API_PORT = 7191;
const WEB_PORT = 5191;
const repo = resolve(import.meta.dirname, '..', '..');
const children = [];
let dataDir = null;

async function waitFor(url, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`e2e stack: ${what} did not come up at ${url}`);
}

function start(command, args, options) {
  const child = spawn(command, args, { ...options, shell: true, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function portInUse(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

export async function globalSetup() {
  if (process.env.BASE_URL) return;
  for (const port of [API_PORT, WEB_PORT]) {
    if (await portInUse(port)) {
      throw new Error(`e2e stack: port ${port} is taken — is another test run still going?`);
    }
  }
  dataDir = mkdtempSync(join(tmpdir(), 'refthing-e2e-'));
  const env = { ...process.env, REFTHING_PORT: String(API_PORT), REFTHING_DATA_DIR: dataDir };
  start(
    'cargo',
    ['run', '--quiet', '--manifest-path', 'backend/Cargo.toml', '-p', 'refthing-server'],
    {
      cwd: repo,
      env,
    },
  );
  start('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: join(repo, 'frontend'),
    env: {
      ...process.env,
      REFTHING_API_PORT: String(API_PORT),
      REFTHING_WEB_PORT: String(WEB_PORT),
    },
  });
  // First run may compile the backend.
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health`, 'backend', 600_000);
  await waitFor(`http://localhost:${WEB_PORT}/`, 'vite', 120_000);
  process.env.BASE_URL = `http://localhost:${WEB_PORT}`;
  // Tests that exercise data-folder files (bindings.toml) write here.
  process.env.E2E_DATA_DIR = dataDir;
}

export async function globalTeardown() {
  for (const child of children) {
    if (child.pid === undefined) continue;
    // shell: true → kill the whole tree (cargo → server, npx → vite).
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  await new Promise((done) => setTimeout(done, 1500));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
