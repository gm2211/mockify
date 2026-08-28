/**
 * src/replay/against.test.ts — `mockify replay <name> --against <url>` as a
 * real CLI subprocess (SP-7ow.2), plus unit coverage of replayAgainst()
 * itself. The CLI-level tests exercise argument handling and exit codes
 * the way a user actually invokes the command, mirroring the pattern in
 * src/openapi/cli-openapi.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replayAgainst } from './against.js';
import type { CapturedTraffic } from '../format/types.js';
import { REDACTED } from '../format/redact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const FIXTURE_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'captures');

function entry(overrides: Partial<CapturedTraffic> = {}): CapturedTraffic {
  return {
    url: 'https://original.example.test/api/widgets/1',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: 0,
    responseBody: '{"id":1,"label":"widget"}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit: replayAgainst()
// ---------------------------------------------------------------------------

async function withTestServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('replayAgainst: all entries matching yields a clean summary', async () => {
  await withTestServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":1,"label":"widget"}');
    },
    async (baseUrl) => {
      const summary = await replayAgainst([entry()], baseUrl);
      assert.equal(summary.total, 1);
      assert.equal(summary.matched, 1);
      assert.equal(summary.mismatched, 0);
      assert.equal(summary.errored, 0);
      assert.equal(summary.results[0]?.diff.match, true);
    },
  );
});

test('replayAgainst: a value mismatch is counted as mismatched, not errored', async () => {
  await withTestServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":1,"label":"totally different"}');
    },
    async (baseUrl) => {
      const summary = await replayAgainst([entry()], baseUrl);
      assert.equal(summary.matched, 0);
      assert.equal(summary.mismatched, 1);
      assert.equal(summary.errored, 0);
    },
  );
});

test('replayAgainst: a request that fails to fire (nothing listening) is errored, not mismatched', async () => {
  // Port 1 is reserved and nothing will ever be listening there.
  const summary = await replayAgainst([entry()], 'http://127.0.0.1:1', { timeoutMs: 500 });
  assert.equal(summary.matched, 0);
  assert.equal(summary.mismatched, 0);
  assert.equal(summary.errored, 1);
  assert.ok(summary.results[0]?.error);
});

test('replayAgainst: a redacted recorded field never counts against the match', async () => {
  await withTestServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":1,"token":"live-secret-value"}');
    },
    async (baseUrl) => {
      const summary = await replayAgainst([entry({ responseBody: `{"id":1,"token":"${REDACTED}"}` })], baseUrl);
      assert.equal(summary.matched, 1);
      assert.ok(summary.results[0]?.diff.ignoredFields.includes('$.token'));
    },
  );
});

test('replayAgainst: multiple entries are fired in order and each graded independently', async () => {
  let calls = 0;
  await withTestServer(
    (req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(calls === 1 ? '{"id":1}' : '{"id":2,"wrong":true}');
    },
    async (baseUrl) => {
      const summary = await replayAgainst(
        [entry({ url: 'https://original.example.test/a', responseBody: '{"id":1}' }), entry({ url: 'https://original.example.test/b', responseBody: '{"id":2}' })],
        baseUrl,
      );
      assert.equal(summary.total, 2);
      assert.equal(summary.matched, 1);
      assert.equal(summary.mismatched, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// CLI: `mockify replay <path> --against <url>`
// ---------------------------------------------------------------------------

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Async variant of runCli(), required whenever the CLI subprocess needs to
 * talk to an HTTP server running in *this* test process (e.g. the
 * withTestServer target below): spawnSync blocks this process's event loop
 * for its entire duration, which would starve the very http.createServer
 * the child is trying to reach and make every request hang until timeout.
 * spawn() + awaiting 'close' keeps the event loop free to service it. */
function runCliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function tempCaptureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-replay-against-cli-'));
  fs.cpSync(FIXTURE_CAPTURE_DIR, dir, { recursive: true });
  return dir;
}

test('CLI: replay --against exits 0 and reports "matched" when the target echoes recorded responses', async () => {
  const dir = tempCaptureDir();
  const fixtureEntries = JSON.parse(fs.readFileSync(path.join(dir, 'traffic.json'), 'utf8')) as CapturedTraffic[];

  await withTestServer(
    (req, res) => {
      const found = fixtureEntries.find((e) => {
        const u = new URL(e.url);
        return u.pathname === req.url;
      });
      res.writeHead(found?.status ?? 404, { 'content-type': 'application/json' });
      res.end(found?.responseBody ?? '{}');
    },
    async (baseUrl) => {
      const result = await runCliAsync(['replay', dir, '--against', baseUrl, '--json']);
      assert.equal(result.status, 0, `expected success, stderr:\n${result.stderr}`);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.total, fixtureEntries.length);
      assert.equal(summary.matched, fixtureEntries.length);
      assert.equal(summary.mismatched, 0);
    },
  );
});

test('CLI: replay --against exits 1 when the target disagrees with the capture', async () => {
  const dir = tempCaptureDir();

  await withTestServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"totally":"different"}');
    },
    async (baseUrl) => {
      const result = await runCliAsync(['replay', dir, '--against', baseUrl, '--json']);
      assert.equal(result.status, 1);
      const summary = JSON.parse(result.stdout);
      assert.ok(summary.mismatched > 0);
    },
  );
});

test('CLI: replay --against rejects a missing --against value gracefully', () => {
  const dir = tempCaptureDir();
  const result = runCli(['replay', dir, '--against']);
  assert.notEqual(result.status, 0);
});

test('CLI: replay --against rejects an invalid --against URL', () => {
  const dir = tempCaptureDir();
  const result = runCli(['replay', dir, '--against', 'not-a-url']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid URL/);
});

test('CLI: replay --against errors on an unknown capture name/path', () => {
  const result = runCli(['replay', '/no/such/capture/dir', '--against', 'http://127.0.0.1:1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not find a capture/);
});
