import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceError } from '../errors.js';

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
]);

function comparisonPath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface ResolveOptions {
  allowMissing?: boolean;
  allowRoot?: boolean;
  internal?: boolean;
}

export class PathPolicy {
  readonly root: string;
  readonly #rootForComparison: string;

  constructor(root: string, readonly allowSensitive: boolean) {
    this.root = path.normalize(root);
    this.#rootForComparison = comparisonPath(this.root);
  }

  async resolve(relativePath: string, options: ResolveOptions = {}): Promise<string> {
    if (relativePath.includes('\0')) {
      throw new WorkspaceError('INVALID_ARGUMENT', 'Path contains a NUL byte');
    }
    if (path.isAbsolute(relativePath)) {
      throw new WorkspaceError('PATH_DENIED', 'Absolute paths are not allowed');
    }

    const normalizedInput = relativePath || '.';
    if (!options.internal) this.assertVisible(normalizedInput);
    const lexical = path.resolve(this.root, normalizedInput);
    this.assertContained(lexical);
    if (!options.allowRoot && comparisonPath(lexical) === this.#rootForComparison) {
      throw new WorkspaceError('PATH_DENIED', 'The workspace root itself cannot be targeted');
    }

    let ancestor = lexical;
    const missingParts: string[] = [];
    while (!(await exists(ancestor))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      missingParts.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    if (!(await exists(ancestor))) {
      throw new WorkspaceError('NOT_FOUND', `No existing ancestor for path: ${relativePath}`);
    }
    const canonicalAncestor = await realpath(ancestor);
    this.assertContained(canonicalAncestor);
    const canonical = path.join(canonicalAncestor, ...missingParts);
    this.assertContained(canonical);

    if (!options.allowMissing && !(await exists(lexical))) {
      throw new WorkspaceError('NOT_FOUND', `Path does not exist: ${relativePath}`);
    }
    if (await exists(lexical)) {
      const canonicalExisting = await realpath(lexical);
      this.assertContained(canonicalExisting);
      return canonicalExisting;
    }
    return canonical;
  }

  async resolveForRemoval(relativePath: string): Promise<string> {
    if (relativePath.includes('\0')) throw new WorkspaceError('INVALID_ARGUMENT', 'Path contains a NUL byte');
    if (path.isAbsolute(relativePath)) throw new WorkspaceError('PATH_DENIED', 'Absolute paths are not allowed');
    this.assertVisible(relativePath);
    const lexical = path.resolve(this.root, relativePath || '.');
    this.assertContained(lexical);
    if (comparisonPath(lexical) === this.#rootForComparison) {
      throw new WorkspaceError('PATH_DENIED', 'The workspace root itself cannot be targeted');
    }
    const lexicalParent = path.dirname(lexical);
    const parent = await this.resolve(this.relative(lexicalParent), { allowRoot: true });
    const target = path.join(parent, path.basename(lexical));
    this.assertContained(target);
    if (!(await exists(target))) throw new WorkspaceError('NOT_FOUND', `Path does not exist: ${relativePath}`);
    return target;
  }

  relative(absolutePath: string): string {
    this.assertContained(absolutePath);
    return path.relative(this.root, absolutePath).split(path.sep).join('/');
  }

  assertVisible(relativePath: string): void {
    const parts = relativePath.split(/[\\/]+/).filter(Boolean);
    if (parts.includes('.workspaceguard')) {
      throw new WorkspaceError('PATH_DENIED', '.workspaceguard is reserved for internal state');
    }
    if (this.allowSensitive) return;
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (
        SENSITIVE_BASENAMES.has(lower) ||
        lower.startsWith('.env.') ||
        lower.endsWith('.pem') ||
        lower.endsWith('.key') ||
        lower.endsWith('.p12') ||
        lower.endsWith('.pfx')
      ) {
        throw new WorkspaceError('PATH_DENIED', `Sensitive path is blocked by policy: ${relativePath}`);
      }
    }
  }

  private assertContained(candidate: string): void {
    const relative = path.relative(this.#rootForComparison, comparisonPath(candidate));
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      return;
    }
    throw new WorkspaceError('PATH_DENIED', 'Path escapes the configured workspace');
  }
}
