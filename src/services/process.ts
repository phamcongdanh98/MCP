import { spawn } from 'node:child_process';
import path from 'node:path';

import { AsyncGate } from '../async-gate.js';
import type { AppConfig } from '../config.js';
import { WorkspaceError } from '../errors.js';
import type { PathPolicy } from '../security/path-policy.js';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const SAFE_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TERM',
] as const;

function boundedAppend(
  chunks: Buffer[],
  chunk: Buffer,
  state: { kept: number; omitted: number },
  limit: number,
): void {
  const remaining = Math.max(0, limit - state.kept);
  if (remaining) {
    const kept = chunk.subarray(0, remaining);
    chunks.push(kept);
    state.kept += kept.length;
  }
  state.omitted += Math.max(0, chunk.length - remaining);
}

function decodeOutput(chunks: Buffer[], omitted: number): string {
  const text = Buffer.concat(chunks).toString('utf8');
  return omitted ? `${text}\n\n[...truncated ${omitted} bytes...]` : text;
}

function commandEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', ...extra };
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // It already exited.
    }
  }, 750);
  timer.unref();
}

export async function runProcess(input: {
  program: string;
  args: readonly string[];
  cwd: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
  environment?: Record<string, string>;
}): Promise<ProcessResult> {
  const started = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutState = { kept: 0, omitted: 0 };
  const stderrState = { kept: 0, omitted: 0 };
  let timedOut = false;

  const child = spawn(input.program, [...input.args], {
    cwd: input.cwd,
    env: commandEnvironment(input.environment),
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => boundedAppend(stdoutChunks, chunk, stdoutState, input.outputLimitBytes));
  child.stderr.on('data', (chunk: Buffer) => boundedAppend(stderrChunks, chunk, stderrState, input.outputLimitBytes));

  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid) void terminateTree(child.pid);
  }, input.timeoutSeconds * 1_000);
  timeout.unref();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : -1)));
  }).catch((error: NodeJS.ErrnoException) => {
    throw new WorkspaceError('PROCESS_FAILED', `Could not run ${input.program}: ${error.message}`);
  });
  clearTimeout(timeout);
  return {
    exitCode,
    stdout: decodeOutput(stdoutChunks, stdoutState.omitted),
    stderr: decodeOutput(stderrChunks, stderrState.omitted),
    timedOut,
    durationMs: Date.now() - started,
  };
}

export class CommandService {
  readonly #gate = new AsyncGate(2);

  constructor(
    readonly config: AppConfig,
    readonly policy: PathPolicy,
  ) {}

  async run(input: {
    program: string;
    args: string[];
    cwd: string;
    timeoutSeconds: number;
  }): Promise<ProcessResult> {
    if (this.config.mode !== 'command') {
      throw new WorkspaceError('PERMISSION_DENIED', 'Command execution requires --mode command');
    }
    if (path.basename(input.program) !== input.program || !/^[A-Za-z0-9._+-]+$/.test(input.program)) {
      throw new WorkspaceError('INVALID_ARGUMENT', 'program must be a simple executable name, not a path');
    }
    if (!this.config.allowedCommands.has(input.program)) {
      throw new WorkspaceError('PERMISSION_DENIED', `Command is not allowlisted: ${input.program}`);
    }
    if (input.args.length > 128 || input.args.some((value) => value.length > 16_384 || value.includes('\0'))) {
      throw new WorkspaceError('LIMIT_EXCEEDED', 'Command arguments exceed policy limits');
    }
    const cwd = await this.policy.resolve(input.cwd, { allowRoot: true });
    const seconds = Math.max(1, Math.min(this.config.maxCommandSeconds, input.timeoutSeconds));
    return this.#gate.run(() =>
      runProcess({
        program: input.program,
        args: input.args,
        cwd,
        timeoutSeconds: seconds,
        outputLimitBytes: this.config.maxOutputBytes,
      }),
    );
  }
}
