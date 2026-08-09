#!/usr/bin/env node
/**
 * src/cli.ts — mockify CLI entry point
 *
 * Subcommands:
 *   mockify capture --url <url> [--name <name>] [--output <dir>] [--headed]
 *                    [--manual] [--storage-state <path|keychain:name>]
 *                    [--save-storage-state <path|keychain:name>]
 *                    [--timeout <seconds>]
 *     Agent mode (default): drives a Claude agent (src/agent/runner.ts) that
 *     explores the target and records real traffic/console/screenshots.
 *     `--manual` instead runs the browse-and-capture recorder
 *     (src/recorders/browse-and-capture.mjs), which opens a visible browser
 *     for a human to drive. `record` is kept as a hidden alias for `capture`.
 *     The capture is saved under a name (src/captures/store.ts): `--name`
 *     wins, otherwise the name defaults to a slug of the target URL's
 *     hostname (e.g. `automationintesting-online`). `--output <dir>` bypasses
 *     naming entirely and writes straight to `<dir>`.
 *
 *   mockify list [--json]
 *     Lists every saved capture (src/captures/store.ts) as a table: name,
 *     target, request/screenshot/synthetic-template counts, and when it was
 *     captured.
 *
 *   mockify replay <name|path> [--port N]
 *     Starts the mock server (src/mock-server.ts) against a saved capture —
 *     by name (as shown in `mockify list`) or by a filesystem path to a
 *     capture directory / traffic.json. No env vars required; port defaults
 *     to 3456.
 *
 *   mockify serve [--port N] [--data <path>]
 *     Back-compat alias for `replay`: starts the mock server against
 *     `--data` (or MOCK_DATA_PATH, or the newest capture found under
 *     `<cwd>/captures/` when neither is given) on `--port` (or PORT, or
 *     3456). `--data` accepts either a traffic.json file or a capture
 *     directory containing one. Prefer `mockify replay <name>`.
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
import { startMockServer } from './mock-server.js';
import { allocateCaptureDir, listCaptures, resolveCapture, summarizeCapture, type CaptureSummary } from './captures/store.js';
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

/** Flags in this CLI that consume the following argument as their value —
 * used so positional-argument parsing (e.g. `replay <name>`) can skip over
 * `--flag value` pairs regardless of where they appear. */
const VALUE_FLAGS = new Set([
  '--port', '--data', '--output', '--name', '--url',
  '--storage-state', '--save-storage-state', '--timeout',
]);

/** First argument that isn't a flag or a flag's value. */
function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function printUsage(): void {
  console.error('Usage: mockify <command> [options]');
  console.error('');
  console.error('Commands:');
  console.error('  capture --url <url> [options]                       Record traffic from a live site (agent-driven by default)');
  console.error('  list [--json]                                       List saved captures');
  console.error('  replay <name|path> [--port N]                       Replay a saved capture');
  console.error('  serve [--port N] [--data <path>]                    Back-compat alias for replay');
  console.error('  synthesize --data <captureDir>                      Infer endpoint templates + response shapes for unrecorded requests');
  console.error('  mcp                                                 Start a stdio MCP server exposing capture tools to any MCP-capable agent');
  console.error('');
  console.error('capture options:');
  console.error('  --name <name>                  Name to save the capture under (default: slugified from the URL)');
  console.error('  --output <dir>                 Output directory, bypassing name-based capture storage entirely');
  console.error('  --headed                       Show the browser window instead of running headless');
  console.error('  --manual                       Drive the browser yourself instead of the agent');
  console.error('  --storage-state <path|keychain:name>       Start authenticated from a saved storage state');
  console.error('  --save-storage-state <path|keychain:name>  Persist cookies/localStorage after capture');
  console.error('  --timeout <seconds>            Wall-clock budget for the agent run');
}

// ---------------------------------------------------------------------------
// serve / replay — start the mock server
// ---------------------------------------------------------------------------

function parsePort(raw: string | undefined, usage: string): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`error: --port must be a positive number, got "${raw}"`);
    console.error(usage);
    process.exit(1);
  }
  return port;
}

async function runServe(args: string[]): Promise<void> {
  const port = parsePort(parseFlag(args, '--port'), 'Usage: mockify serve [--data <path>] [--port N]');
  const data = parseFlag(args, '--data');

  console.error('note: `mockify serve` is a back-compat alias — prefer `mockify replay <name>` (see `mockify list`).');

  await startMockServer({
    dataPath: data ? path.resolve(process.cwd(), data) : undefined,
    port,
  });
}

async function runReplay(args: string[]): Promise<void> {
  const usage = 'Usage: mockify replay <name|path> [--port N]';
  const nameOrPath = firstPositional(args);
  if (!nameOrPath) {
    console.error(usage);
    process.exit(1);
    return;
  }

  let resolved: { name: string; dir: string };
  try {
    resolved = resolveCapture(nameOrPath);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const port = parsePort(parseFlag(args, '--port'), usage);
  const started = await startMockServer({ dataPath: resolved.dir, port, quiet: true });

  const summary = summarizeCapture(resolved.name, resolved.dir);

  console.error('');
  console.error(`Replaying "${resolved.name}"${summary?.target ? ` → ${summary.target}` : ''}`);
  console.error(`  ${started.routeCount} recorded route(s), ${started.syntheticTemplateCount} synthetic template(s)`);
  console.error(`  → http://localhost:${started.port}`);
}

// ---------------------------------------------------------------------------
// list — show saved captures
// ---------------------------------------------------------------------------

function formatCapturedAt(iso: string): string {
  if (!iso) return '-';
  return iso;
}

function printCapturesTable(captures: CaptureSummary[]): void {
  const columns: Array<{ header: string; get: (c: CaptureSummary) => string }> = [
    { header: 'NAME', get: (c) => c.name },
    { header: 'TARGET', get: (c) => c.target || '-' },
    { header: 'REQUESTS', get: (c) => String(c.requests) },
    { header: 'SCREENSHOTS', get: (c) => String(c.screenshots) },
    { header: 'SYNTHETIC', get: (c) => String(c.syntheticTemplates) },
    { header: 'CAPTURED', get: (c) => formatCapturedAt(c.capturedAt) },
  ];

  const widths = columns.map((col) =>
    Math.max(col.header.length, ...captures.map((c) => col.get(c).length))
  );

  const row = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  console.log(row(columns.map((c) => c.header)));
  for (const capture of captures) {
    console.log(row(columns.map((c) => c.get(capture))));
  }
}

function runList(args: string[]): void {
  const captures = listCaptures();

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(captures, null, 2));
    return;
  }

  if (captures.length === 0) {
    console.log('No captures saved yet. Run: mockify capture --url <url>');
    return;
  }

  printCapturesTable(captures);
}

// ---------------------------------------------------------------------------
// capture — record traffic from a live site
// ---------------------------------------------------------------------------

function runManualCapture(url: string, args: string[]): void {
  const outputArg = parseFlag(args, '--output');
  const nameArg = parseFlag(args, '--name');
  const recorderPath = path.join(__dirname, 'recorders', 'browse-and-capture.mjs');

  const env: NodeJS.ProcessEnv = { ...process.env, TARGET_BASE_URL: url };
  if (outputArg) {
    env.CAPTURE_OUTPUT_DIR = path.resolve(process.cwd(), outputArg);
  } else {
    // No explicit --output: default to a named capture directory (same
    // naming as agent/MCP captures) so this shows up in `mockify list`.
    const allocated = allocateCaptureDir(url, nameArg);
    env.CAPTURE_EXACT_OUTPUT_DIR = allocated.dir;
  }

  const child = spawn(process.execPath, [recorderPath], {
    stdio: 'inherit',
    env,
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

  const outputArg = parseFlag(args, '--output');
  const nameArg = parseFlag(args, '--name');

  let outputDir: string;
  let captureName: string;
  if (outputArg) {
    outputDir = path.resolve(process.cwd(), outputArg);
    captureName = path.basename(outputDir);
  } else {
    const allocated = allocateCaptureDir(url, nameArg);
    outputDir = allocated.dir;
    captureName = allocated.name;
  }

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
    console.error(`Capture complete (cost: $${result.costUsd.toFixed(4)})`);

    const summary = summarizeCapture(captureName, outputDir);
    const requests = summary?.requests ?? 0;
    const screenshots = summary?.screenshots ?? 0;
    const syntheticTemplates = summary?.syntheticTemplates ?? 0;
    console.error(
      `Capture saved as "${captureName}" (${requests} requests, ${screenshots} screenshots, ${syntheticTemplates} synthetic templates)`
    );
    console.error(`Replay it:  mockify replay ${captureName}`);
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
    case 'replay':
      await runReplay(rest);
      return;
    case 'list':
      runList(rest);
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
