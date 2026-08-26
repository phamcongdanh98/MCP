import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PathPolicy } from '../src/security/path-policy.js';
import { CommandService } from '../src/services/process.js';
import { temporaryWorkspace, testConfig } from './helpers.js';

test('CommandService requires command mode and an allowlisted executable', async () => {
  const workspace = await temporaryWorkspace();
  try {
    const policy = new PathPolicy(workspace.root, false);
    const disabled = new CommandService(testConfig(workspace.root), policy);
    await assert.rejects(
      disabled.run({ program: 'node', args: ['--version'], cwd: '', timeoutSeconds: 5 }),
      /requires --mode command/,
    );
    const enabled = new CommandService(
      testConfig(workspace.root, { mode: 'command', allowedCommands: new Set(['node']), maxOutputBytes: 32 }),
      policy,
    );
    await assert.rejects(
      enabled.run({ program: 'sh', args: ['-c', 'echo unsafe'], cwd: '', timeoutSeconds: 5 }),
      /not allowlisted/,
    );
    const result = await enabled.run({
      program: 'node',
      args: ['-e', "process.stdout.write('x'.repeat(100))"],
      cwd: '',
      timeoutSeconds: 5,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /truncated 68 bytes/);
  } finally {
    await workspace.cleanup();
  }
});
