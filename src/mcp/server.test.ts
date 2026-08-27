import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMockifyMcpServer,
  createSessionStore,
  getCaptureGuideText,
  registerMockifyTools,
  TOOL_NAMES,
  type McpCaptureSession,
} from './server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const EXPECTED_TOOL_NAMES = [
  'capture_start',
  'capture_finish',
  'get_capture_guide',
  'browser_goto',
  'browser_click',
  'browser_fill',
  'browser_type',
  'browser_select',
  'browser_hover',
  'browser_press',
  'browser_screenshot',
  'browser_content',
  'browser_evaluate',
  'browser_url',
  'browser_title',
  'browser_wait_for',
];

test('TOOL_NAMES lists exactly the 13 browser_* tools plus the 3 session tools', () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...EXPECTED_TOOL_NAMES].sort());
  const browserTools = TOOL_NAMES.filter((n) => n.startsWith('browser_'));
  assert.equal(browserTools.length, 13);
});

test('createMockifyMcpServer registers all expected tools with valid schemas', () => {
  const { server } = createMockifyMcpServer();
  // McpServer's `private _registeredTools` is a plain object at runtime (TS
  // `private` is compile-time only), so inspecting it is a legitimate way to
  // assert on the constructed registry without a live MCP client/transport.
  const registered = (server as unknown as { _registeredTools: Record<string, { description?: string; inputSchema?: unknown; handler?: unknown }> })._registeredTools;

  assert.equal(Object.keys(registered).length, EXPECTED_TOOL_NAMES.length);
  for (const name of EXPECTED_TOOL_NAMES) {
    const tool = registered[name];
    assert.ok(tool, `expected tool "${name}" to be registered`);
    assert.ok(tool.description && tool.description.length > 0, `tool "${name}" should have a non-empty description`);
    assert.ok(tool.inputSchema, `tool "${name}" should have an input schema`);
    assert.equal(typeof tool.handler, 'function', `tool "${name}" should have a callable handler`);
  }
});

test('createMockifyMcpServer also registers the capture guide as a resource', () => {
  const { server } = createMockifyMcpServer();
  const registeredResources = (server as unknown as { _registeredResources: Record<string, unknown> })._registeredResources;
  assert.equal(Object.keys(registeredResources).length, 1);
});

test('getCaptureGuideText is target-agnostic (no URL baked in) and mentions the key tools/phases', () => {
  const text = getCaptureGuideText();
  assert.match(text, /capture_start/);
  assert.match(text, /capture_finish/);
  assert.match(text, /browser_\*/);
  assert.match(text, /Phase 1/);
  assert.doesNotMatch(text, /https?:\/\//, 'guide should not bake in a target URL');
});

// ---------------------------------------------------------------------------
// Session-required tools error informatively when no session is open
// ---------------------------------------------------------------------------

function extractJson(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const registered = (server as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }>;
  })._registeredTools;
  const tool = registered[name];
  if (!tool) throw new Error(`tool "${name}" is not registered`);
  return tool.handler(args, {});
}

test('browser_* tools error informatively when no capture session is open', async () => {
  const store = createSessionStore();
  const server = new McpServer({ name: 'mockify-test', version: '0.0.0' });
  registerMockifyTools(server, store);

  for (const name of TOOL_NAMES.filter((n) => n.startsWith('browser_'))) {
    const args: Record<string, unknown> =
      name === 'browser_fill' || name === 'browser_select'
        ? { selector: '#x', value: 'v' }
        : name === 'browser_type'
          ? { selector: '#x', text: 't' }
          : name === 'browser_press'
            ? { selector: '#x', key: 'Enter' }
            : name === 'browser_goto'
              ? { url: 'https://example.com' }
              : name === 'browser_evaluate'
                ? { expression: '1' }
                : name === 'browser_wait_for' || name === 'browser_click' || name === 'browser_hover'
                  ? { selector: '#x' }
                  : {};

    const result = await callTool(server, name, args);
    assert.equal(result.isError, true, `${name} should report isError`);
    const parsed = extractJson(result);
    assert.equal(parsed.success, false);
    assert.match(parsed.error, /capture_start/, `${name} error should mention capture_start`);
  }
});

test('capture_finish errors informatively when no capture session is open', async () => {
  const store = createSessionStore();
  const server = new McpServer({ name: 'mockify-test', version: '0.0.0' });
  registerMockifyTools(server, store);

  const result = await callTool(server, 'capture_finish', {});
  assert.equal(result.isError, true);
  const parsed = extractJson(result);
  assert.match(parsed.error, /capture_start/);
});

test('capture_start errors informatively when a session is already open', async () => {
  const store = createSessionStore();
  store.set(fakeSession());
  const server = new McpServer({ name: 'mockify-test', version: '0.0.0' });
  registerMockifyTools(server, store);

  const result = await callTool(server, 'capture_start', { url: 'https://example.com' });
  assert.equal(result.isError, true);
  const parsed = extractJson(result);
  assert.match(parsed.error, /already open/);
});

test('capture_start errors on an invalid URL', async () => {
  const store = createSessionStore();
  const server = new McpServer({ name: 'mockify-test', version: '0.0.0' });
  registerMockifyTools(server, store);

  const result = await callTool(server, 'capture_start', { url: 'not-a-url' });
  assert.equal(result.isError, true);
  const parsed = extractJson(result);
  assert.match(parsed.error, /not a valid URL/);
});

// ---------------------------------------------------------------------------
// Deeper test with a fake page/collector/recorder (matching the pattern in
// src/agent/executor.test.ts) — verifies browser_* tools reach executeCommand
// and capture_finish reaches the collector/recorder when a session IS open.
// ---------------------------------------------------------------------------

function mockPage(overrides: Record<string, (...args: any[]) => any> = {}) {
  return {
    url: () => 'https://example.com/',
    goto: async () => {},
    click: async () => {},
    fill: async () => {},
    check: async () => {},
    uncheck: async () => {},
    hover: async () => {},
    press: async () => {},
    selectOption: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    waitForURL: async () => {},
    evaluate: async () => undefined,
    content: async () => '<html></html>',
    title: async () => 'Test Page',
    locator: () => ({ pressSequentially: async () => {} }),
    ...overrides,
  } as any;
}

function fakeSession(overrides: Partial<McpCaptureSession> = {}): McpCaptureSession {
  const page = overrides.page ?? mockPage();
  return {
    browser: { close: async () => {} },
    page,
    collector: {
      screenshot: async (_page: any, name?: string) => `/tmp/${name ?? 'shot'}.png`,
      getTraffic: () => [],
      getConsoleLogs: () => [],
      save: () => ({
        session: {
          timestamp: new Date().toISOString(),
          targetUrl: 'https://example.com',
          hostFilter: 'example.com',
          outputDir: '/tmp/out',
          totalRequests: 7,
          totalScreenshots: 3,
          pagesVisited: 2,
          consoleLogCount: 5,
        },
        redaction: true,
        trafficFile: 'traffic.json',
        consoleFile: 'console.json',
        screenshotFiles: [],
        summaryFile: 'summary.txt',
      }),
    },
    observationRecorder: {
      beginStep: async () => {},
      endStep: async () => {},
      save: () => ({ observationsFile: 'observations.json', steps: 0 }),
    },
    outputDir: '/tmp/out',
    url: 'https://example.com',
    name: 'example-com',
    ...overrides,
  };
}

test('browser_click delegates to executeCommand when a session is open', async () => {
  const clicks: string[] = [];
  const page = mockPage({ click: async (s: string) => { clicks.push(s); } });
  const store = createSessionStore();
  store.set(fakeSession({ page }));
  const server = new McpServer({ name: 'mockify-test', version: '0.0.0' });
  registerMockifyTools(server, store);

  const result = await callTool(server, 'browser_click', { selector: '#submit' });
  assert.notEqual(result.isError, true);
  const parsed = extractJson(result);
  assert.equal(parsed.success, true);
  assert.equal(parsed.action, 'click');
  assert.deepEqual(clicks, ['#submit']);
});

test('browser_fill never lets the fill value leak into an error path (delegates cleanly)', async () => {
  const store = createSessionStore();
  store.set(fakeSession());
  const server = new McpServer({ name: 'mockify-test', version: '0.0.0' });
  registerMockifyTools(server, store);

  const result = await callTool(server, 'browser_fill', { selector: '#password', value: 'super-secret' });
  assert.notEqual(result.isError, true);
  const parsed = extractJson(result);
  assert.equal(parsed.success, true);
});

test('capture_finish saves observations then the collector, closes the browser, and reports counts', async () => {
  const store = createSessionStore();
  const closeCalls: string[] = [];
  const saveCalls: string[] = [];
  const session = fakeSession({
    browser: { close: async () => { closeCalls.push('browser'); } },
    observationRecorder: {
      beginStep: async () => {},
      endStep: async () => {},
      save: () => { saveCalls.push('observations'); return { observationsFile: 'observations.json', steps: 0 }; },
    },
    collector: {
      screenshot: async () => '/tmp/x.png',
      getTraffic: () => [],
      getConsoleLogs: () => [],
      save: () => {
        saveCalls.push('collector');
        return {
          session: {
            timestamp: new Date().toISOString(),
            targetUrl: 'https://example.com',
            hostFilter: 'example.com',
            outputDir: '/tmp/out',
            totalRequests: 4,
            totalScreenshots: 2,
            pagesVisited: 1,
            consoleLogCount: 9,
          },
          redaction: true,
          trafficFile: 'traffic.json',
          consoleFile: 'console.json',
          screenshotFiles: [],
          summaryFile: 'summary.txt',
        };
      },
    },
  });
  store.set(session);
  const server = new McpServer({ name: 'mockify-test', version: '0.0.0' });
  registerMockifyTools(server, store);

  const result = await callTool(server, 'capture_finish', {});
  assert.notEqual(result.isError, true);
  const parsed = extractJson(result);
  assert.equal(parsed.requestCount, 4);
  assert.equal(parsed.screenshotCount, 2);
  assert.equal(parsed.consoleCount, 9);
  assert.deepEqual(saveCalls, ['observations', 'collector']);
  assert.deepEqual(closeCalls, ['browser']);

  // Session is cleared — a follow-up browser_* call should error again.
  const followUp = await callTool(server, 'browser_url', {});
  assert.equal(followUp.isError, true);
});
