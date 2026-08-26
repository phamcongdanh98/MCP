import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceError } from './errors.js';

export type AccessMode = 'read-only' | 'workspace-write' | 'command';
export type TransportMode = 'stdio' | 'http';

export interface AppConfig {
  root: string;
  mode: AccessMode;
  transport: TransportMode;
  host: '127.0.0.1';
  port: number;
  httpToken: string;
  allowedCommands: ReadonlySet<string>;
  allowSensitive: boolean;
  auditLog: string;
  maxFileBytes: number;
  maxOutputBytes: number;
  maxCommandSeconds: number;
}

const DEFAULT_COMMANDS = ['git', 'node', 'npm', 'npx'];

function takeValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new WorkspaceError('INVALID_ARGUMENT', `${option} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function usage(): string {
  return `WorkspaceGuard MCP

Usage:
  workspaceguard-mcp --root <directory> [options]

Options:
  --transport stdio|http             Default: stdio
  --mode read-only|workspace-write|command
                                      Default: read-only
  --port <1024-65535>                 HTTP only; default: 7331
  --allow-command <name[,name...]>    Command-mode allowlist
  --allow-sensitive                   Allow .env, private keys, credentials
  --audit-log <relative-path>         Must be under .workspaceguard/
  --help

Environment:
  WORKSPACE_MCP_TOKEN                 HTTP token (minimum 32 characters)
  WORKSPACE_MCP_ALLOWED_COMMANDS      Comma-separated command allowlist
`;
}

export async function parseConfig(rawArgs: readonly string[]): Promise<AppConfig> {
  const args = [...rawArgs];
  let rootInput = '';
  let mode: AccessMode = 'read-only';
  let transport: TransportMode = 'stdio';
  let port = 7331;
  let allowSensitive = false;
  let auditLogInput = '.workspaceguard/audit.jsonl';
  const commandInputs = commaList(process.env.WORKSPACE_MCP_ALLOWED_COMMANDS ?? '').length
    ? commaList(process.env.WORKSPACE_MCP_ALLOWED_COMMANDS ?? '')
    : [...DEFAULT_COMMANDS];

  for (let index = 0; index < args.length; ) {
    const option = args[index];
    switch (option) {
      case '--root':
        rootInput = takeValue(args, index, option);
        break;
      case '--mode': {
        const value = takeValue(args, index, option);
        if (!['read-only', 'workspace-write', 'command'].includes(value)) {
          throw new WorkspaceError('INVALID_ARGUMENT', `Invalid mode: ${value}`);
        }
        mode = value as AccessMode;
        break;
      }
      case '--transport': {
        const value = takeValue(args, index, option);
        if (value !== 'stdio' && value !== 'http') {
          throw new WorkspaceError('INVALID_ARGUMENT', `Invalid transport: ${value}`);
        }
        transport = value;
        break;
      }
      case '--port': {
        const value = Number(takeValue(args, index, option));
        if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
          throw new WorkspaceError('INVALID_ARGUMENT', 'Port must be an integer from 1024 to 65535');
        }
        port = value;
        break;
      }
      case '--allow-command':
        commandInputs.splice(0, commandInputs.length, ...commaList(takeValue(args, index, option)));
        break;
      case '--audit-log':
        auditLogInput = takeValue(args, index, option);
        break;
      case '--allow-sensitive':
        allowSensitive = true;
        args.splice(index, 1);
        break;
      default:
        throw new WorkspaceError('INVALID_ARGUMENT', `Unknown option: ${option ?? ''}`);
    }
  }

  if (!rootInput) {
    throw new WorkspaceError('INVALID_ARGUMENT', '--root is required');
  }
  const root = await realpath(path.resolve(rootInput));
  if (!(await stat(root)).isDirectory()) {
    throw new WorkspaceError('INVALID_ARGUMENT', `Workspace root is not a directory: ${rootInput}`);
  }

  for (const command of commandInputs) {
    if (!/^[A-Za-z0-9._+-]+$/.test(command)) {
      throw new WorkspaceError('INVALID_ARGUMENT', `Invalid command allowlist entry: ${command}`);
    }
  }

  if (path.isAbsolute(auditLogInput)) {
    throw new WorkspaceError('INVALID_ARGUMENT', '--audit-log must be relative to the workspace');
  }
  const auditLog = path.resolve(root, auditLogInput);
  const relativeAudit = path.relative(root, auditLog);
  if (relativeAudit.startsWith('..') || path.isAbsolute(relativeAudit)) {
    throw new WorkspaceError('PATH_DENIED', 'Audit log must stay inside the workspace');
  }
  if (relativeAudit.split(path.sep)[0] !== '.workspaceguard') {
    throw new WorkspaceError('PATH_DENIED', 'Audit log must stay under .workspaceguard/');
  }

  const httpToken = process.env.WORKSPACE_MCP_TOKEN ?? '';
  if (transport === 'http' && httpToken.length < 32) {
    throw new WorkspaceError('INVALID_ARGUMENT', 'WORKSPACE_MCP_TOKEN must be at least 32 characters');
  }

  return {
    root,
    mode,
    transport,
    host: '127.0.0.1',
    port,
    httpToken,
    allowedCommands: new Set(commandInputs),
    allowSensitive,
    auditLog,
    maxFileBytes: 5_000_000,
    maxOutputBytes: 100_000,
    maxCommandSeconds: 120,
  };
}
