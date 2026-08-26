import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConfig } from '../src/config.js';
import { temporaryWorkspace } from './helpers.js';

test('parseConfig defaults to the least-privileged stdio mode', async () => {
  const workspace = await temporaryWorkspace();
  try {
    const config = await parseConfig(['--root', workspace.root]);
    assert.equal(config.mode, 'read-only');
    assert.equal(config.transport, 'stdio');
    assert.equal(config.host, '127.0.0.1');
    assert.deepEqual([...config.allowedCommands], ['git', 'node', 'npm', 'npx']);
  } finally {
    await workspace.cleanup();
  }
});

test('parseConfig validates command allowlist entries', async () => {
  const workspace = await temporaryWorkspace();
  try {
    await assert.rejects(
      parseConfig(['--root', workspace.root, '--mode', 'command', '--allow-command', '../bash']),
      /Invalid command allowlist entry/,
    );
  } finally {
    await workspace.cleanup();
  }
});
