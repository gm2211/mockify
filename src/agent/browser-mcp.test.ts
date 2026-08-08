import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserMcpServer } from './browser-mcp.js';

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

test('createBrowserMcpServer returns a valid MCP server config', () => {
  const page = mockPage();
  const screenshotFn = async (name: string) => `/tmp/${name}.png`;
  const server = createBrowserMcpServer(page, screenshotFn);

  assert.ok(server, 'should return a server config');
  assert.equal(server.type, 'sdk');
  assert.ok(server.instance, 'should have an instance');
});

test('createBrowserMcpServer with a custom serverName and askUserHandler still returns a valid MCP server config', () => {
  const page = mockPage();
  const screenshotFn = async (name: string) => `/tmp/${name}.png`;
  const server = createBrowserMcpServer(page, screenshotFn, 'browser', async () => 'answer');

  assert.ok(server);
  assert.equal(server.type, 'sdk');
  assert.ok(server.instance);
});
