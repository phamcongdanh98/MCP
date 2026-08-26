import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../src/config.js';

export async function temporaryWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workspaceguard-test-')));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function testConfig(root: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    root,
    mode: 'read-only',
    transport: 'stdio',
    host: '127.0.0.1',
    port: 7331,
    httpToken: '',
    allowedCommands: new Set(['git', 'node']),
    allowSensitive: false,
    auditLog: path.join(root, '.workspaceguard', 'audit.jsonl'),
    maxFileBytes: 5_000_000,
    maxOutputBytes: 100_000,
    maxCommandSeconds: 120,
    ...overrides,
  };
}
