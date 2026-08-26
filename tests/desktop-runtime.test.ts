import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DesktopRuntimeController, validateDesktopSettings } from '../src/desktop/runtime.js';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  return address.port;
}

test('desktop settings reject invalid port and command names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspaceguard-desktop-settings-'));
  try {
    await assert.rejects(
      validateDesktopSettings({ root, mode: 'read-only', port: 80, allowedCommands: [] }),
      /1024–65535/,
    );
    await assert.rejects(
      validateDesktopSettings({ root, mode: 'command', port: 17331, allowedCommands: ['node;rm'] }),
      /không hợp lệ/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop controller starts the real MCP server and stops it', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspaceguard-desktop-runtime-'));
  const controller = new DesktopRuntimeController({
    serverEntry: path.resolve('src/index.ts'),
    nodeArguments: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs')],
  });
  context.after(async () => {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  });

  const port = await availablePort();
  const started = await controller.start({ root, mode: 'read-only', port, allowedCommands: [] });
  assert.equal(started.status, 'running');
  assert.equal(started.root, await realpath(root));
  assert.ok(started.logs.some((line) => line.includes('HTTP ready')));

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.deepEqual(await health.json(), { status: 'ok', mode: 'read-only' });

  const stopped = await controller.stop();
  assert.equal(stopped.status, 'stopped');
});
