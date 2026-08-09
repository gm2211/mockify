/**
 * src/agent/runner.ts — Capture-only agent runner for mockify
 *
 * A capture-only slice extracted from specify's src/agent/sdk-runner.ts
 * (not a full copy — see mockify's port notes). Launches Playwright +
 * CaptureCollector against a URL, drives Claude via the Agent SDK's query()
 * with browser MCP tools, and saves traffic/console/screenshots/observations
 * when the run ends, whether it succeeded or failed. Everything
 * spec/memory/monitor/fault-injection/CLI-target related from the source
 * runner has been cut — this file only knows how to capture traffic from a
 * live web target.
 */

import * as fs from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import { CaptureCollector } from './capture.js';
import { ObservationRecorder } from './observation.js';
import { createBrowserMcpServer } from './browser-mcp.js';
import { resolveStorageStateInput, saveStorageStateOutput } from './storage-state.js';
import { getCapturePrompt } from './prompts.js';
import { generateSynthetic } from '../synthesize/generate.js';

/**
 * Numeric override from the environment for per-run agent caps
 * (MOCKIFY_MAX_BUDGET_USD, MOCKIFY_MAX_TURNS) — mirrors specify's
 * SPECIFY_MAX_BUDGET_USD/SPECIFY_MAX_TURNS envNumber() helper.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Error thrown when the Agent SDK returns a non-success result. */
export class AgentError extends Error {
  constructor(
    public readonly subtype: string,
    public readonly costUsd: number,
    public readonly cause?: unknown,
  ) {
    super(`Agent ended with ${subtype}`);
    this.name = 'AgentError';
  }
}

// ---------------------------------------------------------------------------
// Error classification for retry logic
// ---------------------------------------------------------------------------

type ErrorClass = 'transient' | 'auth' | 'fatal';

function classifyError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Transient network/connection errors
  const transientPatterns = [
    'ebadf', 'econnreset', 'econnrefused', 'etimedout', 'epipe',
    'socket hang up', 'network error', 'fetch failed',
    'overloaded', '529', '500', '502', '503', '504', '429',
  ];
  if (transientPatterns.some((p) => lower.includes(p))) return 'transient';

  // Auth errors
  if (lower.includes('401') || lower.includes('authentication') || lower.includes('unauthorized')) {
    return 'auth';
  }

  return 'fatal';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Actionable remediation text appended to any error the runner classifies as
 * an auth failure. The Agent SDK can authenticate three distinct ways — an
 * explicit API key, an OAuth token minted via `claude setup-token`, or an
 * ambient Claude Code login already present on this machine — so a bare
 * "check ANTHROPIC_API_KEY" message would be actively wrong for an operator
 * relying on one of the other two. This text names all three so the failure
 * is actionable regardless of which one the operator normally uses.
 */
const AUTH_REMEDY_MESSAGE =
  'Authenticate one of these ways: export ANTHROPIC_API_KEY=sk-ant-...; ' +
  'run `claude setup-token` to mint a CLAUDE_CODE_OAUTH_TOKEN; or log in to ' +
  'Claude Code (`claude login`) so the SDK can use your logged-in session.';

function withAuthRemedy(message: string): string {
  return message.includes(AUTH_REMEDY_MESSAGE) ? message : `${message}\n\n${AUTH_REMEDY_MESSAGE}`;
}

// ---------------------------------------------------------------------------
// stderr ring buffer helpers
// ---------------------------------------------------------------------------

const STDERR_CAPTURE_LIMIT = 8 * 1024; // 8 KB tail

/** Append data to a ring buffer, keeping only the last STDERR_CAPTURE_LIMIT bytes. */
function appendToRingBuffer(buf: string, data: string): string {
  const combined = buf + data;
  if (combined.length > STDERR_CAPTURE_LIMIT) {
    return combined.slice(combined.length - STDERR_CAPTURE_LIMIT);
  }
  return combined;
}

/**
 * Wrap an error to include captured Claude CLI stderr, if any.
 * Returns the original error when stderr is empty or already included.
 */
function wrapWithStderr(err: unknown, stderrTail: string): unknown {
  if (!stderrTail.trim()) return err;
  // Already includes our stderr marker — don't double-append.
  if (err instanceof Error && err.message.includes('— stderr:')) return err;
  const tail = stderrTail.trim();
  if (err instanceof AgentError) {
    const enhanced = new AgentError(err.subtype, err.costUsd, err.cause);
    enhanced.message = `${err.message} — stderr: ${tail}`;
    enhanced.stack = err.stack;
    return enhanced;
  }
  if (err instanceof Error) {
    const enhanced = new Error(`${err.message} — stderr: ${tail}`);
    enhanced.stack = err.stack;
    return enhanced;
  }
  return new Error(`${String(err)} — stderr: ${tail}`);
}

// ---------------------------------------------------------------------------
// Browser session management
// ---------------------------------------------------------------------------

interface BrowserSession {
  browser: import('playwright').Browser;
  collector: CaptureCollector;
  observationRecorder: ObservationRecorder;
  page: import('playwright').Page;
  mcpServer: McpServerConfig;
}

async function launchBrowserSession(
  url: string,
  captureOutputDir: string,
  headed: boolean,
  askUserHandler: ((question: string) => Promise<string>) | undefined,
  storageState: string | undefined,
): Promise<BrowserSession> {
  const { chromium } = await import('playwright');

  const parsedUrl = new URL(url);
  const contextOptions: Record<string, unknown> = {
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  };
  if (storageState) {
    const resolved = await resolveStorageStateInput(storageState, (msg) => process.stderr.write(msg + '\n'));
    if (!resolved.ok) {
      throw new Error(`${resolved.error.error}: ${resolved.error.hint} (${resolved.error.target})`);
    }
    contextOptions.storageState = resolved.contextValue;
  }
  let navigateUrl = url;
  if (parsedUrl.username) {
    contextOptions.httpCredentials = {
      username: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password),
    };
    parsedUrl.username = '';
    parsedUrl.password = '';
    navigateUrl = parsedUrl.toString();
  }

  // Output goes straight into captureOutputDir — unlike specify, which
  // nests web-target captures under outputDir/capture (to make room for a
  // sibling `local`/`remote` session in compare tasks), mockify only ever
  // has one session, so there's no sibling to make room for.
  const collector = new CaptureCollector({
    outputDir: captureOutputDir,
    targetUrl: url,
    hostFilter: new URL(url).hostname,
  });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext(contextOptions as Parameters<typeof browser.newContext>[0]);
  await collector.attachToContext(context);
  const page = await context.newPage();
  collector.attachToPage(page);

  const observationRecorder = new ObservationRecorder({
    outputDir: captureOutputDir,
    page,
    collector,
  });

  // Step 0 = the initial goto. Without this, the runner-recorded trace would
  // be invisible for the navigation that establishes the starting page.
  await observationRecorder.beginStep('goto', { url: navigateUrl });
  await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const initialScreenshot = await collector.screenshot(page, 'initial');
  await observationRecorder.endStep({ success: true, screenshot: initialScreenshot });

  const mcpServer = createBrowserMcpServer(
    page,
    (name: string) => collector.screenshot(page, name),
    'browser',
    askUserHandler,
    observationRecorder,
  );

  return { browser, collector, observationRecorder, page, mcpServer };
}

const BROWSER_TOOL_NAMES = [
  'mcp__browser__browser_goto', 'mcp__browser__browser_click',
  'mcp__browser__browser_fill', 'mcp__browser__browser_type',
  'mcp__browser__browser_select', 'mcp__browser__browser_hover',
  'mcp__browser__browser_press', 'mcp__browser__browser_screenshot',
  'mcp__browser__browser_content', 'mcp__browser__browser_evaluate',
  'mcp__browser__browser_url', 'mcp__browser__browser_title',
  'mcp__browser__browser_wait_for',
  'mcp__browser__ask_user',
];

// ---------------------------------------------------------------------------
// Core agent execution
// ---------------------------------------------------------------------------

interface QueryResult {
  result: string;
  costUsd: number;
}

async function executeQuery(queryOptions: Options, prompt: string, debug: boolean | undefined): Promise<QueryResult> {
  let finalResult = '';
  let costUsd = 0;
  let receivedFirstMessage = false;

  // Buffer the last STDERR_CAPTURE_LIMIT bytes from the claude CLI subprocess.
  // When the SDK throws 'Claude Code process exited with code N' the real cause
  // (auth error, quota, model-not-found, …) is in this buffer.
  let stderrBuf = '';
  const optionsWithStderr: Options = {
    ...queryOptions,
    stderr: (data: string) => {
      stderrBuf = appendToRingBuffer(stderrBuf, data);
      if (queryOptions.stderr) queryOptions.stderr(data);
    },
  };

  const q = query({ prompt, options: optionsWithStderr });

  // Timeout for initial connection — if no message arrives in 30s, bail
  const INIT_TIMEOUT_MS = 30_000;
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  const initTimeout = new Promise<never>((_, reject) => {
    initTimer = setTimeout(() => {
      if (!receivedFirstMessage) {
        const base =
          'Timed out waiting for API connection (30s). This usually means ' +
          `authentication failed. ${AUTH_REMEDY_MESSAGE}`;
        const msg = stderrBuf.trim() ? `${base} — stderr: ${stderrBuf.trim()}` : base;
        reject(new Error(msg));
      }
    }, INIT_TIMEOUT_MS);
  });

  try {
    // Race: either we get messages or we time out
    const iterator = q[Symbol.asyncIterator]();
    while (true) {
      const nextPromise = iterator.next();
      const result = receivedFirstMessage
        ? await nextPromise
        : await Promise.race([nextPromise, initTimeout]);

      if (result.done) break;
      const message = result.value;

      if (!receivedFirstMessage) {
        receivedFirstMessage = true;
        if (initTimer) clearTimeout(initTimer);
        process.stderr.write('  Agent connected.\n');
      }

      if (message.type === 'auth_status') {
        const authMsg = message as { isAuthenticating: boolean; output: string[]; error?: string };
        if (authMsg.error) {
          throw wrapWithStderr(
            new Error(withAuthRemedy(`Authentication failed: ${authMsg.error}`)),
            stderrBuf,
          ) as Error;
        }
        if (authMsg.isAuthenticating) {
          process.stderr.write('  Authenticating...\n');
        }
        for (const line of authMsg.output) {
          if (debug) process.stderr.write(`  ${line}\n`);
        }
        continue;
      }

      if (message.type === 'assistant') {
        const textBlocks = message.message.content.filter((b: { type: string }) => b.type === 'text');
        for (const block of textBlocks) {
          const text = (block as { type: 'text'; text: string }).text;
          if (debug) process.stderr.write(text + '\n');
        }
        if (debug) process.stderr.write('\n');
      } else if (message.type === 'tool_use_summary' && 'summary' in message) {
        const summary = (message as { summary: string }).summary;
        if (debug) process.stderr.write(`  \x1b[2m${summary}\x1b[0m\n`);
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          finalResult = message.result;
          costUsd = message.total_cost_usd;
        } else {
          costUsd = message.total_cost_usd;
          throw wrapWithStderr(new AgentError(message.subtype, costUsd), stderrBuf);
        }
      }
    }
  } catch (err) {
    // Wrap any error that bubbles out of the query iteration with the captured
    // stderr tail. This covers the most common case: the SDK throws
    // 'Claude Code process exited with code 1' and discards subprocess stderr.
    throw wrapWithStderr(err, stderrBuf);
  } finally {
    if (initTimer) clearTimeout(initTimer);
  }

  return { result: finalResult, costUsd };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface CaptureAgentOptions {
  /** Target URL to explore and capture traffic from. */
  url: string;
  /** Directory traffic.json/console.json/screenshots/observations.json/manifest.json are written into. */
  outputDir: string;
  /** Launch a visible browser window instead of headless. */
  headed?: boolean;
  /** Path or `keychain:<name>` — storage state (cookies/localStorage) loaded before navigating, so the run starts authenticated. */
  storageState?: string;
  /** Path or `keychain:<name>` — where to persist the context's storage state once the run completes normally. */
  saveStorageState?: string;
  /** Optional wall-clock budget for the whole run, in milliseconds. */
  timeoutMs?: number;
  /** Verbose agent output (assistant text, tool-use summaries) to stderr. */
  debug?: boolean;
  /** Custom ask_user handler (defaults to a readline prompt on stderr). */
  askUserHandler?: (question: string) => Promise<string>;
  /** Max retry attempts for transient API errors (default: 3). */
  maxRetries?: number;
}

export interface CaptureAgentResult {
  /** The agent's final plain-text summary. */
  result: string;
  /** Total cost of the run in USD. */
  costUsd: number;
}

/**
 * Drive a Claude agent to explore `opts.url`, capturing its HTTP traffic,
 * console logs, and screenshots into `opts.outputDir` along the way.
 * Capture data is saved on the way out (finally block) whether the agent
 * run succeeds or throws, so a failed/aborted run still leaves whatever
 * traffic was observed before the failure.
 */
export async function runCaptureAgent(opts: CaptureAgentOptions): Promise<CaptureAgentResult> {
  fs.mkdirSync(opts.outputDir, { recursive: true });

  let session: BrowserSession | undefined;

  // Optional wall-clock timeout for the whole run (not just a single query
  // attempt): wired into the SDK's own abortController so an in-flight query
  // is actually cancelled, not just skipped on the next retry iteration.
  const abortController = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) {
    timeoutTimer = setTimeout(() => {
      abortController.abort(new Error(`Capture timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  }

  try {
    process.stderr.write('  Launching browser...\n');
    session = await launchBrowserSession(opts.url, opts.outputDir, !!opts.headed, opts.askUserHandler, opts.storageState);
    process.stderr.write('  Browser ready.\n');

    const mcpServers: Record<string, McpServerConfig> = { browser: session.mcpServer };
    const systemPrompt = getCapturePrompt(opts.url);
    const userPrompt = `Explore ${opts.url} and capture its traffic comprehensively.`;

    const queryOptions: Options = {
      model: process.env.MOCKIFY_MODEL || 'claude-opus-4-6',
      systemPrompt,
      thinking: { type: 'adaptive' },
      mcpServers,
      allowedTools: ['Read', 'Write', ...BROWSER_TOOL_NAMES],
      // Sandbox: a capture session must be restricted to the browser MCP
      // channel (plus the file I/O it needs). Any action taken outside that
      // channel is invisible to the CaptureCollector, so a faithful capture
      // is only possible if the channel is exclusive — not merely the one
      // we expect the model to prefer.
      //
      // `allowedTools` (above) only auto-approves listed tools for the
      // permission prompt — it does NOT restrict which tools are available
      // to the model (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
      // "To restrict which tools are available, use the `tools` option
      // instead."). Combined with permissionMode 'bypassPermissions' +
      // allowDangerouslySkipPermissions, omitting an explicit restriction
      // would leave the full built-in tool set (Bash, WebFetch, WebSearch,
      // etc.) available regardless of `allowedTools`. `disallowedTools`
      // removes tools from the model's context outright, even if otherwise
      // allowed, so it's the mechanism that actually restricts the channel.
      disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: process.cwd(),
      maxTurns: envNumber('MOCKIFY_MAX_TURNS', 200),
      maxBudgetUsd: envNumber('MOCKIFY_MAX_BUDGET_USD', 5),
      persistSession: false,
      abortController,
    };

    process.stderr.write('  Connecting to API...\n');

    // Retry loop for transient errors
    const maxRetries = opts.maxRetries ?? 3;
    let lastError: unknown;
    let totalCostUsd = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          const delayMs = 1000 * Math.pow(2, attempt - 1); // 2s, 4s
          process.stderr.write(`  Retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})...\n`);
          await sleep(delayMs);
        }

        const result = await executeQuery(queryOptions, userPrompt, opts.debug);
        return { result: result.result, costUsd: result.costUsd + totalCostUsd };
      } catch (err) {
        lastError = err;
        const errClass = classifyError(err);

        if (err instanceof AgentError) {
          totalCostUsd += err.costUsd;
        }

        if (errClass === 'fatal' || errClass === 'auth' || attempt === maxRetries) {
          // Fatal, auth (retrying won't fix a bad credential), or exhausted
          // retries — propagate. Auth failures get the actionable remedy
          // text appended here, at the real failure surface.
          const msg = err instanceof Error ? err.message : String(err);
          if (errClass === 'auth') {
            if (err instanceof AgentError) {
              const enhanced = new AgentError(err.subtype, totalCostUsd, err);
              enhanced.message = withAuthRemedy(msg);
              throw enhanced;
            }
            const enhanced = new Error(withAuthRemedy(msg));
            if (err instanceof Error) enhanced.stack = err.stack;
            throw enhanced;
          }
          if (err instanceof AgentError) {
            throw new AgentError(err.subtype, totalCostUsd, err);
          }
          throw err;
        }

        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Transient error: ${msg}\n`);
      }
    }

    // Should not reach here, but just in case
    throw lastError;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);

    // --save-storage-state: persist cookies + localStorage for reuse in
    // later --storage-state runs. Best-effort so a save failure never masks
    // the run's real result.
    if (opts.saveStorageState && session) {
      try {
        await saveStorageStateOutput(opts.saveStorageState, session.page.context(), (msg) => process.stderr.write(msg + '\n'));
      } catch (err) {
        process.stderr.write(`Warning: failed to save storage state: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    if (session) {
      try {
        session.observationRecorder.save();
      } catch {
        // Observation trace is best-effort; never break session teardown.
      }
      session.collector.save();
      // Generalize the capture beyond its literal exchanges — best-effort,
      // never breaks capture teardown (see SP-lsc.2).
      try {
        const summary = generateSynthetic(session.collector.getTraffic(), opts.outputDir);
        process.stderr.write(
          `Synthesized ${summary.templateCount} endpoint template(s) → ${summary.outDir}\n`
        );
      } catch (err) {
        process.stderr.write(
          `Warning: synthesis generation failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
      await session.browser.close().catch(() => {});
    }
  }
}
