import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { PathPolicy } from '../src/security/path-policy.js';
import { GitService } from '../src/services/git.js';
import { temporaryWorkspace, testConfig } from './helpers.js';

const execFileAsync = promisify(execFile);

test('GitService reads status from an in-workspace repository', async () => {
  const workspace = await temporaryWorkspace();
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace.root });
    await writeFile(path.join(workspace.root, 'new.txt'), 'untracked');
    const config = testConfig(workspace.root);
    const service = new GitService(config, new PathPolicy(workspace.root, false));
    const result = await service.status('');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /\? new\.txt/);
  } finally {
    await workspace.cleanup();
  }
});

test('GitService rejects .git indirection files', async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeFile(path.join(workspace.root, '.git'), 'gitdir: /tmp/outside\n');
    const config = testConfig(workspace.root);
    const service = new GitService(config, new PathPolicy(workspace.root, false));
    await assert.rejects(service.status(''), /in-workspace \.git directory/);
  } finally {
    await workspace.cleanup();
  }
});

test('GitService does not let an unscoped diff bypass sensitive-path blocking', async () => {
  const workspace = await temporaryWorkspace();
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace.root });
    await writeFile(path.join(workspace.root, '.env'), 'TOKEN=secret\n');
    const config = testConfig(workspace.root);
    const service = new GitService(config, new PathPolicy(workspace.root, false));
    await assert.rejects(service.diff('', [], false), /Explicit file paths are required/);
    await assert.rejects(service.diff('', ['.env'], false), /Sensitive path/);
  } finally {
    await workspace.cleanup();
  }
});
