#!/usr/bin/env node
import { parseConfig, usage } from './config.js';
import { safeError } from './errors.js';
import { runHttp, runStdio } from './server.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage());
    return;
  }
  const config = await parseConfig(args);
  if (config.transport === 'stdio') await runStdio(config);
  else await runHttp(config);
}

main().catch((error: unknown) => {
  const detail = safeError(error);
  process.stderr.write(`[workspaceguard] ${detail.code}: ${detail.message}\n\n${usage()}`);
  process.exitCode = 1;
});
