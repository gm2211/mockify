/**
 * src/compare/ab.test.ts — `mockify compare --capture --remote --local` as
 * a real CLI subprocess (SP-7ow.3), plus unit coverage of compareAB()
 * itself. Mirrors src/replay/against.test.ts's pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareAB } from './ab.js';
import type { CapturedTraffic } from '../format/types.js';

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
// Unit: compareAB()
// ---------------------------------------------------------------------------

async function withTestServers(
  remoteHandler: http.RequestListener,
  localHandler: http.RequestListener,
  run: (remoteUrl: string, localUrl: string) => Promise<void>,
): Promise<void> {
  const remote = http.createServer(remoteHandler);
  const local = http.createServer(localHandler);
  await Promise.all([
    new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve)),
  ]);
  const remotePort = (remote.address() as AddressInfo).port;
  const localPort = (local.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${remotePort}`, `http://127.0.0.1:${localPort}`);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => remote.close(() => resolve())),
      new Promise<void>((resolve) => local.close(() => resolve())),
    ]);
  }
}

function jsonResponder(body: string, status = 200): http.RequestListener {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
}

test('compareAB: identical remote/local responses match', async () => {
  await withTestServers(jsonResponder('{"id":1,"label":"widget"}'), jsonResponder('{"id":2,"label":"widget"}'), async (remoteUrl, localUrl) => {
    // ids differ (volatile field, tolerated), labels agree.
    const summary = await compareAB([entry()], remoteUrl, localUrl);
    assert.equal(summary.total, 1);
    assert.equal(summary.matched, 1);
    assert.equal(summary.mismatched, 0);
  });
});

test('compareAB: a value difference between remote and local is a mismatch', async () => {
  await withTestServers(jsonResponder('{"id":1,"label":"widget"}'), jsonResponder('{"id":1,"label":"gadget"}'), async (remoteUrl, localUrl) => {
    const summary = await compareAB([entry()], remoteUrl, localUrl);
    assert.equal(summary.matched, 0);
    assert.equal(summary.mismatched, 1);
    assert.equal(summary.results[0]?.diff.mismatches[0]?.path, '$.label');
  });
});

test('compareAB: a status mismatch between remote and local fails the match', async () => {
  await withTestServers(jsonResponder('{"id":1}', 200), jsonResponder('{"id":1}', 500), async (remoteUrl, localUrl) => {
    const summary = await compareAB([entry()], remoteUrl, localUrl);
    assert.equal(summary.mismatched, 1);
    assert.equal(summary.results[0]?.diff.statusMatch, false);
  });
});

test('compareAB: local target unreachable is errored, not mismatched', async () => {
  await withTestServers(jsonResponder('{"id":1}'), jsonResponder('{"id":1}'), async (remoteUrl) => {
    const summary = await compareAB([entry()], remoteUrl, 'http://127.0.0.1:1', { timeoutMs: 500 });
    assert.equal(summary.matched, 0);
    assert.equal(summary.mismatched, 0);
    assert.equal(summary.errored, 1);
    assert.ok(summary.results[0]?.localError);
    assert.equal(summary.results[0]?.remoteError, undefined);
  });
});

test('compareAB: --remote-auth / --local-auth send Basic auth to the right target', async () => {
  let sawRemoteAuth: string | undefined;
  let sawLocalAuth: string | undefined;
  await withTestServers(
    (req, res) => {
      sawRemoteAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    (req, res) => {
      sawLocalAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    async (remoteUrl, localUrl) => {
      await compareAB([entry()], remoteUrl, localUrl, { remoteAuth: 'alice:secret1', localAuth: 'bob:secret2' });
      assert.equal(sawRemoteAuth, `Basic ${Buffer.from('alice:secret1').toString('base64')}`);
      assert.equal(sawLocalAuth, `Basic ${Buffer.from('bob:secret2').toString('base64')}`);
    },
  );
});

// ---------------------------------------------------------------------------
// CLI: `mockify compare --capture --remote --local`
// ---------------------------------------------------------------------------

/** spawn() + awaiting 'close', not spawnSync — spawnSync would block this
 * process's event loop and starve the local target servers the CLI
 * subprocess needs to reach (see src/replay/against.test.ts's runCliAsync
 * for the full explanation of why this matters here). */
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

function runCliSync(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempCaptureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-compare-cli-'));
  fs.cpSync(FIXTURE_CAPTURE_DIR, dir, { recursive: true });
  return dir;
}

test('CLI: compare exits 0 when remote and local serve identical responses', async () => {
  const dir = tempCaptureDir();
  const fixtureEntries = JSON.parse(fs.readFileSync(path.join(dir, 'traffic.json'), 'utf8')) as CapturedTraffic[];

  const echoHandler: http.RequestListener = (req, res) => {
    const found = fixtureEntries.find((e) => new URL(e.url).pathname === req.url);
    res.writeHead(found?.status ?? 404, { 'content-type': 'application/json' });
    res.end(found?.responseBody ?? '{}');
  };

  await withTestServers(echoHandler, echoHandler, async (remoteUrl, localUrl) => {
    const result = await runCliAsync(['compare', '--capture', dir, '--remote', remoteUrl, '--local', localUrl, '--json']);
    assert.equal(result.status, 0, `expected success, stderr:\n${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.total, fixtureEntries.length);
    assert.equal(summary.matched, fixtureEntries.length);
  });
});

test('CLI: compare exits 1 when local disagrees with remote', async () => {
  const dir = tempCaptureDir();

  await withTestServers(jsonResponder('{"widgets":[{"id":1,"name":"Sprocket"}]}'), jsonResponder('{"widgets":[]}'), async (remoteUrl, localUrl) => {
    const result = await runCliAsync(['compare', '--capture', dir, '--remote', remoteUrl, '--local', localUrl, '--json']);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.mismatched > 0);
  });
});

test('CLI: compare requires --capture, --remote, and --local', () => {
  const result = runCliSync(['compare', '--remote', 'http://localhost:1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--capture, --remote, and --local are all required/);
});

test('CLI: compare rejects an invalid --local URL', () => {
  const dir = tempCaptureDir();
  const result = runCliSync(['compare', '--capture', dir, '--remote', 'http://localhost:1', '--local', 'not-a-url']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--local must be a valid URL/);
});

test('CLI: compare errors on an unknown --capture name/path', () => {
  const result = runCliSync(['compare', '--capture', '/no/such/dir', '--remote', 'http://localhost:1', '--local', 'http://localhost:2']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not find a capture/);
});
