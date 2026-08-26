import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../config.js';
import { WorkspaceError } from '../errors.js';
import type { PathPolicy } from '../security/path-policy.js';
import { runProcess, type ProcessResult } from './process.js';

export class GitService {
  constructor(
    readonly config: AppConfig,
    readonly policy: PathPolicy,
  ) {}

  async status(repoPath: string): Promise<ProcessResult> {
    const repo = await this.validateRepository(repoPath);
    return this.git(repo, ['status', '--porcelain=v2', '--branch']);
  }

  async log(repoPath: string, count: number): Promise<ProcessResult> {
    const repo = await this.validateRepository(repoPath);
    return this.git(repo, [
      'log',
      `-${Math.max(1, Math.min(50, count))}`,
      '--date=iso-strict',
      '--pretty=format:%H%x09%ad%x09%an%x09%s',
    ]);
  }

  async diff(repoPath: string, paths: string[], staged: boolean): Promise<ProcessResult> {
    const repo = await this.validateRepository(repoPath);
    if (!this.config.allowSensitive && paths.length === 0) {
      throw new WorkspaceError('INVALID_ARGUMENT', 'Explicit file paths are required while sensitive-path blocking is active');
    }
    if (
      paths.length > 100 ||
      paths.some(
        (value) =>
          value.includes('\0') ||
          path.isAbsolute(value) ||
          value.startsWith(':') ||
          /[*?\[\]]/.test(value),
      )
    ) {
      throw new WorkspaceError('INVALID_ARGUMENT', 'Invalid Git pathspec list');
    }
    for (const item of paths) {
      this.policy.assertVisible(item);
      const resolved = await this.policy.resolve(path.join(repoPath, item), { allowMissing: true });
      try {
        if ((await stat(resolved)).isDirectory()) {
          throw new WorkspaceError('INVALID_ARGUMENT', 'git_diff paths must identify files, not directories');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return this.git(repo, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      ...(staged ? ['--cached'] : []),
      '--',
      ...paths,
    ]);
  }

  private async validateRepository(repoPath: string): Promise<string> {
    const repo = await this.policy.resolve(repoPath, { allowRoot: true });
    if (!(await stat(repo)).isDirectory()) throw new WorkspaceError('INVALID_ARGUMENT', 'Repository path is not a directory');
    const gitEntry = path.join(repo, '.git');
    let metadata;
    try {
      metadata = await lstat(gitEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkspaceError('NOT_FOUND', `No .git directory at ${repoPath || '.'}`);
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceError('PATH_DENIED', 'Only repositories with an in-workspace .git directory are supported');
    }
    const canonicalGit = await realpath(gitEntry);
    await this.policy.resolve(this.policy.relative(canonicalGit));
    return repo;
  }

  private git(repo: string, args: string[]): Promise<ProcessResult> {
    return runProcess({
      program: 'git',
      args: [
        '-c',
        'core.hooksPath=',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        '-c',
        'interactive.diffFilter=',
        '-C',
        repo,
        ...args,
      ],
      cwd: repo,
      timeoutSeconds: 30,
      outputLimitBytes: this.config.maxOutputBytes,
      environment: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
  }
}
