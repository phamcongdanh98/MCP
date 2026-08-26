import http from 'node:http';

const arguments_ = process.argv.slice(2);
const command = arguments_[0];
const requiredHeaders = 'X-Workspace-MCP-Token: env:WORKSPACE_MCP_TOKEN';

if (!process.env.CONTROL_PLANE_API_KEY || !process.env.WORKSPACE_MCP_TOKEN ||
  process.env.MCP_EXTRA_HEADERS !== requiredHeaders || process.env.MCP_DISCOVERY_EXTRA_HEADERS !== requiredHeaders) {
  console.error('missing protected tunnel environment');
  process.exitCode = 2;
} else if (command === 'init' || command === 'doctor') {
  console.log(`${command} ok`);
} else if (command === 'run') {
  const addressIndex = arguments_.indexOf('--health-listen-addr');
  const address = arguments_[addressIndex + 1];
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address ?? '');
  if (!match) {
    console.error('missing health address');
    process.exitCode = 3;
  } else {
    const server = http.createServer((request, response) => {
      if (request.url === '/readyz' || request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ok"}');
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(Number(match[1]), '127.0.0.1', () => console.log('fake tunnel ready'));
    process.on('SIGINT', () => server.close(() => process.exit(0)));
  }
} else {
  console.error(`unexpected command: ${command}`);
  process.exitCode = 4;
}
