/**
 * src/recorders/browse-and-capture.ts — Human-driven capture mode
 *
 * Opens a visible Chromium browser for a human to drive by hand: log in,
 * click around, exercise whatever flows matter. All network traffic and
 * console logs are captured through the shared CaptureCollector
 * (src/agent/capture.ts) — the same collector the agent-driven capture path
 * (src/agent/runner.ts) uses — so redaction, host filtering, and the output
 * format are identical between the two capture modes. On top of that shared
 * base this module adds the behavior a human session specifically wants:
 * a screenshot on every navigation (including SPA route changes that never
 * fire a full page load), a debounced screenshot after a substantial JSON
 * API response, periodic autosaving, and js-sources.json (script URLs seen
 * on visited pages).
 *
 * Runs in-process (invoked from src/cli.ts) rather than as a spawned child
 * script — this is what promoted it out of a standalone .mjs recorder (see
 * git history), which had to relay its output directory through env vars
 * because it resolved paths off its own __dirname/PROJECT_ROOT instead of
 * sharing the CLI's already-resolved output directory.
 *
 * Stops on Ctrl+C (SIGINT) or SIGTERM: takes a final screenshot, saves
 * storage state if requested, and writes everything to outputDir.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { CaptureCollector, registrableDomain } from '../agent/capture.js';
import { resolveStorageStateInput, saveStorageStateOutput } from '../agent/storage-state.js';
import { generateSynthetic } from '../synthesize/generate.js';
import type { CapturedTraffic, CaptureManifest } from '../format/types.js';

export interface BrowseAndCaptureOptions {
  url: string;
  outputDir: string;
  hostFilter?: string;
  /** File path or `keychain:<name>` — start the browser already authenticated. */
  storageState?: string;
  /** File path or `keychain:<name>` — persist cookies/localStorage once the human stops browsing. */
  saveStorageState?: string;
  /** Debounce window for the post-API-response screenshot. Default 800ms. */
  screenshotDebounceMs?: number;
  /** Resolves when the recording should stop; defaults to waiting for SIGINT/SIGTERM. Exposed for tests. */
  waitForStop?: () => Promise<void>;
  log?: (msg: string) => void;
}

export interface BrowseAndCaptureResult {
  outputDir: string;
  manifest: CaptureManifest;
  pagesVisited: number;
}

/** Registrable-domain host matching for navigation gating — mirrors the
 * matching CaptureCollector's shouldCapture() applies to traffic, minus the
 * static-asset filter (irrelevant for "is this page on our target site").
 * Reads MOCKIFY_CAPTURE_HOST_FILTER for the same extra-domain widening
 * shouldCapture() honors, so a target that calls a genuinely cross-origin
 * API also gets that API's pages screenshotted if the human navigates to
 * one directly. */
export function urlMatchesHostFilter(url: string, hostFilter: string): boolean {
  if (!hostFilter) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const requestDomain = registrableDomain(host);
    if (requestDomain === registrableDomain(hostFilter)) return true;

    const extra = (process.env.MOCKIFY_CAPTURE_HOST_FILTER ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (extra.includes('*')) return true;
    return extra.some((h) => requestDomain === registrableDomain(h) || host === h);
  } catch {
    return false;
  }
}

/** Whether a captured traffic entry warrants a debounced "data just loaded"
 * screenshot: a substantial (>50 char) JSON response on a successful (200)
 * request. Exported so the decision is testable without a real browser. */
export function shouldScheduleApiScreenshot(entry: Pick<CapturedTraffic, 'status' | 'contentType' | 'responseBody'>): boolean {
  if (!entry.responseBody || entry.status !== 200) return false;
  const ct = (entry.contentType ?? '').toLowerCase();
  return ct.includes('json') && entry.responseBody.length > 50;
}

function defaultWaitForStop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function runBrowseAndCapture(options: BrowseAndCaptureOptions): Promise<BrowseAndCaptureResult> {
  const log = options.log ?? ((msg: string) => process.stderr.write(msg + '\n'));
  const outputDir = path.resolve(options.outputDir);

  let hostFilter = options.hostFilter ?? '';
  if (!hostFilter) {
    try {
      hostFilter = new URL(options.url).hostname;
    } catch {
      hostFilter = '';
    }
  }

  let storageStateValue: string | Record<string, unknown> | undefined;
  if (options.storageState) {
    const resolved = await resolveStorageStateInput(options.storageState, log);
    if (!resolved.ok) {
      throw new Error(`${resolved.error.error}: ${resolved.error.hint} (${resolved.error.target})`);
    }
    storageStateValue = resolved.contextValue;
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const debounceMs = options.screenshotDebounceMs ?? 800;
  let page: Page;
  let pendingScreenshot: NodeJS.Timeout | null = null;

  const collector = new CaptureCollector({
    outputDir,
    targetUrl: options.url,
    hostFilter,
    onTrafficCaptured: (entry: CapturedTraffic) => {
      if (!shouldScheduleApiScreenshot(entry)) return;
      if (pendingScreenshot) clearTimeout(pendingScreenshot);
      pendingScreenshot = setTimeout(() => {
        pendingScreenshot = null;
        collector
          .screenshot(page, 'data-load')
          .then((p) => log(`  [screenshot] (data-load): ${path.basename(p)}`))
          .catch(() => {});
      }, debounceMs);
    },
  });

  try {
    const contextOptions: Parameters<typeof browser.newContext>[0] = {
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    };
    if (storageStateValue !== undefined) {
      contextOptions.storageState = storageStateValue as NonNullable<Parameters<typeof browser.newContext>[0]>['storageState'];
    }

    const context = await browser.newContext(contextOptions);
    await collector.attachToContext(context);

    page = await context.newPage();
    collector.attachToPage(page);

    const scriptSources = new Set<string>();
    const pageUrls = new Set<string>();
    let lastUrl = '';

    async function onNavigate(reason: 'nav' | 'spa-nav'): Promise<void> {
      const currentUrl = page.url();
      if (currentUrl === lastUrl) return;
      if (hostFilter && !urlMatchesHostFilter(currentUrl, hostFilter)) return;
      lastUrl = currentUrl;
      pageUrls.add(currentUrl);

      // Let dynamic content settle before screenshotting.
      await page.waitForTimeout(reason === 'nav' ? 1500 : 1000);
      try {
        const p = await collector.screenshot(page, reason);
        log(`  [screenshot] ${reason}: ${path.basename(p)}`);
      } catch {
        // ignore
      }
    }

    page.on('load', () => {
      onNavigate('nav').catch(() => {});
    });
    // SPA-style navigation (URL changes without a full page load) needs polling.
    const urlCheckInterval = setInterval(() => {
      onNavigate('spa-nav').catch(() => {});
    }, 1500);

    const saveInterval = setInterval(() => {
      if (collector.getTraffic().length > 0) {
        collector.save();
        log(`  [autosave] ${collector.getTraffic().length} requests, ${pageUrls.size} pages`);
      }
    }, 30_000);

    log('');
    log('Human capture mode — browse the site in the opened browser.');
    log('All traffic, console logs, and navigations are being recorded.');
    log('Press Ctrl+C in this terminal when done...');
    log('');
    log(`Opening ${options.url}...`);
    await page.goto(options.url, { waitUntil: 'domcontentloaded' });

    await (options.waitForStop ?? defaultWaitForStop)();

    log('Stopping capture...');
    clearInterval(saveInterval);
    clearInterval(urlCheckInterval);
    if (pendingScreenshot) clearTimeout(pendingScreenshot);

    try {
      const p = await collector.screenshot(page, 'final-state');
      log(`  [screenshot] final-state: ${path.basename(p)}`);
    } catch {
      // ignore
    }

    try {
      const scripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script[src]')).map((s) => (s as HTMLScriptElement).src),
      );
      scripts.forEach((s) => scriptSources.add(s));
    } catch {
      // ignore
    }

    if (options.saveStorageState) {
      await saveStorageStateOutput(options.saveStorageState, context, log);
    }

    fs.writeFileSync(
      path.join(outputDir, 'js-sources.json'),
      JSON.stringify([...scriptSources].sort(), null, 2),
    );

    const manifest = collector.save();
    log(
      `Capture complete: ${manifest.session.totalRequests} requests, ` +
        `${manifest.session.totalScreenshots} screenshots, ${pageUrls.size} pages visited`,
    );

    // Generalize the capture beyond its literal exchanges — best-effort,
    // never breaks capture teardown (see SP-lsc.2), mirrors the
    // agent-driven capture path (src/agent/runner.ts).
    try {
      const synthSummary = generateSynthetic(collector.getTraffic(), outputDir);
      log(`Synthesized ${synthSummary.templateCount} endpoint template(s) -> ${synthSummary.outDir}`);
    } catch (err) {
      log(`Warning: synthesis generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { outputDir, manifest, pagesVisited: pageUrls.size };
  } finally {
    await browser.close().catch(() => {});
  }
}
