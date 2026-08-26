import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspaceguard-smoke-'));
await writeFile(path.join(root, 'smoke.txt'), 'semantic smoke ok');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/index.js'), '--root', root, '--transport', 'stdio', '--mode', 'read-only'],
  cwd: process.cwd(),
  stderr: 'pipe',
});
const client = new Client({ name: 'workspaceguard-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 8);
  const result = await client.callTool({ name: 'read_file', arguments: { relative_path: 'smoke.txt' } });
  assert.equal((result.structuredContent as { content: string }).content, 'semantic smoke ok');
  process.stdout.write(`stdio smoke: ok (${tools.tools.length} tools discovered)\n`);
} finally {
  await client.close().catch(() => undefined);
}

const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const address = probe.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((resolve) => probe.close(() => resolve()));

const token = randomBytes(32).toString('hex');
let serverErrors = '';
const serverProcess = spawn(
  process.execPath,
  [path.resolve('dist/index.js'), '--root', root, '--transport', 'http', '--mode', 'read-only', '--port', String(port)],
  {
    cwd: process.cwd(),
    env: { ...process.env, WORKSPACE_MCP_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
serverProcess.stderr.on('data', (chunk: Buffer) => {
  serverErrors += chunk.toString('utf8');
});

const healthUrl = `http://127.0.0.1:${port}/healthz`;
let ready = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(healthUrl);
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    // Server is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

try {
  assert.equal(ready, true, `HTTP server did not become ready: ${serverErrors}`);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(unauthorized.status, 401);

  const httpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { 'X-Workspace-MCP-Token': token } },
  });
  const httpClient = new Client({ name: 'workspaceguard-http-smoke', version: '1.0.0' });
  try {
    await httpClient.connect(httpTransport);
    const result = await httpClient.callTool({ name: 'read_file', arguments: { relative_path: 'smoke.txt' } });
    assert.equal((result.structuredContent as { content: string }).content, 'semantic smoke ok');
    process.stdout.write('HTTP smoke: ok (auth enforced, MCP read succeeded)\n');
  } finally {
    await httpClient.close().catch(() => undefined);
  }
} finally {
  serverProcess.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (serverProcess.exitCode !== null) resolve();
    else serverProcess.once('exit', () => resolve());
  });
  await rm(root, { recursive: true, force: true });
}
