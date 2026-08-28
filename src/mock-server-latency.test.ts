/**
 * src/mock-server-latency.test.ts — HTTP-level latency replay (SP-lsc.10)
 *
 * Exercises `mockify serve --latency/--speed/--no-latency` as a real
 * subprocess (spawnMockServer, src/test-helpers/spawn-mock-server.ts) so CLI
 * flag parsing is covered end to end, not just the pure math in
 * latency.test.ts. Timings use a deliberately small but well-separated
 * fixture duration (120ms) — small enough to keep the suite fast, large
 * enough that "delayed" vs. "instant" is never ambiguous against normal
 * scheduling jitter on a loaded CI runner.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CapturedTraffic } from './format/types.js';
import { generateSynthetic } from './synthesize/generate.js';
import { spawnMockServer } from './test-helpers/spawn-mock-server.js';

function trafficEntry(overrides: Partial<CapturedTraffic>): CapturedTraffic {
  return {
    url: 'https://example.com/api/widgets/1',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json; charset=utf-8',
    ts: 1000,
    responseBody: '{}',
    ...overrides,
  };
}

// Recorded durations, in ms: widgets/1=40, widgets/2=80, widgets/3=120 →
// median 80. Well clear of both a "near-instant" band (<50ms) and each
// other, so a test asserting "used the exact entry" vs. "used the template
// median" can't pass by accident.
const ENTRIES: CapturedTraffic[] = [
  trafficEntry({ url: 'https://example.com/api/widgets/1', tsStart: 1_000, tsEnd: 1_040, responseBody: '{"id":1}' }),
  trafficEntry({ url: 'https://example.com/api/widgets/2', tsStart: 2_000, tsEnd: 2_080, responseBody: '{"id":2}' }),
  trafficEntry({ url: 'https://example.com/api/widgets/3', tsStart: 3_000, tsEnd: 3_120, responseBody: '{"id":3}' }),
  // No tsStart/tsEnd at all — a pre-SP-lsc.8-style capture, or hand-edited
  // fixture data. Must never delay, even with latency replay enabled.
  trafficEntry({ url: 'https://example.com/api/no-timestamps', responseBody: '{"ok":true}' }),
];

function prepareCaptureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-latency-'));
  fs.writeFileSync(path.join(dir, 'traffic.json'), JSON.stringify(ENTRIES, null, 2), 'utf8');
  generateSynthetic(ENTRIES, dir);
  return dir;
}

async function withServer(
  captureDir: string,
  args: string[],
  fn: (port: number) => Promise<void>
): Promise<void> {
  const { child, port } = await spawnMockServer({ MOCK_DATA_PATH: captureDir }, { args });
  try {
    await fn(port);
  } finally {
    child.kill();
  }
}

async function timeFetch(port: number, urlPath: string): Promise<number> {
  const start = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  await res.text();
  assert.equal(res.status, 200);
  return Date.now() - start;
}

// ---------------------------------------------------------------------------
// Default behavior: no --latency/--speed flag at all
// ---------------------------------------------------------------------------

test('mock-server latency: no flags → instant responses even though the fixture has real durations (default is opt-in)', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, [], async (port) => {
    const elapsed = await timeFetch(port, '/api/widgets/3'); // 120ms observed duration
    assert.ok(elapsed < 80, `expected a near-instant response by default, took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// --no-latency: explicit disable
// ---------------------------------------------------------------------------

test('mock-server latency: --no-latency → instant responses, same as the default', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, ['--no-latency'], async (port) => {
    const elapsed = await timeFetch(port, '/api/widgets/3');
    assert.ok(elapsed < 80, `expected --no-latency to disable delays entirely, took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// --latency: recorded tier uses the matched entry's own observed duration
// ---------------------------------------------------------------------------

test('mock-server latency: --latency delays a recorded match by its own observed tsStart/tsEnd duration', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, ['--latency'], async (port) => {
    const elapsed = await timeFetch(port, '/api/widgets/1'); // 40ms observed duration
    assert.ok(elapsed >= 30, `expected roughly a 40ms delay, took only ${elapsed}ms`);
    assert.ok(elapsed < 300, `expected the delay to stay close to 40ms, took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// --speed: scaling math, end to end over HTTP
// ---------------------------------------------------------------------------

test('mock-server latency: --speed 2 replays at twice real speed (half the observed delay)', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, ['--speed', '2'], async (port) => {
    const elapsed = await timeFetch(port, '/api/widgets/3'); // 120ms observed → ~60ms at 2x
    assert.ok(elapsed >= 40, `expected roughly a 60ms delay (120ms / 2), took only ${elapsed}ms`);
    assert.ok(elapsed < 110, `expected --speed 2 to clearly beat the unscaled 120ms delay, took ${elapsed}ms`);
  });
});

test('mock-server latency: --speed 0.5 replays at half real speed (double the observed delay)', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, ['--speed', '0.5'], async (port) => {
    const elapsed = await timeFetch(port, '/api/widgets/1'); // 40ms observed → ~80ms at 0.5x
    assert.ok(elapsed >= 65, `expected roughly an 80ms delay (40ms / 0.5), took only ${elapsed}ms`);
  });
});

test('mock-server latency: --speed implies --latency (no need to pass both)', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, ['--speed', '1'], async (port) => {
    const elapsed = await timeFetch(port, '/api/widgets/1');
    assert.ok(elapsed >= 30, `expected --speed alone to enable latency replay, took only ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Missing timestamps → no delay, even with latency enabled
// ---------------------------------------------------------------------------

test('mock-server latency: an entry with no tsStart/tsEnd never delays, even with --latency', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, ['--latency'], async (port) => {
    const elapsed = await timeFetch(port, '/api/no-timestamps');
    assert.ok(elapsed < 80, `expected no delay for an entry without timestamps, took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Synthetic tier: per-template median, distinct from the recorded tier's
// exact-entry duration
// ---------------------------------------------------------------------------

test('mock-server latency: synthetic tier delays by the per-template median duration (not any single entry\'s)', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, ['--latency'], async (port) => {
    // /api/widgets/9 was never recorded — falls through to the synthetic
    // tier's /api/widgets/{p2} template. Durations were 40/80/120ms →
    // median 80ms, not the 40ms of widgets/1 or the 120ms of widgets/3.
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/widgets/9`);
    await res.text();
    const elapsed = Date.now() - start;

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-synthetic'), 'true');
    assert.ok(elapsed >= 60, `expected roughly the 80ms template median, took only ${elapsed}ms`);
    assert.ok(elapsed < 300, `expected the synthetic delay to stay close to the 80ms median, took ${elapsed}ms`);
  });
});

test('mock-server latency: no flags → synthetic tier is also instant', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, [], async (port) => {
    const elapsed = await timeFetch(port, '/api/widgets/9');
    assert.ok(elapsed < 80, `expected the synthetic tier to be instant by default, took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// --no-latency conflicts with --latency/--speed (contradictory flags)
// ---------------------------------------------------------------------------

test('mock-server latency: --no-latency combined with --speed is a usage error, not silently resolved', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const CLI_PATH = path.join(__dirname, 'cli.ts');
  const dir = prepareCaptureDir();
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, 'serve', '--no-latency', '--speed', '2'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MOCK_DATA_PATH: dir },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'expected a non-zero exit for contradictory latency flags');
  assert.match(result.stderr, /--no-latency cannot be combined/);
});
