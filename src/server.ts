import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { AppConfig } from './config.js';
import { createToolContext, createWorkspaceMcpServer } from './tools.js';

const MAX_HTTP_BODY_BYTES = 8_000_000;

function jsonResponse(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(encoded.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}

function validHost(value: string | undefined, port: number): boolean {
  if (!value) return false;
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`;
}

function validOrigin(value: string | undefined, port: number): boolean {
  if (!value) return true;
  try {
    const origin = new URL(value);
    return origin.protocol === 'http:' && validHost(origin.host, port);
  } catch {
    return false;
  }
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateHttpRequest(request: IncomingMessage, response: ServerResponse, config: AppConfig): boolean {
  if (!validHost(request.headers.host, config.port)) {
    jsonResponse(response, 400, { error: 'Invalid Host header' });
    return false;
  }
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  if (!validOrigin(origin, config.port)) {
    jsonResponse(response, 403, { error: 'Origin is not allowed' });
    return false;
  }
  if (request.headers['transfer-encoding']) {
    jsonResponse(response, 400, { error: 'Transfer-Encoding is not accepted' });
    return false;
  }
  const contentLength = request.headers['content-length'];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_HTTP_BODY_BYTES)) {
    jsonResponse(response, 413, { error: 'Request body is too large' });
    return false;
  }
  const suppliedToken = request.headers['x-workspace-mcp-token'];
  const token = Array.isArray(suppliedToken) ? undefined : suppliedToken;
  if (!tokenMatches(token, config.httpToken)) {
    jsonResponse(response, 401, { error: 'Missing or invalid local token' });
    return false;
  }
  return true;
}

export async function runStdio(config: AppConfig): Promise<void> {
  const context = createToolContext(config);
  const server = createWorkspaceMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[workspaceguard] stdio ready; mode=${config.mode}; workspace=${config.root}`);
}

export async function runHttp(config: AppConfig): Promise<void> {
  const context = createToolContext(config);
  const handler = createMcpHandler(() => createWorkspaceMcpServer(context));
  const mcpHandler = toNodeHandler(handler);
  const oauthDiscovery = new Set([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]);

  const httpServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    if (request.method === 'GET' && pathname === '/healthz') {
      jsonResponse(response, 200, { status: 'ok', mode: config.mode });
      return;
    }
    if (request.method === 'GET' && oauthDiscovery.has(pathname)) {
      jsonResponse(response, 404, { error: 'OAuth is not advertised by this local server' });
      return;
    }
    if (pathname !== '/mcp') {
      jsonResponse(response, 404, { error: 'Not found' });
      return;
    }
    if (!validateHttpRequest(request, response, config)) return;
    if (!request.method) {
      jsonResponse(response, 400, { error: 'Missing HTTP method' });
      return;
    }
    void mcpHandler(request as Parameters<typeof mcpHandler>[0], response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });
  console.error(`[workspaceguard] HTTP ready at http://${config.host}:${config.port}/mcp`);
  console.error(`[workspaceguard] mode=${config.mode}; workspace=${config.root}`);
  const shutdown = async () => {
    await handler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
