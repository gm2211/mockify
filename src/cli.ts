#!/usr/bin/env node
/**
 * src/cli.ts — mockify CLI entry point
 *
 * Subcommands:
 *   mockify serve [--port N] [--data <path>]
 *     Starts the mock server (src/mock-server.ts). --data sets
 *     MOCK_DATA_PATH, --port sets PORT.
 *
 *   mockify capture --url <url>
 *     Runs the browse-and-capture recorder (src/recorders/browse-and-capture.mjs)
 *     against the given URL. `record` is kept as a hidden alias for `capture`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

function printUsage(): void {
  console.error('Usage: mockify <command> [options]');
  console.error('');
  console.error('Commands:');
  console.error('  serve [--port N] [--data <path>]   Start the mock server');
  console.error('  capture --url <url>                Record traffic from a live site');
}

async function runServe(args: string[]): Promise<void> {
  const port = parseFlag(args, '--port');
  const data = parseFlag(args, '--data');

  if (port) process.env.PORT = port;
  if (data) process.env.MOCK_DATA_PATH = path.resolve(process.cwd(), data);

  // mock-server.ts runs its startup logic as a top-level side effect, so
  // importing it (after the env vars above are set) is enough to start it.
  await import('./mock-server.js');
}

function runCapture(args: string[]): void {
  const url = parseFlag(args, '--url');
  if (!url) {
    console.error('Usage: mockify capture --url <url>');
    process.exit(1);
  }

  const recorderPath = path.join(__dirname, 'recorders', 'browse-and-capture.mjs');
  const child = spawn(process.execPath, [recorderPath], {
    stdio: 'inherit',
    env: { ...process.env, TARGET_BASE_URL: url },
  });

  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error(`[mockify] Failed to launch recorder: ${err.message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'serve':
      await runServe(rest);
      return;
    case 'capture':
    case 'record': // hidden alias for `capture`
      runCapture(rest);
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[mockify] Fatal error:', err);
  process.exit(1);
});
