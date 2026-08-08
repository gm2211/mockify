import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { shouldCapture, registrableDomain, CaptureCollector } from './capture.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('registrableDomain: strips subdomains down to the registrable domain', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('api.example.com'), 'example.com');
  assert.equal(registrableDomain('deep.nested.api.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('registrableDomain: handles common two-level public suffixes', () => {
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('api.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com.au'), 'example.com.au');
});

test('registrableDomain: leaves IPs and single-label hosts untouched', () => {
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
});

test('shouldCapture: same registrable domain across subdomains is captured (fixes SP-l39)', () => {
  // Page hostname is www.example.com; API calls go to api.example.com.
  // With naive `hostname.includes(hostFilter)` matching this produced zero
  // captured entries for the API host, making evidence-based verdicts unsound.
  const hostFilter = 'www.example.com';
  assert.equal(shouldCapture('https://api.example.com/v1/orders', hostFilter), true);
  assert.equal(shouldCapture('https://cdn.example.com/v1/assets.json', hostFilter), true);
  assert.equal(shouldCapture('https://www.example.com/api/orders', hostFilter), true);
});

test('shouldCapture: rejects genuinely cross-origin hosts by default', () => {
  const hostFilter = 'www.example.com';
  assert.equal(shouldCapture('https://tracker.other-domain.com/pixel', hostFilter), false);
});

test('shouldCapture: MOCKIFY_CAPTURE_HOST_FILTER widens the filter to extra domains', () => {
  const orig = process.env.MOCKIFY_CAPTURE_HOST_FILTER;
  process.env.MOCKIFY_CAPTURE_HOST_FILTER = 'payments.example';
  try {
    assert.equal(
      shouldCapture('https://api.payments.example/charge', 'www.example.com'),
      true,
    );
  } finally {
    if (orig === undefined) delete process.env.MOCKIFY_CAPTURE_HOST_FILTER;
    else process.env.MOCKIFY_CAPTURE_HOST_FILTER = orig;
  }
});

test('shouldCapture: MOCKIFY_CAPTURE_HOST_FILTER="*" disables host filtering', () => {
  const orig = process.env.MOCKIFY_CAPTURE_HOST_FILTER;
  process.env.MOCKIFY_CAPTURE_HOST_FILTER = '*';
  try {
    assert.equal(
      shouldCapture('https://totally-unrelated.io/anything', 'www.example.com'),
      true,
    );
  } finally {
    if (orig === undefined) delete process.env.MOCKIFY_CAPTURE_HOST_FILTER;
    else process.env.MOCKIFY_CAPTURE_HOST_FILTER = orig;
  }
});

test('shouldCapture: still filters static assets regardless of host', () => {
  assert.equal(shouldCapture('https://api.example.com/app.js', 'www.example.com'), false);
  assert.equal(shouldCapture('https://api.example.com/logo.png', 'www.example.com'), false);
});

test('shouldCapture: no hostFilter captures everything but static assets', () => {
  assert.equal(shouldCapture('https://anywhere.example/data.json', ''), true);
  assert.equal(shouldCapture('https://anywhere.example/style.css', ''), false);
});

function tmpOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-capture-'));
}

/** Minimal fake Playwright Route capturing which methods were invoked. */
function fakeRoute(url: string, method: string) {
  const calls: { fetch: number; fulfill: unknown[]; abort: unknown[]; continue: number } = {
    fetch: 0,
    fulfill: [],
    abort: [],
    continue: 0,
  };
  const route = {
    request: () => ({
      url: () => url,
      method: () => method,
      postData: () => null,
    }),
    fetch: async () => {
      calls.fetch++;
      return { status: () => 200, headers: () => ({ 'content-type': 'application/json' }), text: async () => '{}' };
    },
    fulfill: async (opts: unknown) => {
      calls.fulfill.push(opts);
    },
    abort: async (reason?: unknown) => {
      calls.abort.push(reason);
    },
    continue: async () => {
      calls.continue++;
    },
  };
  return { route, calls };
}

/** Fake BrowserContext that captures the route handler registered via context.route(). */
function fakeContext() {
  let handler: ((route: unknown) => Promise<void>) | undefined;
  const context = {
    route: async (_pattern: string, h: (route: unknown) => Promise<void>) => {
      handler = h;
    },
  };
  return { context, getHandler: () => handler! };
}

test('non-matching-host request is still fetched normally and captured', async () => {
  const collector = new CaptureCollector({ outputDir: tmpOutputDir(), targetUrl: 'https://x.test' });
  const { context, getHandler } = fakeContext();
  await collector.attachToContext(context as never);

  const { route, calls } = fakeRoute('https://x.test/api/orders', 'GET');
  await getHandler()(route);

  assert.equal(calls.fetch, 1);
  const traffic = collector.getTraffic();
  assert.equal(traffic.length, 1);
  assert.equal(traffic[0].status, 200);
  assert.equal(traffic[0].injectedFault, undefined);
});

test('save() writes traffic.json, console.json, summary.txt, and manifest.json', () => {
  const dir = tmpOutputDir();
  const collector = new CaptureCollector({ outputDir: dir, targetUrl: 'https://x.test', hostFilter: 'x.test' });
  collector.addTraffic({
    url: 'https://x.test/api/widgets',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: 1,
    responseBody: '{}',
  });
  collector.addConsoleLog({ type: 'log', text: 'hello', ts: 1 });

  const manifest = collector.save();

  assert.ok(fs.existsSync(path.join(dir, 'traffic.json')));
  assert.ok(fs.existsSync(path.join(dir, 'console.json')));
  assert.ok(fs.existsSync(path.join(dir, 'summary.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));

  assert.equal(manifest.session.totalRequests, 1);
  assert.equal(manifest.session.consoleLogCount, 1);
  assert.equal(manifest.trafficFile, 'traffic.json');
  assert.equal(manifest.consoleFile, 'console.json');
});
