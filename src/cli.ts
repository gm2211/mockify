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
 *     traffic.json and writes <captureDir>/synthetic/index.json
 *     (src/synthesize/generate.ts). Runs automatically after `mockify
 *     capture` too; this is for regenerating on demand (e.g. after hand-
 *     editing traffic.json).
 *
 *   mockify infer <name|path> [--rounds N] [--holdout <ratio>] [--json]
 *     Generates a real mock implementation (src/infer/generate.ts) from a
 *     capture: an LLM writes `<captureDir>/impl/handlers.mjs` — real
 *     routing + an in-memory store, not a memorized lookup table — trained
 *     only on a portion of the capture and iterated against the validation
 *     harness (src/infer/harness.ts) up to `--rounds` times (default 3).
 *     The remaining portion (`--holdout`, default 0.2) is never shown to the
 *     model; it's used once, at the end, to grade the winning attempt and
 *     detect memorization (src/infer/hardcoding.ts). Writes
 *     `<captureDir>/impl/report.json` alongside the implementation. Exits
 *     non-zero if the final implementation fails to load or is flagged
 *     likely_hardcoded.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCaptureAgent } from './agent/runner.js';
import { resolveStorageStateInput } from './agent/storage-state.js';
import { generateSynthetic } from './synthesize/generate.js';
import { startMockServer, type ReplayMode } from './mock-server.js';
import { allocateCaptureDir, listCaptures, resolveCapture, summarizeCapture, type CaptureSummary } from './captures/store.js';
import type { CapturedTraffic } from './format/types.js';
import { loadImplementation, ImplementationLoadError } from './infer/contract.js';
import { splitPairs } from './infer/split.js';
import { validateImplementation, type Grade, type ValidationResult } from './infer/harness.js';
import { computeGap, scanForHardcoding } from './infer/hardcoding.js';
import { inferImplementation, type InferProgressEvent } from './infer/generate.js';

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
  '--impl', '--rounds', '--holdout', '--mode',
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
  console.error('  replay <name|path> [--port N] [--mode M] [--impl <path>]  Replay a saved capture');
  console.error('  serve [--port N] [--data <path>]                    Back-compat alias for replay');
  console.error('  synthesize --data <captureDir>                      Infer endpoint templates + response shapes for unrecorded requests');
  console.error('  validate <name|path> [--impl <path>] [--json]       Grade a generated implementation against a capture (train/holdout + hardcoding check)');
  console.error('  infer <name|path> [--rounds N] [--holdout R] [--json]  Generate a real mock implementation from a capture');
  console.error('  mcp                                                 Start a stdio MCP server exposing capture tools to any MCP-capable agent');
  console.error('');
  console.error('replay options:');
  console.error('  --mode <auto|record|impl|synthetic>  Which tiers to consult beyond recorded (default: auto — all tiers)');
  console.error('                                  auto:      recorded → implementation → synthetic');
  console.error('                                  record:    recorded only, then 404 (exact-replay for regression tests)');
  console.error('                                  impl:      recorded → implementation, then 404 (no shape synthesis)');
  console.error('                                  synthetic: recorded → synthesis, then 404 (skip a misbehaving implementation)');
  console.error('  --impl <path>                  Override the implementation module (default: <capture>/impl/handlers.mjs)');
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

const REPLAY_MODES: ReplayMode[] = ['auto', 'record', 'impl', 'synthetic'];

function parseMode(raw: string | undefined, usage: string): ReplayMode {
  if (raw === undefined) return 'auto';
  if (!REPLAY_MODES.includes(raw as ReplayMode)) {
    console.error(`error: --mode must be one of ${REPLAY_MODES.join(', ')}, got "${raw}"`);
    console.error(usage);
    process.exit(1);
  }
  return raw as ReplayMode;
}

/** Human-readable tier chain for the replay banner — see mock-server.ts's
 * module doc ("Four-tier response pipeline") for what each mode actually
 * gates. */
function tierChain(mode: ReplayMode): string {
  switch (mode) {
    case 'auto':
      return 'implementation → recorded → synthetic';
    case 'record':
      return 'recorded only';
    case 'impl':
      return 'implementation → recorded';
    case 'synthetic':
      return 'recorded → synthetic';
  }
}

function formatPct(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? 'n/a' : `${(rate * 100).toFixed(0)}%`;
}

async function runReplay(args: string[]): Promise<void> {
  const usage = 'Usage: mockify replay <name|path> [--port N] [--mode auto|record|impl|synthetic] [--impl <path>]';
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
  const mode = parseMode(parseFlag(args, '--mode'), usage);
  const implArg = parseFlag(args, '--impl');
  const implPath = implArg ? path.resolve(process.cwd(), implArg) : undefined;

  const started = await startMockServer({ dataPath: resolved.dir, port, quiet: true, mode, implPath });

  const summary = summarizeCapture(resolved.name, resolved.dir);

  console.error('');
  console.error(`Replaying "${resolved.name}"${summary?.target ? ` → ${summary.target}` : ''}`);
  console.error(`  ${started.routeCount} recorded route(s), ${started.syntheticTemplateCount} synthetic template(s)`);
  console.error(`  tiers: ${tierChain(started.mode)}`);

  const implActive = started.mode === 'auto' || started.mode === 'impl';
  if (implActive && started.implementation.impl) {
    const report = started.implementation.report;
    if (report?.gap) {
      console.error(
        `  implementation: ${started.implementation.implPath} ` +
          `(train ${formatPct(report.gap.trainRate)} / holdout ${formatPct(report.gap.holdoutRate)} pass rate, ` +
          `gap verdict: ${report.gap.verdict ?? 'unknown'})`
      );
      if (report.gap.verdict === 'likely_hardcoded') {
        console.error('');
        console.error(
          '  ⚠ WARNING: this implementation is flagged likely_hardcoded (see impl/report.json) — it may have'
        );
        console.error(
          '    memorized training responses instead of modeling the API. Consider `--mode synthetic` to bypass'
        );
        console.error('    it, or re-run `mockify infer` for a better attempt.');
        console.error('');
      }
    } else {
      console.error(`  implementation: ${started.implementation.implPath} (no impl/report.json quality summary found)`);
    }
  } else if (implActive && started.implementation.loadError) {
    console.error(
      `  implementation: FAILED to load from ${started.implementation.implPath} — ${started.implementation.loadError}`
    );
  }

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
  for (const t of summary.templates) {
    const params = t.paramNames.length > 0 ? ` (params: ${t.paramNames.join(', ')})` : '';
    console.error(`  ${t.method.padEnd(6)} ${t.pathTemplate}${params} — ${t.entryCount} sample(s)`);
  }
}

// ---------------------------------------------------------------------------
// validate — grade a generated implementation against a capture
// ---------------------------------------------------------------------------

const GRADE_COLUMNS: Grade[] = ['exact', 'structural', 'status_only', 'fail'];

function printGradeSummary(label: string, result: ValidationResult): void {
  const g = result.overall;
  console.log(
    `${label}: ${result.total} pair(s) — exact ${g.exact}, structural ${g.structural}, ` +
      `status_only ${g.status_only}, fail ${g.fail}`
  );
}

function printPerTemplateTable(label: string, result: ValidationResult): void {
  if (result.perTemplate.length === 0) return;
  console.log(`${label} per-template breakdown:`);
  const rows = result.perTemplate.map((t) => ({
    method: t.method,
    pathTemplate: t.pathTemplate,
    pairs: String(t.pairs),
    ...Object.fromEntries(GRADE_COLUMNS.map((g) => [g, String(t.grades[g])])),
  }));
  const headers = ['METHOD', 'TEMPLATE', 'PAIRS', 'EXACT', 'STRUCTURAL', 'STATUS_ONLY', 'FAIL'];
  const keys = ['method', 'pathTemplate', 'pairs', 'exact', 'structural', 'status_only', 'fail'] as const;
  const widths = keys.map((k, i) =>
    Math.max(headers[i].length, ...rows.map((r) => String(r[k as keyof typeof r]).length))
  );
  const row = (cells: string[]): string => '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log(row(headers));
  for (const r of rows) {
    console.log(row(keys.map((k) => String(r[k as keyof typeof r]))));
  }
}

async function runValidate(args: string[]): Promise<void> {
  const usage = 'Usage: mockify validate <name|path> [--impl <path>] [--json]';
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

  const implArg = parseFlag(args, '--impl');
  const implPath = implArg
    ? path.resolve(process.cwd(), implArg)
    : path.join(resolved.dir, 'impl', 'handlers.mjs');
  const jsonOut = hasFlag(args, '--json');

  let impl;
  try {
    impl = await loadImplementation(implPath);
  } catch (err) {
    if (err instanceof ImplementationLoadError && err.code === 'not_found') {
      if (jsonOut) {
        console.log(JSON.stringify({ error: 'no_implementation', implPath }, null, 2));
      } else {
        console.error(`No implementation found at ${implPath}.`);
        console.error('');
        console.error("This is expected today — mockify doesn't generate implementations yet.");
        console.error('This command (`mockify validate`) is the measuring instrument for a forthcoming');
        console.error('`mockify infer` command that will generate one from this capture. Once that');
        console.error(`exists and writes ${path.join(resolved.dir, 'impl', 'handlers.mjs')},`);
        console.error('run this command again to grade it.');
      }
      process.exit(1);
      return;
    }
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const trafficPath = path.join(resolved.dir, 'traffic.json');
  const entries = JSON.parse(fs.readFileSync(trafficPath, 'utf8')) as CapturedTraffic[];

  const { train, holdout, counts } = splitPairs(entries);
  const trainResult = await validateImplementation(impl, train);
  const holdoutResult = await validateImplementation(impl, holdout);
  const gap = computeGap(trainResult, holdoutResult);

  const sourceCode = fs.readFileSync(implPath, 'utf8');
  const capturedResponses = entries.map((e) => e.responseBody ?? '');
  const scan = scanForHardcoding(sourceCode, capturedResponses);

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          capture: resolved.name,
          implPath,
          splitCounts: counts,
          train: trainResult,
          holdout: holdoutResult,
          gap,
          hardcodingScan: scan,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Validating "${resolved.name}" against ${implPath}`);
  console.log('');
  console.log(
    `Split: ${entries.length} total pair(s) → ${train.length} train, ${holdout.length} holdout ` +
      `(${counts.length} endpoint template(s))`
  );
  console.log('');
  printGradeSummary('Train', trainResult);
  printGradeSummary('Holdout', holdoutResult);
  console.log('');

  if (gap.verdict === 'insufficient_holdout') {
    console.log('Held-out gap: not enough holdout pairs to compute one.');
  } else {
    const trainPct = (gap.trainRate * 100).toFixed(0);
    const holdoutPct = ((gap.holdoutRate ?? 0) * 100).toFixed(0);
    const gapPct = ((gap.gap ?? 0) * 100).toFixed(0);
    const thresholdPct = (gap.threshold * 100).toFixed(0);
    console.log(
      `Held-out gap: train=${trainPct}% holdout=${holdoutPct}% gap=${gapPct}pp ` +
        `(threshold ${thresholdPct}pp) → ${gap.verdict.toUpperCase()}`
    );
  }
  console.log('');

  printPerTemplateTable('Train', trainResult);
  console.log('');
  printPerTemplateTable('Holdout', holdoutResult);
  console.log('');

  console.log(
    `Hardcoding scan: ${scan.matchedValues}/${scan.totalDistinctiveValues} distinctive captured value(s) ` +
      `appear verbatim in the implementation source (ratio ${scan.ratio.toFixed(2)})`
  );
  if (scan.evidence.length > 0) {
    console.log('  Some overlap can be legitimate (enum values, field names, correctly-reproduced seed');
    console.log('  data) — this is evidence to weigh, not a verdict. Top matches:');
    for (const e of scan.evidence.slice(0, 10)) {
      const shown = e.value.length > 60 ? `${e.value.slice(0, 57)}...` : e.value;
      console.log(`    ${e.occurrences}x  "${shown}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// infer — generate a real mock implementation from a capture
// ---------------------------------------------------------------------------

function onInferProgress(event: InferProgressEvent): void {
  switch (event.type) {
    case 'sampling':
      console.error(
        `Sampled ${event.templateCount} endpoint template(s), ${event.trainCount} train / ` +
          `${event.holdoutCount} holdout pair(s) — prompt ${event.promptChars.toLocaleString()} chars ` +
          `(${event.examplesPerTemplate} example(s)/template, bodies capped at ${event.bodyCharCap} chars)`
      );
      break;
    case 'budget_warning':
      console.error(
        `warning: budget is $${event.budgetUsd}, but a ${event.promptChars.toLocaleString()}-char prompt has ` +
          `historically needed roughly $${event.suggestedMinUsd.toFixed(0)} per round on the default model — ` +
          `raise ${event.envVar} if generation stops with a budget error`
      );
      break;
    case 'round_start':
      console.error(`round ${event.round}/${event.rounds}: generating...`);
      break;
    case 'round_generated':
      console.error(`round ${event.round}: received ${event.sourceChars.toLocaleString()} char(s)`);
      break;
    case 'round_load_error':
      console.error(`round ${event.round}: failed to load — ${event.error}`);
      break;
    case 'round_generation_error':
      console.error(`round ${event.round}: generation failed — ${event.error}`);
      break;
    case 'round_scored':
      console.error(
        `round ${event.round}: train pass rate ${(event.trainRate * 100).toFixed(0)}% ` +
          `(exact ${event.overall.exact}, structural ${event.overall.structural}, ` +
          `status_only ${event.overall.status_only}, fail ${event.overall.fail})`
      );
      break;
    case 'best_selected':
      console.error(`best attempt: round ${event.round} (train pass rate ${(event.trainRate * 100).toFixed(0)}%)`);
      break;
    case 'final_scoring_start':
      console.error('Scoring the best attempt against holdout...');
      break;
    case 'done':
      break;
  }
}

async function runInfer(args: string[]): Promise<void> {
  const usage = 'Usage: mockify infer <name|path> [--rounds N] [--holdout <ratio>] [--json]';
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

  const roundsArg = parseFlag(args, '--rounds');
  let rounds: number | undefined;
  if (roundsArg !== undefined) {
    rounds = Number(roundsArg);
    if (!Number.isFinite(rounds) || rounds <= 0) {
      console.error(`error: --rounds must be a positive number, got "${roundsArg}"`);
      process.exit(1);
      return;
    }
  }

  const holdoutArg = parseFlag(args, '--holdout');
  let holdoutRatio: number | undefined;
  if (holdoutArg !== undefined) {
    holdoutRatio = Number(holdoutArg);
    if (!Number.isFinite(holdoutRatio) || holdoutRatio <= 0 || holdoutRatio >= 1) {
      console.error(`error: --holdout must be a ratio between 0 and 1, got "${holdoutArg}"`);
      process.exit(1);
      return;
    }
  }

  const jsonOut = hasFlag(args, '--json');

  let summary;
  try {
    summary = await inferImplementation({
      captureDir: resolved.dir,
      rounds,
      holdoutRatio,
      onProgress: onInferProgress,
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  if (jsonOut) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    console.log(
      `Inferred implementation for "${resolved.name}" (${summary.roundsUsed}/${summary.roundsMax} round(s), ` +
        `model ${summary.model}, best round ${summary.bestRound})`
    );
    console.log('');
    printGradeSummary('Train', summary.train);
    printGradeSummary('Holdout', summary.holdout);
    console.log('');

    if (summary.gap.verdict === 'insufficient_holdout') {
      console.log('Held-out gap: not enough holdout pairs to compute one.');
    } else {
      const trainPct = (summary.gap.trainRate * 100).toFixed(0);
      const holdoutPct = ((summary.gap.holdoutRate ?? 0) * 100).toFixed(0);
      const gapPct = ((summary.gap.gap ?? 0) * 100).toFixed(0);
      const thresholdPct = (summary.gap.threshold * 100).toFixed(0);
      console.log(
        `Held-out gap: train=${trainPct}% holdout=${holdoutPct}% gap=${gapPct}pp ` +
          `(threshold ${thresholdPct}pp) → ${summary.gap.verdict.toUpperCase()}`
      );
    }
    console.log('');

    printPerTemplateTable('Train', summary.train);
    console.log('');
    printPerTemplateTable('Holdout', summary.holdout);
    console.log('');

    console.log(
      `Hardcoding scan: ${summary.hardcoding.matchedValues}/${summary.hardcoding.totalDistinctiveValues} distinctive ` +
        `captured value(s) appear verbatim in the implementation source (ratio ${summary.hardcoding.ratio.toFixed(2)})`
    );
    if (summary.hardcoding.evidence.length > 0) {
      for (const e of summary.hardcoding.evidence.slice(0, 10)) {
        const shown = e.value.length > 60 ? `${e.value.slice(0, 57)}...` : e.value;
        console.log(`    ${e.occurrences}x  "${shown}"`);
      }
    }
    console.log('');

    console.log(`Implementation: ${summary.implPath}`);
    console.log(`Report:         ${summary.reportPath}`);
  }

  if (summary.gap.verdict === 'likely_hardcoded') {
    console.error('');
    console.error(
      'error: the generated implementation is likely hardcoded — it memorized train responses instead of ' +
        `modeling the API (train/holdout gap ${((summary.gap.gap ?? 0) * 100).toFixed(0)}pp exceeds the ` +
        `${(summary.gap.threshold * 100).toFixed(0)}pp threshold). Not safe to use.`
    );
    process.exit(1);
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
    case 'validate':
      await runValidate(rest);
      return;
    case 'infer':
      await runInfer(rest);
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
