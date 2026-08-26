import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AsyncGate } from './async-gate.js';
import { AuditLog } from './audit.js';
import type { AppConfig } from './config.js';
import { safeError } from './errors.js';
import { FileService } from './services/files.js';
import { GitService } from './services/git.js';
import { CommandService } from './services/process.js';

interface ToolContext {
  config: AppConfig;
  files: FileService;
  git: GitService;
  commands: CommandService;
  audit: AuditLog;
  tools: AsyncGate;
  mutations: AsyncGate;
}

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const detail = safeError(error);
  return {
    content: [{ type: 'text' as const, text: `${detail.code}: ${detail.message}` }],
    structuredContent: { error: detail },
    isError: true,
  };
}

async function execute(
  context: ToolContext,
  tool: string,
  summary: Record<string, unknown>,
  operation: () => Promise<Record<string, unknown>>,
) {
  const requestId = randomUUID();
  const started = Date.now();
  try {
    const value = await context.tools.run(operation);
    await context.audit
      .record({ requestId, tool, summary, outcome: 'success', durationMs: Date.now() - started })
      .catch((error: unknown) => console.error(`[workspaceguard] audit failed for ${requestId}`, error));
    return success({ requestId, ...value });
  } catch (error) {
    const detail = safeError(error);
    if (detail.code === 'INTERNAL_ERROR') console.error(`[workspaceguard] request ${requestId} failed`, error);
    await context.audit
      .record({
        requestId,
        tool,
        summary,
        outcome: 'error',
        errorCode: detail.code,
        durationMs: Date.now() - started,
      })
      .catch((auditError: unknown) => console.error(`[workspaceguard] audit failed for ${requestId}`, auditError));
    return failure(error);
  }
}

export function createToolContext(config: AppConfig): ToolContext {
  const files = new FileService(config);
  return {
    config,
    files,
    git: new GitService(config, files.policy),
    commands: new CommandService(config, files.policy),
    audit: new AuditLog(config.root, config.auditLog),
    tools: new AsyncGate(8),
    mutations: new AsyncGate(1),
  };
}

export function createWorkspaceMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'workspaceguard-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'workspace_info',
    {
      title: 'Workspace policy',
      description: 'Show the active workspace access policy without exposing the absolute local path.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      execute(context, 'workspace_info', {}, async () => ({
        workspace: context.config.root.split(/[\\/]/).at(-1) ?? 'workspace',
        mode: context.config.mode,
        sensitivePathsBlocked: !context.config.allowSensitive,
        allowedCommands: context.config.mode === 'command' ? [...context.config.allowedCommands].sort() : [],
        limits: {
          maxFileBytes: context.config.maxFileBytes,
          maxProcessOutputBytes: context.config.maxOutputBytes,
          maxCommandSeconds: context.config.maxCommandSeconds,
        },
      })),
  );

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description: 'List direct children with type, size, and modification time. Sensitive paths are omitted by policy.',
      inputSchema: z.object({ subpath: z.string().default('') }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ subpath }) =>
      execute(context, 'list_files', { subpath }, async () => context.files.listFiles(subpath)),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read text file',
      description: 'Read a bounded UTF-8 text file and return its SHA-256 for conflict-safe follow-up writes.',
      inputSchema: z.object({ relative_path: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ relative_path }) =>
      execute(context, 'read_file', { path: relative_path }, async () => context.files.readFile(relative_path)),
  );

  server.registerTool(
    'read_file_range',
    {
      title: 'Read text file range',
      description: 'Read a 1-based inclusive line range and return range metadata plus the file SHA-256.',
      inputSchema: z
        .object({
          relative_path: z.string().min(1),
          start_line: z.number().int().min(1),
          end_line: z.number().int().min(1),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ relative_path, start_line, end_line }) =>
      execute(context, 'read_file_range', { path: relative_path, startLine: start_line, endLine: end_line }, async () =>
        context.files.readFileRange(relative_path, start_line, end_line),
      ),
  );

  server.registerTool(
    'search_filenames',
    {
      title: 'Search filenames',
      description: 'Recursively search filename substrings without following symlink directories.',
      inputSchema: z.object({ query: z.string().min(1), subpath: z.string().default('') }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, subpath }) =>
      execute(context, 'search_filenames', { queryLength: query.length, subpath }, async () =>
        context.files.searchFilenames(query, subpath),
      ),
  );

  server.registerTool(
    'search_content',
    {
      title: 'Search text content',
      description: 'Search bounded text files for a literal string and return line-numbered previews.',
      inputSchema: z
        .object({
          query: z.string().min(1),
          subpath: z.string().default(''),
          case_sensitive: z.boolean().default(false),
          context_lines: z.number().int().min(0).max(10).default(2),
          max_results: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, subpath, case_sensitive, context_lines, max_results }) =>
      execute(
        context,
        'search_content',
        { queryLength: query.length, subpath, caseSensitive: case_sensitive, maxResults: max_results },
        async () =>
          context.files.searchContent({
            query,
            subpath,
            caseSensitive: case_sensitive,
            contextLines: context_lines,
            maxResults: max_results,
          }),
      ),
  );

  server.registerTool(
    'git_status',
    {
      title: 'Git status',
      description: 'Read porcelain v2 status from a repository whose .git directory is inside the workspace.',
      inputSchema: z.object({ repo_path: z.string().default('') }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo_path }) =>
      execute(context, 'git_status', { repoPath: repo_path }, async () => ({
        process: await context.git.status(repo_path),
      })),
  );

  server.registerTool(
    'git_log',
    {
      title: 'Git log',
      description: 'Read bounded commit history without invoking hooks, pagers, prompts, or external diff tools.',
      inputSchema: z.object({ repo_path: z.string().default(''), count: z.number().int().min(1).max(50).default(10) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo_path, count }) =>
      execute(context, 'git_log', { repoPath: repo_path, count }, async () => ({
        process: await context.git.log(repo_path, count),
      })),
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Git diff',
      description:
        'Read a bounded working-tree or staged diff. Paths are passed as an argument array, never shell-parsed. Explicit file paths are required while sensitive-path blocking is active.',
      inputSchema: z
        .object({
          repo_path: z.string().default(''),
          paths: z.array(z.string()).max(100).default([]),
          staged: z.boolean().default(false),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo_path, paths, staged }) =>
      execute(context, 'git_diff', { repoPath: repo_path, pathCount: paths.length, staged }, async () => ({
        process: await context.git.diff(repo_path, paths, staged),
      })),
  );

  if (context.config.mode !== 'read-only') {
    server.registerTool(
      'write_file',
      {
        title: 'Write text file',
        description:
          'Atomically create, replace, or append UTF-8 text. Use expected_sha256 from read_file to prevent lost updates; dry_run previews the change.',
        inputSchema: z
          .object({
            relative_path: z.string().min(1),
            content: z.string(),
            append: z.boolean().default(false),
            dry_run: z.boolean().default(false),
            expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ relative_path, content, append, dry_run, expected_sha256 }) =>
        execute(
          context,
          'write_file',
          { path: relative_path, bytes: Buffer.byteLength(content), append, dryRun: dry_run, hasExpectedHash: !!expected_sha256 },
          () =>
            context.mutations.run(() =>
              context.files.writeFile({
                relativePath: relative_path,
                content,
                append,
                dryRun: dry_run,
                ...(expected_sha256 ? { expectedSha256: expected_sha256 } : {}),
              }),
            ),
        ),
    );

    server.registerTool(
      'trash_path',
      {
        title: 'Move path to recoverable trash',
        description: 'Move a file or directory into .workspaceguard/trash instead of permanently deleting it.',
        inputSchema: z.object({ relative_path: z.string().min(1), dry_run: z.boolean().default(true) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ relative_path, dry_run }) =>
        execute(context, 'trash_path', { path: relative_path, dryRun: dry_run }, () =>
          context.mutations.run(() => context.files.trashPath(relative_path, dry_run)),
        ),
    );
  }

  if (context.config.mode === 'command') {
    server.registerTool(
      'run_command',
      {
        title: 'Run allowlisted command',
        description:
          'Run one allowlisted executable with an argument array and workspace-contained cwd. No shell is used. This is not an OS sandbox.',
        inputSchema: z
          .object({
            program: z.string().min(1),
            args: z.array(z.string()).max(128).default([]),
            cwd: z.string().default(''),
            timeout_seconds: z.number().int().min(1).max(120).default(30),
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ program, args, cwd, timeout_seconds }) =>
        execute(context, 'run_command', { program, argCount: args.length, cwd, timeoutSeconds: timeout_seconds }, async () => ({
          process: await context.commands.run({ program, args, cwd, timeoutSeconds: timeout_seconds }),
        })),
    );
  }

  return server;
}
