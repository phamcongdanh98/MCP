import assert from 'node:assert/strict';
import { access, lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { FileService } from '../src/services/files.js';
import { temporaryWorkspace, testConfig } from './helpers.js';

test('FileService reads metadata and enforces optimistic writes', async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeFile(path.join(workspace.root, 'note.txt'), 'before\n');
    const service = new FileService(testConfig(workspace.root, { mode: 'workspace-write' }));
    const initial = await service.readFile('note.txt');
    assert.equal(initial.content, 'before\n');
    assert.match(initial.sha256, /^[a-f0-9]{64}$/);

    const preview = await service.writeFile({
      relativePath: 'note.txt',
      content: 'after\n',
      append: false,
      dryRun: true,
      expectedSha256: initial.sha256,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(await readFile(path.join(workspace.root, 'note.txt'), 'utf8'), 'before\n');

    await service.writeFile({
      relativePath: 'note.txt',
      content: 'after\n',
      append: false,
      dryRun: false,
      expectedSha256: initial.sha256,
    });
    assert.equal(await readFile(path.join(workspace.root, 'note.txt'), 'utf8'), 'after\n');
    await assert.rejects(
      service.writeFile({
        relativePath: 'note.txt',
        content: 'stale',
        append: false,
        dryRun: false,
        expectedSha256: initial.sha256,
      }),
      /does not match/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test('FileService uses recoverable trash and hides internal state', async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeFile(path.join(workspace.root, 'remove-me.txt'), 'recoverable');
    const service = new FileService(testConfig(workspace.root, { mode: 'workspace-write' }));
    const result = await service.trashPath('remove-me.txt', false);
    await assert.rejects(access(path.join(workspace.root, 'remove-me.txt')));
    assert.equal(await readFile(path.join(workspace.root, String(result.trashPath)), 'utf8'), 'recoverable');
    const listing = await service.listFiles('');
    assert.equal(listing.entries.some((entry) => entry.name === '.workspaceguard'), false);
  } finally {
    await workspace.cleanup();
  }
});

test('trash_path moves a symlink entry, not the file it points to', async (t) => {
  const workspace = await temporaryWorkspace();
  try {
    await writeFile(path.join(workspace.root, 'target.txt'), 'keep target');
    try {
      await symlink('target.txt', path.join(workspace.root, 'link.txt'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Windows runner does not grant symlink privileges');
        return;
      }
      throw error;
    }
    const service = new FileService(testConfig(workspace.root, { mode: 'workspace-write' }));
    const result = await service.trashPath('link.txt', false);
    assert.equal(await readFile(path.join(workspace.root, 'target.txt'), 'utf8'), 'keep target');
    assert.equal((await lstat(path.join(workspace.root, String(result.trashPath)))).isSymbolicLink(), true);
  } finally {
    await workspace.cleanup();
  }
});

test('FileService searches bounded text and skips secrets', async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeFile(path.join(workspace.root, 'visible.txt'), 'alpha\nneedle\nomega\n');
    await writeFile(path.join(workspace.root, '.env'), 'needle=secret\n');
    const service = new FileService(testConfig(workspace.root));
    const result = await service.searchContent({
      query: 'needle',
      subpath: '',
      caseSensitive: false,
      contextLines: 1,
      maxResults: 20,
    });
    const matches = result.matches as Array<{ path: string; line: number }>;
    assert.deepEqual(matches.map((match) => match.path), ['visible.txt']);
    assert.equal(matches[0]?.line, 2);
  } finally {
    await workspace.cleanup();
  }
});
