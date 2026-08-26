import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { PathPolicy } from '../src/security/path-policy.js';
import { temporaryWorkspace } from './helpers.js';

test('PathPolicy rejects absolute paths, traversal, and sensitive files', async () => {
  const workspace = await temporaryWorkspace();
  try {
    const policy = new PathPolicy(workspace.root, false);
    await assert.rejects(policy.resolve('/etc/passwd'), /Absolute paths/);
    await assert.rejects(policy.resolve('../outside', { allowMissing: true }), /escapes/);
    await assert.rejects(policy.resolve('.env', { allowMissing: true }), /Sensitive path/);
  } finally {
    await workspace.cleanup();
  }
});

test('PathPolicy rejects a symlink escape through an existing ancestor', async (t) => {
  const workspace = await temporaryWorkspace();
  const outside = await temporaryWorkspace();
  try {
    await mkdir(path.join(outside.root, 'secret'));
    await writeFile(path.join(outside.root, 'secret', 'data.txt'), 'outside');
    try {
      await symlink(
        path.join(outside.root, 'secret'),
        path.join(workspace.root, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Windows runner does not grant symlink privileges');
        return;
      }
      throw error;
    }
    const policy = new PathPolicy(workspace.root, false);
    await assert.rejects(policy.resolve('escape/data.txt'), /escapes/);
  } finally {
    await workspace.cleanup();
    await outside.cleanup();
  }
});
