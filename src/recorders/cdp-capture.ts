/**
 * scripts/cdp-capture.ts — Passive CDP traffic capture from existing Chrome
 *
 * What it does:
 *   1. Connects to a Chrome instance already running with remote debugging enabled
 *   2. Passively listens to all network traffic via Chrome DevTools Protocol
 *   3. Captures request/response pairs matching your host filter
 *   4. On Ctrl+C: saves captured traffic to a timestamped JSON file + summary
 *
 * Usage:
 *   npm run capture
 *   npx tsx scripts/cdp-capture.ts
 *
 * You must first launch Chrome with remote debugging:
 *   /Applications/Google Chrome.app/Contents/MacOS/Google\ Chrome \
 *     --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/chrome-debug
 *
 * Configuration (via .env or environment variables):
 *   CDP_HOST             — Chrome DevTools host (default: localhost)
 *   CDP_PORT             — Chrome DevTools port (default: 9222)
 *   CAPTURE_HOST_FILTER  — hostname substring to capture traffic for (required)
 *   CDP_MAX_BODY_BYTES   — max response body size in bytes (default: 1048576)
 *   CAPTURE_OUTPUT_DIR   — output directory (default: captures/)
 *
 * Output (in CAPTURE_OUTPUT_DIR/):
 *   traffic-<timestamp>.json          — full capture with response bodies
 *   traffic-<timestamp>-summary.txt   — endpoint summary table
 */

import CDP from 'chrome-remote-interface';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CDP_HOST = process.env.CDP_HOST ?? 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT ?? '9222', 10);
const HOST_FILTER = process.env.CAPTURE_HOST_FILTER ?? '';
const MAX_BODY_BYTES = parseInt(process.env.CDP_MAX_BODY_BYTES ?? String(1024 * 1024), 10);
const OUTPUT_DIR = path.resolve(process.cwd(), process.env.CAPTURE_OUTPUT_DIR ?? 'captures');

if (!HOST_FILTER) {
  console.warn(
    'WARNING: CAPTURE_HOST_FILTER is not set. All network traffic will be captured.\n' +
    '  Set it to a hostname substring to narrow the capture (e.g. CAPTURE_HOST_FILTER=example.com)'
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CapturedRequest {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  contentType?: string;
  timestamp: number;
}

interface PendingRequest {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  timestamp: number;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  contentType?: string;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg',
  '.gif', '.svg', '.woff', '.woff2', '.ttf', '.ico',
]);

function shouldCapture(url: string, resourceType?: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }

  if (HOST_FILTER && !hostname.includes(HOST_FILTER)) {
    return false;
  }

  const pathname = new URL(url).pathname.toLowerCase();
  const ext = path.extname(pathname);
  if (STATIC_EXTENSIONS.has(ext)) {
    return false;
  }

  // Prefer API-like paths but also capture anything without an extension
  const isApiLike =
    pathname.includes('/api/') ||
    resourceType === 'XHR' ||
    resourceType === 'Fetch';

  return isApiLike || ext === '';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  let client: CDP.Client;

  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT });
  } catch {
    console.error(
      `Chrome not found on ${CDP_HOST}:${CDP_PORT}. Launch it with:\n` +
      '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n' +
      `    --remote-debugging-port=${CDP_PORT} \\\n` +
      '    --user-data-dir=/tmp/chrome-debug'
    );
    process.exit(1);
  }

  const { Network } = client;

  await Network.enable({
    maxResourceBufferSize: 100 * 1024 * 1024,  // 100 MB
    maxTotalBufferSize: 500 * 1024 * 1024,     // 500 MB
  });

  console.log(`Connected to Chrome at ${CDP_HOST}:${CDP_PORT}.`);
  console.log(`Host filter: ${HOST_FILTER || '(all hosts)'}`);
  console.log('Browse normally. Press Ctrl+C to stop and save capture.\n');

  const pendingRequests = new Map<string, PendingRequest>();
  const capturedRequests: CapturedRequest[] = [];

  // -------------------------------------------------------------------------
  // Network.requestWillBeSent
  // -------------------------------------------------------------------------
  Network.requestWillBeSent((params) => {
    const { requestId, request, timestamp, type } = params;
    const resourceType = type as string | undefined;

    if (!shouldCapture(request.url, resourceType)) return;

    pendingRequests.set(requestId, {
      url: request.url,
      method: request.method,
      requestHeaders: (request.headers as Record<string, string>) ?? {},
      postData: request.postData ?? undefined,
      timestamp,
    });
  });

  // -------------------------------------------------------------------------
  // Network.responseReceived
  // -------------------------------------------------------------------------
  Network.responseReceived((params) => {
    const { requestId, response } = params;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;

    pending.responseStatus = response.status;
    pending.responseHeaders = (response.headers as Record<string, string>) ?? {};

    const ct = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
    pending.contentType = String(ct);
  });

  // -------------------------------------------------------------------------
  // Network.loadingFinished — fetch body for JSON responses
  // -------------------------------------------------------------------------
  Network.loadingFinished(async (params) => {
    const { requestId, encodedDataLength } = params;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;

    pendingRequests.delete(requestId);

    const captured: CapturedRequest = {
      url: pending.url,
      method: pending.method,
      requestHeaders: pending.requestHeaders,
      postData: pending.postData,
      responseStatus: pending.responseStatus ?? 0,
      responseHeaders: pending.responseHeaders ?? {},
      contentType: pending.contentType,
      timestamp: pending.timestamp,
    };

    const isJson = (pending.contentType ?? '').toLowerCase().includes('json');
    if (isJson && encodedDataLength <= MAX_BODY_BYTES) {
      try {
        const bodyResult = await Network.getResponseBody({ requestId });
        if (bodyResult.body) {
          captured.responseBody = bodyResult.base64Encoded
            ? Buffer.from(bodyResult.body, 'base64').toString('utf-8')
            : bodyResult.body;
        }
      } catch {
        // Body may not be available for redirects or errors
      }
    }

    capturedRequests.push(captured);
    const shortUrl = captured.url.length > 80
      ? captured.url.substring(0, 80) + '...'
      : captured.url;
    console.log(`  [${captured.method}] ${captured.responseStatus} ${shortUrl}`);
  });

  // -------------------------------------------------------------------------
  // CDP disconnect
  // -------------------------------------------------------------------------
  client.on('disconnect', () => {
    console.warn('\nChrome disconnected. Saving captured data...');
    saveAndExit(capturedRequests);
  });

  // -------------------------------------------------------------------------
  // Ctrl+C
  // -------------------------------------------------------------------------
  process.on('SIGINT', () => {
    console.log('\nCapture stopped. Saving...');
    saveAndExit(capturedRequests);
  });
}

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------
function saveAndExit(capturedRequests: CapturedRequest[]): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  const jsonFile = path.join(OUTPUT_DIR, `traffic-${timestamp}.json`);
  const summaryFile = path.join(OUTPUT_DIR, `traffic-${timestamp}-summary.txt`);

  fs.writeFileSync(jsonFile, JSON.stringify(capturedRequests, null, 2), 'utf-8');
  console.log(`\nFull capture saved to: ${jsonFile}`);

  const summary = buildSummary(capturedRequests);
  fs.writeFileSync(summaryFile, summary, 'utf-8');
  console.log(`Summary saved to:       ${summaryFile}`);
  console.log('\n--- SUMMARY ---\n');
  console.log(summary);

  process.exit(0);
}

interface EndpointStats {
  method: string;
  urlPattern: string;
  status: number;
  contentType: string;
  count: number;
}

function buildSummary(requests: CapturedRequest[]): string {
  if (requests.length === 0) {
    return 'No requests captured.\n';
  }

  const map = new Map<string, EndpointStats>();

  for (const req of requests) {
    let urlPattern: string;
    try {
      const u = new URL(req.url);
      urlPattern = `${u.origin}${u.pathname}`;
    } catch {
      urlPattern = req.url;
    }

    const key = `${req.method}::${urlPattern}::${req.responseStatus}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, {
        method: req.method,
        urlPattern,
        status: req.responseStatus,
        contentType: req.contentType ?? '',
        count: 1,
      });
    }
  }

  const sorted = Array.from(map.values()).sort((a, b) => b.count - a.count);

  const lines: string[] = [
    `Capture summary — ${requests.length} total requests, ${sorted.length} unique endpoints`,
    '='.repeat(80),
    '',
    `${'COUNT'.padEnd(7)} ${'METHOD'.padEnd(8)} ${'STATUS'.padEnd(7)} ${'CONTENT-TYPE'.padEnd(30)} URL`,
    '-'.repeat(80),
  ];

  for (const stat of sorted) {
    const ct = stat.contentType.split(';')[0].trim().padEnd(30);
    lines.push(
      `${String(stat.count).padEnd(7)} ${stat.method.padEnd(8)} ${String(stat.status).padEnd(7)} ${ct} ${stat.urlPattern}`
    );
  }

  return lines.join('\n') + '\n';
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
