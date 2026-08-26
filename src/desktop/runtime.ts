import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

import type { AccessMode } from '../config.js';

export interface DesktopSettings {
  root: string;
  mode: AccessMode;
  port: number;
  allowedCommands: string[];
}

export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'failed';

export interface DesktopRuntimeState {
  status: RuntimeStatus;
  root: string | null;
  mode: AccessMode | null;
  port: number | null;
  message: string;
  logs: string[];
}

export interface RuntimeControllerOptions {
  serverEntry: string;
  nodeBinary?: string;
  nodeArguments?: string[];
  environment?: NodeJS.ProcessEnv;
}

const MAX_LOG_LINES = 250;
const MAX_LOG_LINE_LENGTH = 1_000;
const START_TIMEOUT_MS = 5_000;
type ServerChild = ChildProcessByStdio<null, Readable, Readable>;

function initialState(): DesktopRuntimeState {
  return { status: 'stopped', root: null, mode: null, port: null, message: 'Chưa chạy', logs: [] };
}

function cloneState(state: DesktopRuntimeState): DesktopRuntimeState {
  return { ...state, logs: [...state.logs] };
}

function normalizeCommands(commands: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const command of commands) {
    if (!/^[A-Za-z0-9._+-]+$/.test(command)) {
      throw new Error(`Lệnh không hợp lệ: ${command}`);
    }
    unique.add(command);
  }
  return [...unique];
}

export async function validateDesktopSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  if (!['read-only', 'workspace-write', 'command'].includes(settings.mode)) {
    throw new Error('Chế độ truy cập không hợp lệ.');
  }
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65_535) {
    throw new Error('Cổng phải nằm trong khoảng 1024–65535.');
  }
  if (!settings.root.trim()) throw new Error('Hãy chọn thư mục workspace.');
  const root = await realpath(settings.root);
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace phải là một thư mục.');
  return { ...settings, root, allowedCommands: normalizeCommands(settings.allowedCommands) };
}

export class DesktopRuntimeController extends EventEmitter {
  private readonly serverEntry: string;
  private readonly nodeBinary: string;
  private readonly nodeArguments: string[];
  private readonly environment: NodeJS.ProcessEnv;
  private process: ServerChild | null = null;
  private state = initialState();
  private stopping = false;

  constructor(options: RuntimeControllerOptions) {
    super();
    this.serverEntry = options.serverEntry;
    this.nodeBinary = options.nodeBinary ?? process.execPath;
    this.nodeArguments = options.nodeArguments ?? [];
    this.environment = options.environment ?? {};
  }

  snapshot(): DesktopRuntimeState {
    return cloneState(this.state);
  }

  private publish(): void {
    this.emit('state', this.snapshot());
  }

  private appendLog(value: string): void {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.state.logs.push(trimmed.slice(0, MAX_LOG_LINE_LENGTH));
    }
    if (this.state.logs.length > MAX_LOG_LINES) this.state.logs.splice(0, this.state.logs.length - MAX_LOG_LINES);
    this.publish();
  }

  private setState(next: Omit<DesktopRuntimeState, 'logs'>): void {
    this.state = { ...next, logs: this.state.logs };
    this.publish();
  }

  private async waitForHealth(port: number, expectedMode: AccessMode, child: ServerChild): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('MCP server đã dừng trước khi sẵn sàng.');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        const payload: unknown = await response.json();
        if (response.ok && typeof payload === 'object' && payload !== null &&
          (payload as { status?: unknown }).status === 'ok' &&
          (payload as { mode?: unknown }).mode === expectedMode) return;
      } catch {
        // The child normally needs a moment to bind its loopback listener.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('MCP server không sẵn sàng sau 5 giây. Hãy thử đổi cổng hoặc xem log.');
  }

  async start(input: DesktopSettings): Promise<DesktopRuntimeState> {
    await this.stop();
    const settings = await validateDesktopSettings(input);
    this.state = { status: 'starting', root: settings.root, mode: settings.mode, port: settings.port, message: 'Đang khởi động…', logs: [] };
    this.publish();

    const token = randomBytes(32).toString('hex');
    const arguments_ = [
      ...this.nodeArguments,
      this.serverEntry,
      '--root', settings.root,
      '--transport', 'http',
      '--mode', settings.mode,
      '--port', String(settings.port),
    ];
    if (settings.mode === 'command' && settings.allowedCommands.length > 0) {
      arguments_.push('--allow-command', settings.allowedCommands.join(','));
    }

    const child = spawn(this.nodeBinary, arguments_, {
      cwd: settings.root,
      env: { ...process.env, ...this.environment, WORKSPACE_MCP_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    child.stdout.on('data', (data: Buffer) => this.appendLog(data.toString('utf8')));
    child.stderr.on('data', (data: Buffer) => this.appendLog(data.toString('utf8')));
    child.on('error', (error) => this.appendLog(`Không thể khởi động: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      if (!this.stopping) {
        this.setState({
          status: 'failed', root: settings.root, mode: settings.mode, port: settings.port,
          message: `Server đã dừng (${signal ?? `mã ${code ?? 'không rõ'}`}).`,
        });
      }
    });

    try {
      await this.waitForHealth(settings.port, settings.mode, child);
      this.setState({ status: 'running', root: settings.root, mode: settings.mode, port: settings.port, message: 'Đang chạy trên localhost' });
      return this.snapshot();
    } catch (error) {
      await this.stop();
      const message = error instanceof Error ? error.message : 'Không thể khởi động MCP server.';
      this.setState({ status: 'failed', root: settings.root, mode: settings.mode, port: settings.port, message });
      throw error;
    }
  }

  async stop(): Promise<DesktopRuntimeState> {
    const child = this.process;
    if (!child) return this.snapshot();
    this.stopping = true;
    try {
      await new Promise<void>((resolve) => {
        const forceStop = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(forceStop);
          resolve();
        });
        child.kill('SIGINT');
      });
    } finally {
      this.process = null;
      this.stopping = false;
      this.setState({ status: 'stopped', root: null, mode: null, port: null, message: 'Đã dừng' });
    }
    return this.snapshot();
  }
}
