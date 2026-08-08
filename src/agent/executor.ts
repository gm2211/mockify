/**
 * src/agent/executor.ts — Playwright command execution
 *
 * Provides executeCommand() which proxies Playwright page actions and handles
 * auto-screenshots on navigation. Used by the browser MCP server.
 */

import type { Page } from 'playwright';
import type { ObservationRecorder } from './observation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentCommand =
  | { action: 'goto'; url: string; options?: { waitUntil?: string; timeout?: number } }
  | { action: 'click'; selector: string; options?: { timeout?: number } }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'type'; selector: string; text: string; options?: { delay?: number } }
  | { action: 'selectOption'; selector: string; value: string | string[] }
  | { action: 'check'; selector: string }
  | { action: 'uncheck'; selector: string }
  | { action: 'hover'; selector: string }
  | { action: 'press'; selector: string; key: string }
  | { action: 'waitForSelector'; selector: string; options?: { state?: string; timeout?: number } }
  | { action: 'waitForTimeout'; ms: number }
  | { action: 'waitForURL'; url: string; options?: { timeout?: number } }
  | { action: 'evaluate'; expression: string }
  | { action: 'screenshot'; name?: string }
  | { action: 'content' }
  | { action: 'url' }
  | { action: 'title' }
  | { action: 'done' };

export interface CommandResult {
  type: 'result';
  action: string;
  success: boolean;
  url: string;
  screenshot?: string;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Execute a single Playwright command
// ---------------------------------------------------------------------------

export async function executeCommand(
  page: Page,
  cmd: AgentCommand,
  screenshotFn?: (name: string) => Promise<string>,
  recorder?: ObservationRecorder,
): Promise<CommandResult> {
  if (cmd.action === 'done') {
    return { type: 'result', action: 'done', success: true, url: page.url() };
  }

  if (recorder) {
    const args: Record<string, unknown> = {};
    if ('selector' in cmd) args.selector = cmd.selector;
    if ('url' in cmd) args.url = cmd.url;
    await recorder.beginStep(cmd.action, args);
  }

  try {
    let data: unknown = undefined;
    let screenshot: string | undefined;
    const urlBefore = page.url();

    switch (cmd.action) {
      case 'goto':
        await page.goto(cmd.url, {
          waitUntil: (cmd.options?.waitUntil as 'domcontentloaded') ?? 'domcontentloaded',
          timeout: cmd.options?.timeout ?? 15_000,
        });
        break;

      case 'click':
        await page.click(cmd.selector, { timeout: cmd.options?.timeout });
        await page.waitForTimeout(300);
        break;

      case 'fill':
        await page.fill(cmd.selector, cmd.value);
        break;

      case 'type':
        await page.locator(cmd.selector).pressSequentially(cmd.text, { delay: cmd.options?.delay ?? 50 });
        break;

      case 'selectOption':
        await page.selectOption(cmd.selector, cmd.value);
        break;

      case 'check':
        await page.check(cmd.selector);
        break;

      case 'uncheck':
        await page.uncheck(cmd.selector);
        break;

      case 'hover':
        await page.hover(cmd.selector);
        break;

      case 'press':
        await page.press(cmd.selector, cmd.key);
        break;

      case 'waitForSelector':
        await page.waitForSelector(cmd.selector, {
          state: (cmd.options?.state as 'visible') ?? 'visible',
          timeout: cmd.options?.timeout ?? 10_000,
        });
        break;

      case 'waitForTimeout':
        await page.waitForTimeout(cmd.ms);
        break;

      case 'waitForURL':
        await page.waitForURL(cmd.url, { timeout: cmd.options?.timeout ?? 10_000 });
        break;

      case 'evaluate':
        data = await page.evaluate(cmd.expression);
        break;

      case 'screenshot':
        if (screenshotFn) {
          screenshot = await screenshotFn(cmd.name ?? 'agent-manual');
        }
        break;

      case 'content':
        data = await page.content();
        break;

      case 'url':
        data = page.url();
        break;

      case 'title':
        data = await page.title();
        break;
    }

    // Auto-screenshot after every mutating action (deterministic evidence capture)
    const MUTATING_ACTIONS = new Set(['goto', 'click', 'fill', 'type', 'selectOption', 'check', 'uncheck', 'hover', 'press']);
    const urlAfter = page.url();
    if (screenshotFn && cmd.action !== 'screenshot' && MUTATING_ACTIONS.has(cmd.action)) {
      const label = urlBefore !== urlAfter
        ? `nav-${slugifyUrl(urlAfter)}`
        : `${cmd.action}-${'selector' in cmd ? slugifyUrl(cmd.selector) : slugifyUrl(urlAfter)}`;
      screenshot = await screenshotFn(label);
    }

    if (recorder) {
      await recorder.endStep({ success: true, screenshot });
    }

    return {
      type: 'result',
      action: cmd.action,
      success: true,
      url: urlAfter,
      ...(screenshot ? { screenshot } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (recorder) {
      await recorder.endStep({ success: false, error: errorMessage });
    }

    return {
      type: 'result',
      action: cmd.action,
      success: false,
      url: page.url(),
      error: errorMessage,
    };
  }
}

function slugifyUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '').replace(/[/?&#=.]/g, '_').replace(/_+/g, '_').replace(/_$/, '').substring(0, 60) || 'root';
  } catch {
    return 'page';
  }
}
