import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCommand, type AgentCommand } from './executor.js';

// Helper: minimal mock page
function mockPage(overrides: Record<string, (...args: any[]) => any> = {}) {
  return {
    url: () => 'https://example.com/login',
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

test('executeCommand proxies click to page.click', async () => {
  const clicks: string[] = [];
  const page = mockPage({ click: async (s: string) => { clicks.push(s); } });

  const cmd: AgentCommand = { action: 'click', selector: 'button#submit' };
  const result = await executeCommand(page, cmd);

  assert.equal(result.success, true);
  assert.equal(result.action, 'click');
  assert.deepEqual(clicks, ['button#submit']);
});

test('executeCommand proxies fill to page.fill', async () => {
  const fills: Array<{ s: string; v: string }> = [];
  const page = mockPage({ fill: async (s: string, v: string) => { fills.push({ s, v }); } });

  const cmd: AgentCommand = { action: 'fill', selector: 'input#email', value: 'a@b.com' };
  const result = await executeCommand(page, cmd);

  assert.equal(result.success, true);
  assert.deepEqual(fills, [{ s: 'input#email', v: 'a@b.com' }]);
});

test('executeCommand proxies goto and auto-screenshots on navigation', async () => {
  let currentUrl = 'https://example.com/login';
  const screenshots: string[] = [];
  const page = mockPage({
    url: () => currentUrl,
    goto: async (url: string) => { currentUrl = url; },
  });
  const screenshotFn = async (name: string) => { screenshots.push(name); return `/tmp/${name}.png`; };

  const cmd: AgentCommand = { action: 'goto', url: 'https://example.com/dashboard' };
  const result = await executeCommand(page, cmd, screenshotFn);

  assert.equal(result.success, true);
  assert.equal(result.url, 'https://example.com/dashboard');
  assert.ok(result.screenshot, 'should have auto-screenshot on navigation');
  assert.equal(screenshots.length, 1);
  assert.ok(screenshots[0].startsWith('nav-'));
});

test('executeCommand auto-screenshots every mutating action (evidence capture)', async () => {
  const screenshots: string[] = [];
  const page = mockPage();
  const screenshotFn = async (name: string) => { screenshots.push(name); return `/tmp/${name}.png`; };

  const cmd: AgentCommand = { action: 'click', selector: '#btn' };
  await executeCommand(page, cmd, screenshotFn);

  // Mutation always produces a screenshot; the prefix differs by action when
  // the URL didn't change.
  assert.equal(screenshots.length, 1);
  assert.match(screenshots[0], /^click-/);
});

test('executeCommand returns done for done action', async () => {
  const page = mockPage();
  const result = await executeCommand(page, { action: 'done' });

  assert.equal(result.success, true);
  assert.equal(result.action, 'done');
});

test('executeCommand proxies evaluate and returns data', async () => {
  const page = mockPage({ evaluate: async () => 42 });

  const cmd: AgentCommand = { action: 'evaluate', expression: '1 + 1' };
  const result = await executeCommand(page, cmd);

  assert.equal(result.success, true);
  assert.equal(result.data, 42);
});

test('executeCommand proxies content and returns HTML', async () => {
  const page = mockPage({ content: async () => '<h1>Hello</h1>' });

  const result = await executeCommand(page, { action: 'content' });

  assert.equal(result.success, true);
  assert.equal(result.data, '<h1>Hello</h1>');
});

test('executeCommand proxies title', async () => {
  const page = mockPage({ title: async () => 'Login' });

  const result = await executeCommand(page, { action: 'title' });

  assert.equal(result.success, true);
  assert.equal(result.data, 'Login');
});

test('executeCommand returns error on failure without throwing', async () => {
  const page = mockPage({ click: async () => { throw new Error('Element not found'); } });

  const result = await executeCommand(page, { action: 'click', selector: '#nope' });

  assert.equal(result.success, false);
  assert.ok(result.error?.includes('Element not found'));
});

test('executeCommand proxies explicit screenshot via screenshotFn', async () => {
  const screenshots: string[] = [];
  const page = mockPage();
  const screenshotFn = async (name: string) => { screenshots.push(name); return `/tmp/${name}.png`; };

  const result = await executeCommand(page, { action: 'screenshot', name: 'after-login' }, screenshotFn);

  assert.equal(result.success, true);
  assert.deepEqual(screenshots, ['after-login']);
  assert.ok(result.screenshot);
});

function mockRecorder() {
  const calls: { begin: Array<{ action: string; args?: Record<string, unknown> }>; end: Array<{ success: boolean; error?: string; screenshot?: string }> } = { begin: [], end: [] };
  return {
    calls,
    beginStep: async (action: string, args?: Record<string, unknown>) => { calls.begin.push({ action, args }); },
    endStep: async (result: { success: boolean; error?: string; screenshot?: string }) => { calls.end.push(result); },
  } as any;
}

test('executeCommand records a step via the recorder on success', async () => {
  const page = mockPage();
  const recorder = mockRecorder();

  const result = await executeCommand(page, { action: 'click', selector: '#submit' }, undefined, recorder);

  assert.equal(result.success, true);
  assert.equal(recorder.calls.begin.length, 1);
  assert.deepEqual(recorder.calls.begin[0], { action: 'click', args: { selector: '#submit' } });
  assert.equal(recorder.calls.end.length, 1);
  assert.equal(recorder.calls.end[0].success, true);
});

test('executeCommand records a step via the recorder on failure, never a fill value', async () => {
  const page = mockPage({ fill: async () => { throw new Error('boom'); } });
  const recorder = mockRecorder();

  const result = await executeCommand(page, { action: 'fill', selector: '#password', value: 'super-secret' }, undefined, recorder);

  assert.equal(result.success, false);
  assert.equal(recorder.calls.begin.length, 1);
  // Only selector is recordable — the fill value must never reach the recorder.
  assert.deepEqual(recorder.calls.begin[0].args, { selector: '#password' });
  assert.equal(recorder.calls.end.length, 1);
  assert.equal(recorder.calls.end[0].success, false);
  assert.match(recorder.calls.end[0].error ?? '', /boom/);
});

test('executeCommand does not invoke the recorder for the done action', async () => {
  const page = mockPage();
  const recorder = mockRecorder();

  await executeCommand(page, { action: 'done' }, undefined, recorder);

  assert.equal(recorder.calls.begin.length, 0);
  assert.equal(recorder.calls.end.length, 0);
});
