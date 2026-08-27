/**
 * src/agent/capture.ts — Capture collector for the agent runner
 *
 * Wraps Playwright's request/response interception, collects console logs,
 * manages screenshot naming and storage, and outputs the standard capture
 * format that the validator expects.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import type { CapturedTraffic, CapturedConsoleEntry, CaptureManifest } from '../format/types.js';
import { CURRENT_CAPTURE_FORMAT_VERSION } from '../format/types.js';
import { redactTrafficEntry, envDisablesRedaction } from '../format/redact.js';
import { packHeadersArray } from '../format/headers.js';

const STATIC_EXT = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.woff', '.woff2', '.ttf', '.ico', '.map', '.less',
]);

/**
 * Common two-level public suffixes where the registrable domain needs three
 * labels instead of two (e.g. "example.co.uk", not "co.uk"). This is a
 * pragmatic heuristic, not a full Public Suffix List implementation — it
 * covers the common cases without pulling in a PSL dependency. Widen this
 * list (or use MOCKIFY_CAPTURE_HOST_FILTER, see below) if a target domain
 * isn't matched correctly.
 */
const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'gov.au',
  'co.nz', 'co.jp', 'co.in', 'co.za', 'co.kr',
  'com.br', 'com.mx', 'com.cn', 'com.sg', 'com.hk',
]);

/**
 * Reduce a hostname to its registrable domain (a.k.a. "eTLD+1"), e.g.
 * "api.example.com" -> "example.com" and "www.example.co.uk" -> "example.co.uk".
 * IP addresses and single-label hosts (localhost, etc.) are returned as-is.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase();
  // Leave IPv4/IPv6-ish and single-label hosts (e.g. "localhost") untouched.
  if (/^[\d.]+$/.test(host) || !host.includes('.')) return host;

  const labels = host.split('.');
  if (labels.length < 2) return host;

  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Decide whether a request/response pair should be recorded as traffic.
 *
 * Host matching is by *registrable domain*, not substring/hostname equality:
 * a target page loaded from "www.example.com" also captures calls to
 * "api.example.com" or "cdn.example.com", since they share the registrable
 * domain "example.com". This matters for evidence soundness — a naive
 * `hostname.includes(hostFilter)` check silently drops same-site,
 * different-subdomain API traffic, which makes any predicate over "no
 * request occurred" unsound (the request happened, it just wasn't captured).
 *
 * For targets that call genuinely cross-origin APIs (a different
 * registrable domain, e.g. a first-party app calling a third-party payments
 * API), set MOCKIFY_CAPTURE_HOST_FILTER to a comma-separated list of
 * additional registrable domains (or hostnames) to widen the filter, or set
 * it to "*" to disable host filtering entirely and capture all traffic.
 *
 * Static assets (STATIC_EXT) are always filtered out regardless of host,
 * since they're not meaningful evidence for functional verification.
 */
export function shouldCapture(url: string, hostFilter: string): boolean {
  try {
    const u = new URL(url);

    if (hostFilter) {
      const extra = (process.env.MOCKIFY_CAPTURE_HOST_FILTER ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);

      if (!extra.includes('*')) {
        const targetDomain = registrableDomain(hostFilter);
        const requestDomain = registrableDomain(u.hostname);
        const matchesTarget = requestDomain === targetDomain;
        const matchesExtra = extra.some(
          (h) => requestDomain === registrableDomain(h) || u.hostname.toLowerCase() === h,
        );
        if (!matchesTarget && !matchesExtra) return false;
      }
    }

    const ext = path.extname(u.pathname).toLowerCase();
    return !STATIC_EXT.has(ext);
  } catch {
    return false;
  }
}

function slugify(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname
      .replace(/^\//, '')
      .replace(/[/?&#=.]/g, '_')
      .replace(/_+/g, '_')
      .replace(/_$/, '')
      .substring(0, 80) || 'page';
  } catch {
    return 'page';
  }
}

export interface CaptureCollectorOptions {
  outputDir: string;
  targetUrl: string;
  hostFilter?: string;
  /**
   * Whether to redact credential-bearing body fields (and header values,
   * where headers are captured) before an entry ever lands in `this.traffic`
   * — see src/format/redact.ts. Defaults to `true` unless overridden by the
   * MOCKIFY_NO_REDACT env var (the `--no-redact` CLI flag sets that env var
   * rather than passing this option directly, since the agent-driven
   * capture path constructs its CaptureCollector inside runner.ts without
   * exposing this field). Pass `false` explicitly to opt a specific caller
   * out regardless of the env var (used by tests).
   */
  redact?: boolean;
}

export class CaptureCollector {
  private traffic: CapturedTraffic[] = [];
  private consoleLogs: CapturedConsoleEntry[] = [];
  private screenshotCount = 0;
  private outputDir: string;
  private screenshotDir: string;
  private targetUrl: string;
  private hostFilter: string;
  private startTime: string;
  private redact: boolean;

  constructor(options: CaptureCollectorOptions) {
    this.outputDir = path.resolve(options.outputDir);
    this.screenshotDir = path.join(this.outputDir, 'screenshots');
    this.targetUrl = options.targetUrl;
    this.hostFilter = options.hostFilter ?? '';
    this.startTime = new Date().toISOString();
    this.redact = options.redact ?? !envDisablesRedaction();

    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  /** Attach traffic interception to a browser context. */
  async attachToContext(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method();
      const tsStart = Date.now();

      const response = await route.fetch().catch(() => null);
      if (!response) {
        await route.continue().catch(() => {});
        return;
      }

      await route.fulfill({ response }).catch(() => {});

      if (shouldCapture(url, this.hostFilter)) {
        const tsEnd = Date.now();

        // request.allHeaders() (unlike the sync request.headers()) is the
        // one that includes Cookie and other security-related headers —
        // see the Playwright doc comment on Request#headers(). It's async,
        // but we're already in an async route handler. response.headersArray()
        // (sync — this `response` is the APIResponse route.fetch() returned)
        // is used instead of response.headers() specifically so a repeated
        // header (Set-Cookie) doesn't get silently folded/dropped before
        // packHeadersArray gets a chance to pack it properly.
        const requestHeaders = await request.allHeaders().catch(() => ({}));
        const responseHeaders = packHeadersArray(response.headersArray());

        const entry: CapturedTraffic = {
          url,
          method,
          postData: request.postData() ?? null,
          status: response.status(),
          contentType: responseHeaders['content-type'] ?? '',
          ts: tsEnd,
          tsStart,
          tsEnd,
          responseBody: null,
          requestHeaders,
          responseHeaders,
        };

        const ct = (entry.contentType ?? '').toLowerCase();
        if (ct.includes('json') || ct.includes('text')) {
          try {
            const body = await response.text();
            if (body.length < 2 * 1024 * 1024) {
              entry.responseBody = body;
            }
          } catch {
            // ignore
          }
        }

        this.traffic.push(this.redact ? redactTrafficEntry(entry) : entry);
      }
    });
  }

  /** Attach console log capture to a page. */
  attachToPage(page: Page): void {
    page.on('console', (msg) => {
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        ts: Date.now(),
      });
    });
  }

  /** Take a named screenshot. Returns the file path. */
  async screenshot(page: Page, name?: string): Promise<string> {
    const idx = String(this.screenshotCount + 1).padStart(3, '0');
    const slug = name ? name.replace(/[^a-z0-9_-]/gi, '_').substring(0, 60) : slugify(page.url());
    const filename = `${idx}-${slug}.png`;
    const filepath = path.join(this.screenshotDir, filename);

    try {
      await page.screenshot({ path: filepath, fullPage: true });
      this.screenshotCount++;
    } catch {
      // ignore screenshot failures
    }

    return filepath;
  }

  /** Record traffic entries manually (e.g. from hook calls). Redacted the
   * same way as intercepted traffic — see the constructor's `redact` option. */
  addTraffic(entry: CapturedTraffic): void {
    this.traffic.push(this.redact ? redactTrafficEntry(entry) : entry);
  }

  /** Record console log entries manually (e.g. from resumed sessions). */
  addConsoleLog(entry: CapturedConsoleEntry): void {
    this.consoleLogs.push(entry);
  }

  /** Get all collected traffic. */
  getTraffic(): CapturedTraffic[] {
    return this.traffic;
  }

  /** Get all collected console logs. */
  getConsoleLogs(): CapturedConsoleEntry[] {
    return this.consoleLogs;
  }

  /** Save all capture data to disk and return the manifest. */
  save(): CaptureManifest {
    // Write traffic.json
    const trafficPath = path.join(this.outputDir, 'traffic.json');
    fs.writeFileSync(trafficPath, JSON.stringify(this.traffic, null, 2), 'utf-8');

    // Write console.json
    const consolePath = path.join(this.outputDir, 'console.json');
    fs.writeFileSync(consolePath, JSON.stringify(this.consoleLogs, null, 2), 'utf-8');

    // Enumerate screenshot files
    const screenshotFiles = fs.existsSync(this.screenshotDir)
      ? fs.readdirSync(this.screenshotDir)
          .filter((f) => f.endsWith('.png'))
          .sort()
          .map((f) => path.join('screenshots', f))
      : [];

    // Write summary.txt
    const endpointMap = new Map<string, { method: string; url: string; status: number | string; count: number }>();
    for (const req of this.traffic) {
      let pattern: string;
      try {
        const u = new URL(req.url);
        pattern = `${u.origin}${u.pathname}`;
      } catch {
        pattern = req.url;
      }
      const key = `${req.method}::${pattern}::${req.status ?? '?'}`;
      const existing = endpointMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        endpointMap.set(key, { method: req.method, url: pattern, status: req.status ?? '?', count: 1 });
      }
    }

    const sorted = [...endpointMap.values()].sort((a, b) => b.count - a.count);
    const summaryLines = [
      `Capture: ${this.startTime}`,
      `Target: ${this.targetUrl}`,
      `Total requests: ${this.traffic.length}`,
      `Unique endpoints: ${sorted.length}`,
      `Screenshots: ${this.screenshotCount}`,
      `Console logs: ${this.consoleLogs.length}`,
      '',
      ...sorted.map((s) => `${s.method.padEnd(7)} ${String(s.status).padEnd(7)} ${s.url}`),
    ];
    fs.writeFileSync(path.join(this.outputDir, 'summary.txt'), summaryLines.join('\n') + '\n', 'utf-8');

    // Build and write manifest
    const manifest: CaptureManifest = {
      session: {
        timestamp: this.startTime,
        targetUrl: this.targetUrl,
        hostFilter: this.hostFilter,
        outputDir: this.outputDir,
        totalRequests: this.traffic.length,
        totalScreenshots: this.screenshotCount,
        pagesVisited: new Set(this.traffic.filter((t) => t.method === 'GET').map((t) => {
          try { return new URL(t.url).pathname; } catch { return t.url; }
        })).size,
        consoleLogCount: this.consoleLogs.length,
      },
      redaction: this.redact,
      formatVersion: CURRENT_CAPTURE_FORMAT_VERSION,
      trafficFile: 'traffic.json',
      consoleFile: 'console.json',
      screenshotFiles,
      summaryFile: 'summary.txt',
      ...(fs.existsSync(path.join(this.outputDir, 'observations.json'))
        ? { observationsFile: 'observations.json' }
        : {}),
    };

    fs.writeFileSync(path.join(this.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    return manifest;
  }
}
