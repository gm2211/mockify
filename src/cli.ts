#!/usr/bin/env node
/**
 * src/cli.ts — mockify CLI entry point
 *
 * Subcommands:
 *   mockify serve [--port N] [--data <path>]
 *     Starts the mock server (src/mock-server.ts). --data sets
 *     MOCK_DATA_PATH, --port sets PORT. --data accepts either a
 *     traffic.json file or a capture directory containing one.
 *
 *   mockify capture --url <url> [--output <dir>] [--headed] [--manual]
 *                    [--storage-state <path|keychain:name>]
 *                    [--save-storage-state <path|keychain:name>]
 *                    [--timeout <seconds>]
 *     Agent mode (default): drives a Claude agent (src/agent/runner.ts) that
 *     explores the target and records real traffic/console/screenshots.
 *     `--manual` instead runs the browse-and-capture recorder
 *     (src/recorders/browse-and-capture.mjs), which opens a visible browser
 *     for a human to drive. `record` is kept as a hidden alias for `capture`.
 *
 *   mockify mcp
 *     Starts a stdio MCP server (src/mcp/server.ts) exposing capture_start,
 *     capture_finish, get_capture_guide, and the 13 browser_* tools, so any
 *     MCP-capable agent (not just the Claude Agent SDK path above) can drive
 *     a capture session.
 *
 *   mockify synthesize --data <captureDir>
 *     Infers endpoint templates + response shapes from a capture's
 *     traffic.json and writes <captureDir>/synthetic/{index,examples}.json
 *     (src/synthesize/generate.ts). Runs automatically after `mockify
 *     capture` too; this is for regenerating on demand (e.g. after hand-
 *     editing traffic.json).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCaptureAgent } from './agent/runner.js';
import { resolveStorageStateInput } from './agent/storage-state.js';
import { generateSynthetic } from './synthesize/generate.js';
import type { CapturedTraffic } from './format/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printUsage(): void {
  console.error('Usage: mockify <command> [options]');
  console.error('');
  console.error('Commands:');
  console.error('  serve [--port N] [--data <path>]                    Start the mock server');
  console.error('  capture --url <url> [options]                       Record traffic from a live site (agent-driven by default)');
  console.error('  synthesize --data <captureDir>                      Infer endpoint templates + response shapes for unrecorded requests');
  console.error('  mcp                                                 Start a stdio MCP server exposing capture tools to any MCP-capable agent');
  console.error('');
  console.error('capture options:');
  console.error('  --output <dir>                Output directory (default: captures/<ISO-timestamp>)');
  console.error('  --headed                       Show the browser window instead of running headless');
  console.error('  --manual                       Drive the browser yourself instead of the agent');
  console.error('  --storage-state <path|keychain:name>       Start authenticated from a saved storage state');
  console.error('  --save-storage-state <path|keychain:name>  Persist cookies/localStorage after capture');
  console.error('  --timeout <seconds>            Wall-clock budget for the agent run');
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

function defaultOutputDir(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  return path.join(process.cwd(), 'captures', timestamp);
}

function runManualCapture(url: string, args: string[]): void {
  const outputArg = parseFlag(args, '--output');
  const recorderPath = path.join(__dirname, 'recorders', 'browse-and-capture.mjs');
  const child = spawn(process.execPath, [recorderPath], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TARGET_BASE_URL: url,
      ...(outputArg ? { CAPTURE_OUTPUT_DIR: path.resolve(process.cwd(), outputArg) } : {}),
    },
  });

  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error(`[mockify] Failed to launch recorder: ${err.message}`);
    process.exit(1);
  });
}

async function runAgentCapture(url: string, args: string[]): Promise<void> {
  // The Agent SDK can authenticate three ways: an explicit API key, an
  // OAuth token minted via `claude setup-token`, or an ambient Claude Code
  // login already present on this machine (the common case on a developer's
  // own machine). Only the first two are visible as env vars, so their
  // absence is informational, not fatal — the SDK falls back to the logged
  // -in session, and the real failure surface (if auth genuinely fails) is
  // the runner's classified auth error, which names all three remedies.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error("note: no ANTHROPIC_API_KEY set — relying on Claude Code's logged-in session");
  }

  const outputDir = path.resolve(process.cwd(), parseFlag(args, '--output') ?? defaultOutputDir());
  const headed = hasFlag(args, '--headed');
  const storageState = parseFlag(args, '--storage-state');
  const saveStorageState = parseFlag(args, '--save-storage-state');
  const timeoutArg = parseFlag(args, '--timeout');

  let timeoutMs: number | undefined;
  if (timeoutArg !== undefined) {
    const seconds = Number(timeoutArg);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.error(`error: --timeout must be a positive number of seconds, got "${timeoutArg}"`);
      process.exit(1);
    }
    timeoutMs = seconds * 1000;
  }

  // Pre-validate --storage-state before launching a browser, so a bad path
  // or missing keychain item fails fast with a clear message.
  if (storageState) {
    const resolved = await resolveStorageStateInput(storageState, (msg) => console.error(msg));
    if (!resolved.ok) {
      console.error(`error: ${resolved.error.error}: ${resolved.error.hint} (${resolved.error.target})`);
      process.exit(1);
    }
  }

  try {
    const result = await runCaptureAgent({
      url,
      outputDir,
      headed,
      storageState,
      saveStorageState,
      timeoutMs,
      debug: hasFlag(args, '--debug'),
    });
    console.error(`Capture complete (cost: $${result.costUsd.toFixed(4)}) → ${outputDir}`);
    console.error(`Serve it: mockify serve --data ${outputDir}`);
  } catch (err) {
    console.error(`error: capture failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runCapture(args: string[]): Promise<void> {
  const url = parseFlag(args, '--url');
  if (!url) {
    console.error('Usage: mockify capture --url <url> [options]');
    process.exit(1);
  }

  try {
    new URL(url);
  } catch {
    console.error(`error: --url is not a valid URL: "${url}"`);
    process.exit(1);
  }

  if (hasFlag(args, '--manual')) {
    runManualCapture(url, args);
    return;
  }

  await runAgentCapture(url, args);
}

async function runMcp(): Promise<void> {
  const { startMockifyMcpServer } = await import('./mcp/server.js');
  await startMockifyMcpServer();
}

/** Resolve a --data argument (traffic.json file OR a capture directory
 * containing one) to the capture directory that holds/receives synthetic/. */
function resolveCaptureDir(dataArg: string): { captureDir: string; trafficPath: string } {
  const resolved = path.resolve(process.cwd(), dataArg);
  if (!fs.existsSync(resolved)) {
    console.error(`error: --data path does not exist: ${resolved}`);
    process.exit(1);
  }
  if (fs.statSync(resolved).isDirectory()) {
    const trafficPath = path.join(resolved, 'traffic.json');
    if (!fs.existsSync(trafficPath)) {
      console.error(`error: no traffic.json found in ${resolved}`);
      process.exit(1);
    }
    return { captureDir: resolved, trafficPath };
  }
  return { captureDir: path.dirname(resolved), trafficPath: resolved };
}

async function runSynthesize(args: string[]): Promise<void> {
  const data = parseFlag(args, '--data');
  if (!data) {
    console.error('Usage: mockify synthesize --data <captureDir>');
    process.exit(1);
  }

  const { captureDir, trafficPath } = resolveCaptureDir(data);
  const entries = JSON.parse(fs.readFileSync(trafficPath, 'utf8')) as CapturedTraffic[];
  const summary = generateSynthetic(entries, captureDir);

  console.error(`Synthesized ${summary.templateCount} endpoint template(s) from ${entries.length} traffic entries`);
  console.error(`  → ${summary.indexPath}`);
  console.error(`  → ${summary.examplesPath}`);
  for (const t of summary.templates) {
    const params = t.paramNames.length > 0 ? ` (params: ${t.paramNames.join(', ')})` : '';
    console.error(`  ${t.method.padEnd(6)} ${t.pathTemplate}${params} — ${t.entryCount} sample(s)`);
  }
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'serve':
      await runServe(rest);
      return;
    case 'capture':
    case 'record': // hidden alias for `capture`
      await runCapture(rest);
      return;
    case 'synthesize':
      await runSynthesize(rest);
      return;
    case 'mcp':
      await runMcp();
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
