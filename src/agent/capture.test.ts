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

/** Minimal fake Playwright Route capturing which methods were invoked.
 * `body.postData`/`body.responseBody` let tests exercise the redaction
 * choke point without a real browser. */
function fakeRoute(url: string, method: string, body?: { postData?: string | null; responseBody?: string }) {
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
      postData: () => body?.postData ?? null,
    }),
    fetch: async () => {
      calls.fetch++;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
        text: async () => body?.responseBody ?? '{}',
      };
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

// ---------------------------------------------------------------------------
// Credential redaction (SP-lsc.7) — see also src/format/redact.test.ts for
// the redaction rules themselves. These tests cover the choke point: does
// CaptureCollector actually apply it, on ingest, to everything that ends up
// on disk?
// ---------------------------------------------------------------------------

test('redaction (default on): addTraffic() redacts secret-looking body keys, including nested, before traffic.json is written', () => {
  const dir = tmpOutputDir();
  const collector = new CaptureCollector({ outputDir: dir, targetUrl: 'https://x.test' });
  collector.addTraffic({
    url: 'https://x.test/api/login',
    method: 'POST',
    postData: JSON.stringify({ username: 'alice', password: 'hunter2' }),
    status: 200,
    contentType: 'application/json',
    ts: 1,
    responseBody: JSON.stringify({
      accessToken: 'abc123',
      user: { id: 1, credentials: { apiKey: 'sk-live-xyz' } },
    }),
  });

  collector.save();
  const traffic = JSON.parse(fs.readFileSync(path.join(dir, 'traffic.json'), 'utf8'));

  const postData = JSON.parse(traffic[0].postData);
  assert.equal(postData.username, 'alice');
  assert.equal(postData.password, '[REDACTED]');

  const responseBody = JSON.parse(traffic[0].responseBody);
  assert.equal(responseBody.accessToken, '[REDACTED]');
  assert.equal(responseBody.user.id, 1);
  assert.equal(responseBody.user.credentials.apiKey, '[REDACTED]');
});

test('redaction (default on): getTraffic() also reflects redacted values, since redaction happens at ingest', () => {
  const dir = tmpOutputDir();
  const collector = new CaptureCollector({ outputDir: dir, targetUrl: 'https://x.test' });
  collector.addTraffic({
    url: 'https://x.test/api/widgets',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: 1,
    responseBody: JSON.stringify({ token: 'secret-value' }),
  });

  const traffic = collector.getTraffic();
  assert.equal(JSON.parse(traffic[0].responseBody!).token, '[REDACTED]');
});

test('redact: false (the --no-redact escape hatch) writes raw, unredacted values', () => {
  const dir = tmpOutputDir();
  const collector = new CaptureCollector({ outputDir: dir, targetUrl: 'https://x.test', redact: false });
  collector.addTraffic({
    url: 'https://x.test/api/login',
    method: 'POST',
    postData: JSON.stringify({ password: 'hunter2' }),
    status: 200,
    contentType: 'application/json',
    ts: 1,
    responseBody: JSON.stringify({ accessToken: 'abc123' }),
  });

  collector.save();
  const traffic = JSON.parse(fs.readFileSync(path.join(dir, 'traffic.json'), 'utf8'));
  assert.equal(JSON.parse(traffic[0].postData).password, 'hunter2');
  assert.equal(JSON.parse(traffic[0].responseBody).accessToken, 'abc123');
});

test('MOCKIFY_NO_REDACT=1 disables redaction when no explicit `redact` option is given', () => {
  const orig = process.env.MOCKIFY_NO_REDACT;
  process.env.MOCKIFY_NO_REDACT = '1';
  try {
    const dir = tmpOutputDir();
    const collector = new CaptureCollector({ outputDir: dir, targetUrl: 'https://x.test' });
    collector.addTraffic({
      url: 'https://x.test/api/login',
      method: 'POST',
      postData: JSON.stringify({ password: 'hunter2' }),
      status: 200,
      contentType: 'application/json',
      ts: 1,
      responseBody: null,
    });
    const traffic = collector.getTraffic();
    assert.equal(JSON.parse(traffic[0].postData!).password, 'hunter2');
  } finally {
    if (orig === undefined) delete process.env.MOCKIFY_NO_REDACT;
    else process.env.MOCKIFY_NO_REDACT = orig;
  }
});

test('an explicit `redact: true` option wins over MOCKIFY_NO_REDACT=1', () => {
  const orig = process.env.MOCKIFY_NO_REDACT;
  process.env.MOCKIFY_NO_REDACT = '1';
  try {
    const dir = tmpOutputDir();
    const collector = new CaptureCollector({ outputDir: dir, targetUrl: 'https://x.test', redact: true });
    collector.addTraffic({
      url: 'https://x.test/api/login',
      method: 'POST',
      postData: JSON.stringify({ password: 'hunter2' }),
      status: 200,
      contentType: 'application/json',
      ts: 1,
      responseBody: null,
    });
    const traffic = collector.getTraffic();
    assert.equal(JSON.parse(traffic[0].postData!).password, '[REDACTED]');
  } finally {
    if (orig === undefined) delete process.env.MOCKIFY_NO_REDACT;
    else process.env.MOCKIFY_NO_REDACT = orig;
  }
});

test('manifest.json records redaction: true by default and redaction: false with the escape hatch', () => {
  const dirOn = tmpOutputDir();
  const onCollector = new CaptureCollector({ outputDir: dirOn, targetUrl: 'https://x.test' });
  const onManifest = onCollector.save();
  assert.equal(onManifest.redaction, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirOn, 'manifest.json'), 'utf8')).redaction, true);

  const dirOff = tmpOutputDir();
  const offCollector = new CaptureCollector({ outputDir: dirOff, targetUrl: 'https://x.test', redact: false });
  const offManifest = offCollector.save();
  assert.equal(offManifest.redaction, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirOff, 'manifest.json'), 'utf8')).redaction, false);
});

test('redaction also applies to entries recorded via attachToContext()\'s route interception, not just addTraffic()', async () => {
  const dir = tmpOutputDir();
  const collector = new CaptureCollector({ outputDir: dir, targetUrl: 'https://x.test', hostFilter: 'x.test' });
  const { context, getHandler } = fakeContext();
  await collector.attachToContext(context as never);

  const { route } = fakeRoute('https://x.test/api/login', 'POST', {
    postData: JSON.stringify({ password: 'hunter2' }),
    responseBody: JSON.stringify({ token: 'abc123' }),
  });
  await getHandler()(route);

  const traffic = collector.getTraffic();
  assert.equal(traffic.length, 1);
  assert.equal(JSON.parse(traffic[0].postData!).password, '[REDACTED]');
  assert.equal(JSON.parse(traffic[0].responseBody!).token, '[REDACTED]');
});
