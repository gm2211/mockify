/**
 * src/mcp/server.ts — Mockify capture tools over the Model Context Protocol
 *
 * Exposes mockify's capture tooling (src/agent/capture.ts CaptureCollector,
 * src/agent/observation.ts ObservationRecorder, src/agent/executor.ts
 * executeCommand) as a standalone stdio MCP server, so ANY MCP-capable
 * agent — not just the Claude Agent SDK's in-process agent
 * (src/agent/browser-mcp.ts, src/agent/runner.ts) — can drive a capture
 * session. This is a separate integration surface: it does not import from
 * or modify browser-mcp.ts/runner.ts, it just reuses the same lower-level
 * building blocks those files already reuse.
 *
 * Session model: at most one capture session is open at a time (a single
 * headless browser + collector + recorder), tracked in a small in-memory
 * SessionStore. `capture_start` opens it, `capture_finish` closes it, and
 * every `browser_*` tool operates on whatever session is currently open —
 * erroring informatively if none is.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Browser, Page } from 'playwright';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CaptureCollector } from '../agent/capture.js';
import { ObservationRecorder } from '../agent/observation.js';
import { executeCommand, type AgentCommand, type StepRecorder } from '../agent/executor.js';
import { generateSynthetic } from '../synthesize/generate.js';

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Loosened shape of an open capture session: real callers get a real
 * playwright Browser/Page + CaptureCollector + ObservationRecorder (built by
 * `launchCaptureSession` below, mirroring src/agent/runner.ts's
 * launchBrowserSession), but tests can substitute lightweight fakes that
 * only implement the methods actually used here — the same pattern
 * src/agent/executor.test.ts uses for `Page`.
 */
export interface McpCaptureSession {
  browser: Pick<Browser, 'close'>;
  page: Page;
  collector: Pick<CaptureCollector, 'screenshot' | 'getTraffic' | 'getConsoleLogs' | 'save'>;
  observationRecorder: StepRecorder & Pick<ObservationRecorder, 'save'>;
  outputDir: string;
  url: string;
}

export interface SessionStore {
  get(): McpCaptureSession | null;
  set(session: McpCaptureSession | null): void;
}

export function createSessionStore(): SessionStore {
  let session: McpCaptureSession | null = null;
  return {
    get: () => session,
    set: (next) => {
      session = next;
    },
  };
}

const NO_SESSION_MESSAGE = 'No capture session is open. Call capture_start first.';

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
}

/** Error shape mirrors executor.ts's CommandResult, so callers can parse browser_* results uniformly whether the failure came from executeCommand or from a missing session. */
function noSessionResult(action: string): ToolResult {
  return fail({ type: 'result', action, success: false, error: NO_SESSION_MESSAGE });
}

// ---------------------------------------------------------------------------
// capture_start — launch a headless browser session
// ---------------------------------------------------------------------------

function defaultOutputDir(): string {
  // Matches src/cli.ts's defaultOutputDir() exactly, so `mockify capture` and
  // `mockify mcp` produce directories that sort and look the same way.
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  return path.join(process.cwd(), 'captures', timestamp);
}

async function launchCaptureSession(url: string, outputDir: string): Promise<McpCaptureSession> {
  const { chromium } = await import('playwright');

  const collector = new CaptureCollector({
    outputDir,
    targetUrl: url,
    hostFilter: new URL(url).hostname,
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
    await collector.attachToContext(context);
    const page = await context.newPage();
    collector.attachToPage(page);

    const observationRecorder = new ObservationRecorder({ outputDir, page, collector });

    // Step 0 = the initial goto, same convention as runner.ts's
    // launchBrowserSession — without it the recorded trace would be blind
    // to the navigation that established the starting page.
    await observationRecorder.beginStep('goto', { url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const initialScreenshot = await collector.screenshot(page, 'initial');
    await observationRecorder.endStep({ success: true, screenshot: initialScreenshot });

    return { browser, page, collector, observationRecorder, outputDir, url };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

async function handleCaptureStart(
  store: SessionStore,
  args: { url: string; outputDir?: string },
): Promise<ToolResult> {
  try {
    new URL(args.url);
  } catch {
    return fail({ error: `"${args.url}" is not a valid URL` });
  }

  const existing = store.get();
  if (existing) {
    return fail({
      error: `A capture session is already open for ${existing.url}. Call capture_finish before starting a new one.`,
    });
  }

  const outputDir = path.resolve(process.cwd(), args.outputDir ?? defaultOutputDir());
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const session = await launchCaptureSession(args.url, outputDir);
    store.set(session);
    const title = await session.page.title().catch(() => '');
    return ok({ outputDir, title, url: session.page.url() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail({ error: `capture_start failed: ${message}` });
  }
}

// ---------------------------------------------------------------------------
// capture_finish — save + close
// ---------------------------------------------------------------------------

async function handleCaptureFinish(
  store: SessionStore,
  args: { summary?: string },
): Promise<ToolResult> {
  const session = store.get();
  if (!session) return noSessionResult('capture_finish');

  // Clear the store first so a failure below never leaves a half-closed
  // session that later tool calls could still (incorrectly) act on.
  store.set(null);

  try {
    session.observationRecorder.save();
  } catch {
    // Observation trace is best-effort; never break session teardown.
  }

  const manifest = session.collector.save();

  let syntheticTemplates: number | undefined;
  try {
    syntheticTemplates = generateSynthetic(
      session.collector.getTraffic(),
      session.outputDir,
    ).templateCount;
  } catch {
    // Synthesis is an enhancement over the raw capture; never fail teardown.
  }

  if (args.summary) {
    try {
      fs.appendFileSync(
        path.join(session.outputDir, 'summary.txt'),
        `\nAgent summary:\n${args.summary}\n`,
        'utf-8',
      );
    } catch {
      // best-effort
    }
  }

  await session.browser.close().catch(() => {});

  return ok({
    outputDir: session.outputDir,
    requestCount: manifest.session.totalRequests,
    screenshotCount: manifest.session.totalScreenshots,
    consoleCount: manifest.session.consoleLogCount,
    syntheticTemplates,
  });
}

// ---------------------------------------------------------------------------
// browser_* — delegate to executor.ts's executeCommand
// ---------------------------------------------------------------------------

function browserTool<TArgs>(action: string, toCommand: (args: TArgs) => AgentCommand) {
  return (store: SessionStore) => {
    return async (args: TArgs): Promise<ToolResult> => {
      const session = store.get();
      if (!session) return noSessionResult(action);
      const screenshotFn = (name: string) => session.collector.screenshot(session.page, name);
      const result = await executeCommand(session.page, toCommand(args), screenshotFn, session.observationRecorder);
      return ok(result);
    };
  };
}

// ---------------------------------------------------------------------------
// get_capture_guide — target-agnostic version of src/agent/prompts.ts
// ---------------------------------------------------------------------------

/**
 * Exploration guide for an MCP-connected agent driving mockify's capture
 * tools. Adapted from getCapturePrompt() in src/agent/prompts.ts: same
 * exploration strategy, but phrased as instructions to whatever agent is
 * connected (no URL baked in — the agent already knows it, since it's the
 * one that called capture_start).
 */
export function getCaptureGuideText(): string {
  return `You are driving mockify's capture tools to record a web application's real
HTTP traffic so it can be replayed later as a faithful mock server.

## Before You Start
Call capture_start with the target URL. This launches a headless browser,
navigates there, and begins recording every request/response pair, console
log, and screenshot automatically. From then on, use the browser_* tools for
every action you take — direct interaction through any other channel is
invisible to the recorder, so the capture would be incomplete.

## Exploration Strategy

### Phase 1: Breadth Survey (prioritize this first)
1. Read the current page (browser_content) and take a screenshot.
2. Identify ALL navigation paths: nav bars, menus, sidebar links, footer links.
3. Visit each top-level section briefly — screenshot + note what it does.
4. Build a mental map of the application's structure.

### Phase 2: Identify Core Features
From your breadth survey, identify the 3-5 most important features.

### Phase 3: Deep Exploration of Core Features
For each core feature, explore in depth:
- Fill out forms with realistic data (browser_fill / browser_type). Try
  different input combinations.
- Submit forms and observe results.
- Click every button (browser_click). Open every modal/dropdown.
- Test edge cases: empty submissions, invalid data, boundary values.
- Navigate through multi-step flows completely.

### Phase 4: Secondary Features
Visit remaining sections. Screenshot initial state, try primary interaction.

### Phase 5: Authentication & State Boundaries
- Try login/signup if present.
- Check authenticated vs unauthenticated views.

## What to Exercise
The goal is complete, faithful traffic capture — not a written spec. Make
sure every JSON/API endpoint the app calls gets exercised, so the recorded
traffic can power a faithful mock server:
- List, detail, create, update, and delete flows for every resource type.
- Pagination (next/prev pages, page-size changes).
- Filters, search, and sort variants.
- Error states: invalid input, not-found, unauthorized/unauthenticated calls.

## Recording Rules
- Traffic and console logs are recorded automatically once capture_start has
  run.
- Screenshots are taken automatically on navigation and other mutating
  actions; take manual ones (browser_screenshot) for important
  non-navigation states.

## What NOT to Do
- Don't get stuck on one page.
- Don't explore external links (a different registrable domain than the target).
- Don't try to break security.
- Don't guess credentials.

## When You're Done
Call capture_finish, optionally with a short plain-text summary of what was
explored. It saves the recorded traffic/console/screenshots/observations to
disk, closes the browser, and reports how much was captured.`;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (store: SessionStore) => (args: any) => Promise<ToolResult>;
}

const BROWSER_TOOL_DEFS: ToolDef[] = [
  {
    name: 'browser_goto',
    description: 'Navigate to a URL',
    inputSchema: { url: z.string(), waitUntil: z.string().optional(), timeout: z.number().optional() },
    handler: browserTool('goto', (args: { url: string; waitUntil?: string; timeout?: number }) => ({
      action: 'goto',
      url: args.url,
      options: { waitUntil: args.waitUntil, timeout: args.timeout },
    })),
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector',
    inputSchema: { selector: z.string(), timeout: z.number().optional() },
    handler: browserTool('click', (args: { selector: string; timeout?: number }) => ({
      action: 'click',
      selector: args.selector,
      options: { timeout: args.timeout },
    })),
  },
  {
    name: 'browser_fill',
    description: 'Fill an input element by CSS selector',
    inputSchema: { selector: z.string(), value: z.string() },
    handler: browserTool('fill', (args: { selector: string; value: string }) => ({
      action: 'fill',
      selector: args.selector,
      value: args.value,
    })),
  },
  {
    name: 'browser_type',
    description: 'Type text character by character into an element',
    inputSchema: { selector: z.string(), text: z.string(), delay: z.number().optional() },
    handler: browserTool('type', (args: { selector: string; text: string; delay?: number }) => ({
      action: 'type',
      selector: args.selector,
      text: args.text,
      options: { delay: args.delay },
    })),
  },
  {
    name: 'browser_select',
    description: 'Select an option from a dropdown by CSS selector',
    inputSchema: { selector: z.string(), value: z.string() },
    handler: browserTool('selectOption', (args: { selector: string; value: string }) => ({
      action: 'selectOption',
      selector: args.selector,
      value: args.value,
    })),
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element by CSS selector',
    inputSchema: { selector: z.string() },
    handler: browserTool('hover', (args: { selector: string }) => ({
      action: 'hover',
      selector: args.selector,
    })),
  },
  {
    name: 'browser_press',
    description: 'Press a key on an element by CSS selector',
    inputSchema: { selector: z.string(), key: z.string() },
    handler: browserTool('press', (args: { selector: string; key: string }) => ({
      action: 'press',
      selector: args.selector,
      key: args.key,
    })),
  },
  {
    name: 'browser_screenshot',
    description: 'Take a manual screenshot with an optional name',
    inputSchema: { name: z.string().optional() },
    handler: browserTool('screenshot', (args: { name?: string }) => ({
      action: 'screenshot',
      name: args.name,
    })),
  },
  {
    name: 'browser_content',
    description: 'Get the current page HTML content',
    inputSchema: {},
    handler: browserTool('content', () => ({ action: 'content' })),
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the page context',
    inputSchema: { expression: z.string() },
    handler: browserTool('evaluate', (args: { expression: string }) => ({
      action: 'evaluate',
      expression: args.expression,
    })),
  },
  {
    name: 'browser_url',
    description: 'Get the current page URL',
    inputSchema: {},
    handler: browserTool('url', () => ({ action: 'url' })),
  },
  {
    name: 'browser_title',
    description: 'Get the current page title',
    inputSchema: {},
    handler: browserTool('title', () => ({ action: 'title' })),
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for a CSS selector to appear on the page',
    inputSchema: { selector: z.string(), state: z.string().optional(), timeout: z.number().optional() },
    handler: browserTool('waitForSelector', (args: { selector: string; state?: string; timeout?: number }) => ({
      action: 'waitForSelector',
      selector: args.selector,
      options: { state: args.state, timeout: args.timeout },
    })),
  },
];

const SESSION_TOOL_DEFS: ToolDef[] = [
  {
    name: 'capture_start',
    description:
      'Start a capture session: launches a headless browser, navigates to the given URL, and begins recording traffic/console/screenshots. Errors if a session is already open.',
    inputSchema: { url: z.string().describe('Target URL to open and capture'), outputDir: z.string().optional().describe('Output directory (default: captures/<ISO-timestamp> under cwd)') },
    handler: (store: SessionStore) => (args: { url: string; outputDir?: string }) => handleCaptureStart(store, args),
  },
  {
    name: 'capture_finish',
    description:
      'Finish the open capture session: saves traffic/console/screenshots/observations to disk and closes the browser. Returns counts of what was captured.',
    inputSchema: { summary: z.string().optional().describe('Optional plain-text summary of what was explored, appended to summary.txt') },
    handler: (store: SessionStore) => (args: { summary?: string }) => handleCaptureFinish(store, args),
  },
  {
    name: 'get_capture_guide',
    description:
      'Get the exploration guide for driving a mockify capture session: phased strategy for surveying and exercising an application so its full API surface gets captured.',
    inputSchema: {},
    handler: () => async () => ok(getCaptureGuideText()),
  },
];

export const ALL_TOOL_DEFS: ToolDef[] = [...SESSION_TOOL_DEFS, ...BROWSER_TOOL_DEFS];

/** Names of every tool this server registers — used by tests and for documentation. */
export const TOOL_NAMES: string[] = ALL_TOOL_DEFS.map((def) => def.name);

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

const GUIDE_RESOURCE_URI = 'mockify://capture-guide';

export function registerMockifyTools(server: McpServer, store: SessionStore): void {
  for (const def of ALL_TOOL_DEFS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, def.handler(store));
  }

  // Also expose the guide as a resource — the tool form (get_capture_guide)
  // is the actual requirement, this is a bonus for clients that browse
  // resources before/instead of calling tools.
  server.registerResource(
    'mockify-capture-guide',
    GUIDE_RESOURCE_URI,
    {
      title: 'Mockify Capture Guide',
      description: 'Exploration guide for driving a mockify capture session',
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: getCaptureGuideText(), mimeType: 'text/plain' }],
    }),
  );
}

export function createMockifyMcpServer(): { server: McpServer; store: SessionStore } {
  const store = createSessionStore();
  const server = new McpServer({ name: 'mockify', version: '0.1.0' });
  registerMockifyTools(server, store);
  return { server, store };
}

// ---------------------------------------------------------------------------
// Public entry point — wired from `mockify mcp` in src/cli.ts
// ---------------------------------------------------------------------------

/**
 * Start the stdio MCP server and keep the process alive for as long as the
 * transport stays open. Also installs SIGINT/SIGTERM handlers and a
 * transport-close hook that save any open capture session (observations
 * then collector, matching runner.ts's finally-ordering) before exit, so a
 * client disconnecting or the process being killed never silently loses
 * whatever traffic was already recorded.
 */
export async function startMockifyMcpServer(): Promise<void> {
  const { server, store } = createMockifyMcpServer();
  const transport = new StdioServerTransport();

  let saving: Promise<void> | undefined;
  const autoSaveOpenSession = (): Promise<void> => {
    if (saving) return saving;
    saving = (async () => {
      const session = store.get();
      if (!session) return;
      store.set(null);
      try {
        session.observationRecorder.save();
      } catch {
        // best-effort
      }
      try {
        session.collector.save();
      } catch {
        // best-effort
      }
      await session.browser.close().catch(() => {});
    })();
    return saving;
  };

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[mockify mcp] received ${signal}, saving any open capture session...\n`);
    autoSaveOpenSession()
      .catch((err) => {
        process.stderr.write(`[mockify mcp] auto-save failed: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);

  // McpServer.connect() takes ownership of the transport and overwrites
  // transport.onclose with its own cleanup — so we chain our auto-save onto
  // whatever it set, rather than assigning before connect() (which would
  // just get clobbered).
  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    autoSaveOpenSession()
      .catch((err) => {
        process.stderr.write(`[mockify mcp] auto-save on transport close failed: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        if (previousOnClose) previousOnClose();
      });
  };

  process.stderr.write('[mockify mcp] stdio server ready.\n');
}
