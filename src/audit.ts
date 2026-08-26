import { appendFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { PathPolicy } from './security/path-policy.js';

export interface AuditEvent {
  requestId: string;
  tool: string;
  outcome: 'success' | 'error';
  durationMs: number;
  summary: Record<string, unknown>;
  errorCode?: string;
}

export class AuditLog {
  #pending: Promise<void> = Promise.resolve();
  readonly #policy: PathPolicy;

  constructor(
    readonly root: string,
    readonly filePath: string,
  ) {
    this.#policy = new PathPolicy(root, true);
  }

  record(event: AuditEvent): Promise<void> {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
    this.#pending = this.#pending
      .catch(() => undefined)
      .then(async () => {
        const relative = path.relative(this.root, this.filePath);
        const target = await this.#policy.resolve(relative, { allowMissing: true, internal: true });
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const checkedTarget = await this.#policy.resolve(relative, { allowMissing: true, internal: true });
        await appendFile(checkedTarget, line, { encoding: 'utf8', mode: 0o600 });
        if (process.platform !== 'win32') await chmod(checkedTarget, 0o600);
      });
    return this.#pending;
  }
}
