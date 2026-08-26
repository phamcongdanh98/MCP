import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConnectionStore } from '../src/desktop/connection-store.js';

const cipher = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from([...value].reverse().join(''), 'utf8'),
  decrypt: (value: Buffer) => [...value.toString('utf8')].reverse().join(''),
};

test('connection store keeps preferences separate from encrypted runtime API key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workspaceguard-connection-'));
  try {
    const store = new ConnectionStore(directory, cipher);
    await store.save({
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      tunnelClientPath: '/Applications/tunnel-client',
      profile: 'safe-profile',
      apiKey: 'test_runtime_api_key_1234567890',
    });
    const loaded = await store.load();
    assert.deepEqual(loaded, {
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      tunnelClientPath: '/Applications/tunnel-client',
      profile: 'safe-profile',
      hasApiKey: true,
    });
    assert.equal(await store.runtimeApiKey(), 'test_runtime_api_key_1234567890');
    assert.equal((await readFile(path.join(directory, 'tunnel-connection.json'), 'utf8')).includes('test_runtime_api_key_1234567890'), false);
    assert.equal((await readFile(path.join(directory, 'tunnel-runtime-key.bin'), 'utf8')).includes('test_runtime_api_key_1234567890'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
