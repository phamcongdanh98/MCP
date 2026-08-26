import { randomBytes, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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

export interface DesktopProbeStep {
  name: string;
  status: 'passed' | 'skipped' | 'failed';
  detail: string;
}

export interface DesktopProbeResult {
  passed: boolean;
  steps: DesktopProbeStep[];
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
  private httpToken: string | null = null;
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
    this.httpToken = token;
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
      this.httpToken = null;
      this.stopping = false;
      this.setState({ status: 'stopped', root: null, mode: null, port: null, message: 'Đã dừng' });
    }
    return this.snapshot();
  }

  async runMcpProbe(): Promise<DesktopProbeResult> {
    const { status, mode, port } = this.state;
    const token = this.httpToken;
    if (status !== 'running' || !mode || !port || !token) {
      throw new Error('Hãy khởi động MCP server trước khi chạy kiểm tra.');
    }

    const steps: DesktopProbeStep[] = [];
    const pass = (name: string, detail: string): void => { steps.push({ name, status: 'passed', detail }); };
    const skip = (name: string, detail: string): void => { steps.push({ name, status: 'skipped', detail }); };
    const requireSuccess = (name: string, value: { isError?: boolean | undefined; structuredContent?: unknown | undefined }): unknown => {
      if (value.isError) throw new Error(`${name} trả về lỗi.`);
      return value.structuredContent;
    };

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { 'X-Workspace-MCP-Token': token } },
    });
    const client = new Client({ name: 'workspaceguard-desktop-check', version: '0.1.0' });
    let temporaryFile: string | null = null;

    try {
      await client.connect(transport);
      pass('Kết nối MCP', 'Handshake HTTP MCP thành công.');

      const tools = await client.listTools();
      const toolNames = new Set(tools.tools.map((tool) => tool.name));
      if (!toolNames.has('workspace_info') || !toolNames.has('list_files')) {
        throw new Error('Server không công bố đủ tool chỉ đọc cần thiết.');
      }
      pass('Khám phá tool', `${tools.tools.length} tool đang khả dụng theo mode đã chọn.`);

      const info = requireSuccess('workspace_info', await client.callTool({ name: 'workspace_info', arguments: {} })) as { mode?: unknown };
      if (info.mode !== mode) throw new Error('workspace_info trả về mode không khớp với giao diện.');
      pass('Workspace policy', `Mode ${mode} được server xác nhận.`);

      const files = requireSuccess('list_files', await client.callTool({ name: 'list_files', arguments: { subpath: '' } })) as { entries?: unknown };
      if (!Array.isArray(files.entries)) throw new Error('list_files không trả về danh sách file hợp lệ.');
      pass('Đọc workspace', `list_files đọc được ${files.entries.length} mục ở thư mục gốc.`);

      if (mode === 'read-only') {
        skip('Ghi và trash', 'Bỏ qua vì mode chỉ đọc.');
        skip('Chạy lệnh', 'Bỏ qua vì mode chỉ đọc.');
        return { passed: true, steps };
      }

      if (!toolNames.has('write_file') || !toolNames.has('trash_path')) {
        throw new Error('Mode ghi không công bố đủ write_file và trash_path.');
      }
      temporaryFile = `workspaceguard-ui-test-${randomUUID()}.txt`;
      const content = 'WorkspaceGuard MCP desktop check\n';
      const write = requireSuccess('write_file', await client.callTool({
        name: 'write_file', arguments: { relative_path: temporaryFile, content, dry_run: false },
      })) as { dryRun?: unknown };
      if (write.dryRun !== false) throw new Error('write_file không thực hiện ghi thật trong kiểm tra.');
      const read = requireSuccess('read_file', await client.callTool({ name: 'read_file', arguments: { relative_path: temporaryFile } })) as { content?: unknown };
      if (read.content !== content) throw new Error('Nội dung đọc lại không khớp nội dung vừa ghi.');
      pass('Ghi và đọc lại', 'Tạo file kiểm tra ngẫu nhiên và xác minh nội dung thành công.');

      const trash = requireSuccess('trash_path', await client.callTool({
        name: 'trash_path', arguments: { relative_path: temporaryFile, dry_run: false },
      })) as { dryRun?: unknown; trashPath?: unknown };
      temporaryFile = null;
      if (trash.dryRun !== false || typeof trash.trashPath !== 'string') throw new Error('trash_path không trả về vị trí khôi phục hợp lệ.');
      pass('Trash có thể khôi phục', 'File kiểm tra đã được chuyển vào .workspaceguard/trash.');

      if (mode !== 'command') {
        skip('Chạy lệnh', 'Bỏ qua vì mode đọc và ghi không cho chạy lệnh.');
        return { passed: true, steps };
      }
      if (!toolNames.has('run_command')) throw new Error('Mode command không công bố run_command.');
      const command = requireSuccess('run_command', await client.callTool({
        name: 'run_command', arguments: { program: 'node', args: ['--version'], cwd: '', timeout_seconds: 15 },
      })) as { process?: { exitCode?: unknown; stdout?: unknown } };
      if (command.process?.exitCode !== 0 || typeof command.process.stdout !== 'string' || !command.process.stdout.trim().startsWith('v')) {
        throw new Error('node --version không hoàn tất thành công. Hãy bật allowlist node.');
      }
      pass('Chạy lệnh allowlist', `node --version trả về ${command.process.stdout.trim()}.`);
      return { passed: true, steps };
    } catch (error) {
      steps.push({
        name: 'Kiểm tra MCP',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'Lỗi không xác định khi kiểm tra MCP.',
      });
      return { passed: false, steps };
    } finally {
      if (temporaryFile) {
        await client.callTool({ name: 'trash_path', arguments: { relative_path: temporaryFile, dry_run: false } }).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
  }
}
