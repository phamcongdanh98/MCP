import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { AccessMode, AppConfig } from '../config.js';
import { WorkspaceError } from '../errors.js';
import { PathPolicy } from '../security/path-policy.js';

const SEARCH_SKIP_DIRECTORIES = new Set([
  '.git',
  '.workspaceguard',
  '.venv',
  'node_modules',
  '__pycache__',
  'build',
  'dist',
  'coverage',
]);
const MAX_LIST_ENTRIES = 1_000;
const MAX_SEARCH_VISITED = 50_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_CONTENT_RESULTS = 50;
const MAX_CONTENT_SCAN_BYTES = 50_000_000;
const MAX_CONTENT_FILE_BYTES = 1_000_000;
const MAX_READ_LINES = 1_000;
const MAX_READ_CHARS = 80_000;

export interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

export interface ReadResult extends Record<string, unknown> {
  path: string;
  size: number;
  sha256: string;
  content: string;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertText(buffer: Buffer, relativePath: string): void {
  if (buffer.includes(0)) {
    throw new WorkspaceError('INVALID_ARGUMENT', `Binary files are not supported: ${relativePath}`);
  }
}

async function optionalStat(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function requireWriteMode(mode: AccessMode): void {
  if (mode === 'read-only') {
    throw new WorkspaceError('PERMISSION_DENIED', 'This server is running in read-only mode');
  }
}

export class FileService {
  readonly policy: PathPolicy;

  constructor(readonly config: AppConfig) {
    this.policy = new PathPolicy(config.root, config.allowSensitive);
  }

  async listFiles(subpath = ''): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const directory = await this.policy.resolve(subpath, { allowRoot: true });
    if (!(await stat(directory)).isDirectory()) {
      throw new WorkspaceError('INVALID_ARGUMENT', `Not a directory: ${subpath || '.'}`);
    }
    const entries: FileEntry[] = [];
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        const relative = this.policy.relative(path.join(directory, entry.name));
        try {
          this.policy.assertVisible(relative);
        } catch {
          continue;
        }
        const metadata = await lstat(path.join(directory, entry.name));
        const type = entry.isSymbolicLink()
          ? 'symlink'
          : entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : 'other';
        entries.push({
          path: relative,
          name: entry.name,
          type,
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        });
        if (entries.length >= MAX_LIST_ENTRIES) break;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { entries, truncated: entries.length >= MAX_LIST_ENTRIES };
  }

  async readFile(relativePath: string): Promise<ReadResult> {
    const filePath = await this.policy.resolve(relativePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new WorkspaceError('INVALID_ARGUMENT', `Not a file: ${relativePath}`);
    if (metadata.size > this.config.maxFileBytes) {
      throw new WorkspaceError('LIMIT_EXCEEDED', `File exceeds ${this.config.maxFileBytes} bytes`);
    }
    const buffer = await readFile(filePath);
    assertText(buffer, relativePath);
    return { path: this.policy.relative(filePath), size: buffer.length, sha256: sha256(buffer), content: buffer.toString('utf8') };
  }

  async readFileRange(relativePath: string, startLine: number, endLine: number): Promise<Record<string, unknown>> {
    if (startLine < 1 || endLine < startLine || endLine - startLine + 1 > MAX_READ_LINES) {
      throw new WorkspaceError('INVALID_ARGUMENT', `Line range must be valid and no larger than ${MAX_READ_LINES} lines`);
    }
    const result = await this.readFile(relativePath);
    const lines = result.content.split(/\r?\n/);
    if (startLine > lines.length) {
      throw new WorkspaceError('INVALID_ARGUMENT', `start_line exceeds total line count (${lines.length})`);
    }
    const requestedEnd = Math.min(endLine, lines.length);
    const selected: string[] = [];
    let chars = 0;
    for (let line = startLine; line <= requestedEnd; line += 1) {
      const value = lines[line - 1] ?? '';
      const additional = value.length + (selected.length ? 1 : 0);
      if (chars + additional > MAX_READ_CHARS) break;
      selected.push(value);
      chars += additional;
    }
    if (!selected.length) throw new WorkspaceError('LIMIT_EXCEEDED', 'The first requested line exceeds the response limit');
    const actualEnd = startLine + selected.length - 1;
    return {
      path: result.path,
      startLine,
      endLine: actualEnd,
      requestedEndLine: endLine,
      totalLines: lines.length,
      hasBefore: startLine > 1,
      hasAfter: actualEnd < lines.length,
      truncated: actualEnd < requestedEnd,
      content: selected.join('\n'),
      sha256: result.sha256,
    };
  }

  async writeFile(input: {
    relativePath: string;
    content: string;
    append: boolean;
    dryRun: boolean;
    expectedSha256?: string;
  }): Promise<Record<string, unknown>> {
    requireWriteMode(this.config.mode);
    const target = await this.policy.resolve(input.relativePath, { allowMissing: true });
    const currentMetadata = await optionalStat(target);
    if (currentMetadata && !currentMetadata.isFile()) {
      throw new WorkspaceError('INVALID_ARGUMENT', `Target is not a regular file: ${input.relativePath}`);
    }
    if (currentMetadata && currentMetadata.size > this.config.maxFileBytes) {
      throw new WorkspaceError('LIMIT_EXCEEDED', `Existing file exceeds ${this.config.maxFileBytes} bytes`);
    }
    const current = currentMetadata ? await readFile(target) : Buffer.alloc(0);
    if (input.expectedSha256 && (!currentMetadata || sha256(current) !== input.expectedSha256)) {
      throw new WorkspaceError('CONFLICT', 'File changed since it was read; expected_sha256 does not match');
    }
    const incoming = Buffer.from(input.content, 'utf8');
    const next = input.append ? Buffer.concat([current, incoming]) : incoming;
    if (next.length > this.config.maxFileBytes) {
      throw new WorkspaceError('LIMIT_EXCEEDED', `Result exceeds ${this.config.maxFileBytes} bytes`);
    }
    const result = {
      path: this.policy.relative(target),
      bytes: next.length,
      sha256: sha256(next),
      operation: currentMetadata ? (input.append ? 'append' : 'replace') : 'create',
      dryRun: input.dryRun,
    };
    if (input.dryRun) return result;

    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    await this.policy.resolve(this.policy.relative(canonicalParent), { allowRoot: true });
    const temporary = path.join(canonicalParent, `.workspaceguard-write-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', currentMetadata ? currentMetadata.mode & 0o777 : 0o600);
    try {
      await handle.writeFile(next);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (currentMetadata && process.platform !== 'win32') await chmod(temporary, currentMetadata.mode & 0o777);
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return result;
  }

  async trashPath(relativePath: string, dryRun: boolean): Promise<Record<string, unknown>> {
    requireWriteMode(this.config.mode);
    const source = await this.policy.resolveForRemoval(relativePath);
    const sourceMetadata = await lstat(source);
    const trashRelative = path.posix.join(
      '.workspaceguard/trash',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`,
      path.basename(source),
    );
    const destination = await this.policy.resolve(trashRelative, { allowMissing: true, internal: true });
    const result = {
      path: this.policy.relative(source),
      type: sourceMetadata.isDirectory() ? 'directory' : 'file',
      trashPath: this.policy.relative(destination),
      dryRun,
    };
    if (dryRun) return result;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await rename(source, destination);
    return result;
  }

  async searchFilenames(query: string, subpath = ''): Promise<Record<string, unknown>> {
    if (!query) throw new WorkspaceError('INVALID_ARGUMENT', 'query must not be empty');
    const matches: string[] = [];
    let visited = 0;
    let truncated = false;
    for await (const item of this.walk(subpath)) {
      visited += 1;
      if (item.name.toLowerCase().includes(query.toLowerCase())) matches.push(item.relativePath);
      if (visited >= MAX_SEARCH_VISITED || matches.length >= MAX_SEARCH_RESULTS) {
        truncated = true;
        break;
      }
    }
    return { matches, visited, truncated };
  }

  async searchContent(input: {
    query: string;
    subpath: string;
    caseSensitive: boolean;
    contextLines: number;
    maxResults: number;
  }): Promise<Record<string, unknown>> {
    if (!input.query) throw new WorkspaceError('INVALID_ARGUMENT', 'query must not be empty');
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const contextLines = Math.max(0, Math.min(10, input.contextLines));
    const limit = Math.max(1, Math.min(MAX_CONTENT_RESULTS, input.maxResults));
    const matches: Array<Record<string, unknown>> = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    let truncated = false;

    for await (const item of this.walk(input.subpath)) {
      if (item.type !== 'file') continue;
      const metadata = await stat(item.absolutePath);
      if (metadata.size > MAX_CONTENT_FILE_BYTES) continue;
      if (bytesScanned + metadata.size > MAX_CONTENT_SCAN_BYTES) {
        truncated = true;
        break;
      }
      const buffer = await readFile(item.absolutePath);
      bytesScanned += buffer.length;
      filesScanned += 1;
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const haystack = input.caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(needle)) continue;
        const first = Math.max(0, index - contextLines);
        const last = Math.min(lines.length - 1, index + contextLines);
        matches.push({
          path: item.relativePath,
          line: index + 1,
          startLine: first + 1,
          endLine: last + 1,
          preview: lines.slice(first, last + 1).join('\n').slice(0, 4_000),
        });
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    return { matches, filesScanned, bytesScanned, truncated };
  }

  private async *walk(subpath: string): AsyncGenerator<{
    name: string;
    relativePath: string;
    absolutePath: string;
    type: 'file' | 'directory';
  }> {
    const start = await this.policy.resolve(subpath, { allowRoot: true });
    if (!(await stat(start)).isDirectory()) throw new WorkspaceError('INVALID_ARGUMENT', 'Search root must be a directory');
    const pending = [start];
    while (pending.length) {
      const directory = pending.pop();
      if (!directory) break;
      const handle = await opendir(directory);
      try {
        for await (const entry of handle) {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && SEARCH_SKIP_DIRECTORIES.has(entry.name)) continue;
          const absolutePath = path.join(directory, entry.name);
          const relativePath = this.policy.relative(absolutePath);
          try {
            this.policy.assertVisible(relativePath);
          } catch {
            continue;
          }
          if (entry.isDirectory()) {
            pending.push(absolutePath);
            yield { name: entry.name, relativePath, absolutePath, type: 'directory' };
          } else if (entry.isFile()) {
            yield { name: entry.name, relativePath, absolutePath, type: 'file' };
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }
}
