import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createToolContext, createWorkspaceMcpServer } from '../src/tools.js';
import { temporaryWorkspace, testConfig } from './helpers.js';

test('MCP discovery and a real read_file call work end to end in read-only mode', async () => {
  const workspace = await temporaryWorkspace();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWorkspaceMcpServer(createToolContext(testConfig(workspace.root)));
  const client = new Client({ name: 'workspaceguard-tests', version: '1.0.0' });
  try {
    await writeFile(path.join(workspace.root, 'hello.txt'), 'xin chao');
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'read_file'));
    assert.equal(tools.tools.some((tool) => tool.name === 'write_file'), false);
    assert.equal(tools.tools.some((tool) => tool.name === 'run_command'), false);

    const result = await client.callTool({ name: 'read_file', arguments: { relative_path: 'hello.txt' } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { content: string }).content, 'xin chao');
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await workspace.cleanup();
  }
});

test('command mode exposes run_command and executes an allowlisted argv call', async () => {
  const workspace = await temporaryWorkspace();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const config = testConfig(workspace.root, { mode: 'command', allowedCommands: new Set(['node']) });
  const server = createWorkspaceMcpServer(createToolContext(config));
  const client = new Client({ name: 'workspaceguard-command-tests', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'run_command'));
    const result = await client.callTool({
      name: 'run_command',
      arguments: { program: 'node', args: ['-e', "process.stdout.write('terminal ok')"], cwd: '' },
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { process: { stdout: string; exitCode: number } };
    assert.equal(structured.process.exitCode, 0);
    assert.equal(structured.process.stdout, 'terminal ok');
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await workspace.cleanup();
  }
});
