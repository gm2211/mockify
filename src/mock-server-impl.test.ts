/**
 * src/mock-server-impl.test.ts — the implementation tier (SP-qd4 phase 3)
 *
 * Exercises the four-tier response pipeline in src/mock-server.ts:
 * implementation → recorded → synthetic → 404. Most tests drive
 * startMockServer() in-process (see mock-server-start.test.ts) since
 * --mode/--impl are plain JS options there; the two tests that depend on an
 * environment variable (MOCKIFY_IMPL_TIMEOUT_MS, read once at module load)
 * or on the CLI's own banner text spawn the `replay` subcommand as a
 * subprocess instead (see mock-server-synthetic.test.ts for the same
 * pattern).
 *
 * test/fixtures/impl-capture/traffic.json records two routes:
 *   - GET /api/items — also handled by test/fixtures/impl/good.mjs, with a
 *     recorded body deliberately different from what good.mjs would compute
 *     for the same path, so "does the implementation now win over a
 *     recorded response for the same route" has something real to
 *     distinguish.
 *   - GET /api/legacy-report — NOT handled by good.mjs, so it proves the
 *     recorded tier still backs up whatever the implementation declines.
 * Every other /api/items* request is unrecorded, leaving good.mjs's real
 * routing + in-memory store (seeded with ids 1-5) as the only thing that
 * can answer it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import type * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';
import { generateSynthetic } from './synthesize/generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');

const IMPL_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'impl-capture');
const SYNTHETIC_CAPTURE_TRAFFIC = path.join(REPO_ROOT, 'test', 'fixtures', 'synthetic-captures', 'traffic.json');
const GOOD_IMPL = path.join(REPO_ROOT, 'test', 'fixtures', 'impl', 'good.mjs');
const THROWING_IMPL = path.join(REPO_ROOT, 'test', 'fixtures', 'impl', 'throwing.mjs');
const HANGING_IMPL = path.join(REPO_ROOT, 'test', 'fixtures', 'impl', 'hanging.mjs');

/** `started.port` is `opts.port ?? DEFAULT_PORT` — with `port: 0` (ask the OS
 * for any free port) that stays 0, not the port actually bound (see
 * mock-server-start.test.ts, which reads `server.address()` for the same
 * reason). Read the real bound port here so `port: 0` tests hit a live
 * server instead of literally connecting to port 0. */
function serverUrl(started: { server: http.Server }): string {
  const address = started.server.address();
  if (!address || typeof address === 'string') {
    throw new Error(`expected an AddressInfo, got ${JSON.stringify(address)}`);
  }
  return `http://localhost:${address.port}`;
}

/** Copy the widgets fixture into a fresh temp dir and generate
 * synthetic/index.json into it — same idea as mock-server-synthetic.test.ts's
 * prepareCaptureDir(), duplicated here rather than imported since it's a
 * few lines and each *.test.ts file in this repo owns its own fixture
 * plumbing. */
function prepareSyntheticCaptureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-impl-synth-'));
  const trafficPath = path.join(dir, 'traffic.json');
  fs.copyFileSync(SYNTHETIC_CAPTURE_TRAFFIC, trafficPath);
  const entries = JSON.parse(fs.readFileSync(trafficPath, 'utf8'));
  generateSynthetic(entries, dir);
  return dir;
}

/** A fresh capture dir with impl-capture's traffic.json, a copy of an
 * implementation at <dir>/impl/handlers.mjs, and (optionally) a report.json
 * next to it — for exercising GET /_impl and the replay banner's quality
 * summary without touching the checked-in fixtures directory. */
function prepareImplCaptureDir(implSourcePath: string, report?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-impl-report-'));
  fs.copyFileSync(path.join(IMPL_CAPTURE_DIR, 'traffic.json'), path.join(dir, 'traffic.json'));
  const implDir = path.join(dir, 'impl');
  fs.mkdirSync(implDir, { recursive: true });
  fs.copyFileSync(implSourcePath, path.join(implDir, 'handlers.mjs'));
  if (report !== undefined) {
    fs.writeFileSync(path.join(implDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  }
  return dir;
}

function waitForOutput(child: ReturnType<typeof spawn>, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for /${pattern.source}/ in server output. Got:\n${buf}`));
    }, timeoutMs);
    const onData = (data: Buffer) => {
      buf += data.toString();
      if (pattern.test(buf)) {
        clearTimeout(timer);
        child.stderr?.off('data', onData);
        resolve(buf);
      }
    };
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function withReplaySubprocess(
  args: string[],
  extraEnv: Record<string, string>,
  fn: (port: number, banner: string) => Promise<void>
): Promise<void> {
  const port = 34567 + Math.floor(Math.random() * 1000);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CLI_PATH, 'replay', ...args, '--port', String(port)],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );

  try {
    const banner = await waitForOutput(child, /→ http:\/\/localhost:/);
    await fn(port, banner);
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// Tier priority + labeling
// ---------------------------------------------------------------------------

test('mock-server impl tier: an implementation loaded answers a route it handles even when a recorded response exists for the same path', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0, implPath: GOOD_IMPL });
  try {
    const res = await fetch(`${serverUrl(started)}/api/items`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-tier'), 'implementation');
    const body = await res.json();
    // good.mjs's seeded body — NOT the recorded fixture's "RECORDED Widget Alpha".
    // The implementation is the only tier that can stay self-consistent
    // across a POST-then-GET sequence, so it must be tried before recorded.
    assert.equal(body[0].name, 'Widget Alpha');
  } finally {
    started.server.close();
  }
});

test('mock-server impl tier: a recorded response backs up a route the implementation declines', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0, implPath: GOOD_IMPL });
  try {
    // good.mjs has no route for /api/legacy-report — it must decline and
    // the recorded entry must answer instead.
    const res = await fetch(`${serverUrl(started)}/api/legacy-report`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-tier'), 'recorded');
    const body = await res.json();
    assert.match(body.note, /back it up/);
  } finally {
    started.server.close();
  }
});

test('mock-server impl tier: REGRESSION — a POST answered by the implementation is reflected by a subsequent GET of a recorded collection route', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0, implPath: GOOD_IMPL });
  try {
    const createRes = await fetch(`${serverUrl(started)}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zeta', description: 'newest prototype' }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.headers.get('x-mockify-tier'), 'implementation');

    // GET /api/items IS recorded (see traffic.json) with a stale body that
    // has nothing to do with this POST. Before this fix, that recorded
    // entry always won here and the mutation could never be observed by a
    // subsequent GET — a replica that can't agree with itself. Now the
    // implementation answers first, so the list reflects the new item.
    const listRes = await fetch(`${serverUrl(started)}/api/items`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get('x-mockify-tier'), 'implementation');
    const list = await listRes.json();
    assert.ok(
      list.some((item: { name: string }) => item.name === 'Zeta'),
      'expected the newly created item to appear in a subsequent GET of the same (recorded) route'
    );
  } finally {
    started.server.close();
  }
});

test('mock-server impl tier: an unrecorded path the implementation handles is labeled implementation, not shadowed by synthesis', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0, implPath: GOOD_IMPL });
  try {
    const res = await fetch(`${serverUrl(started)}/api/items/2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-tier'), 'implementation');
    assert.equal(res.headers.get('x-mockify-synthetic'), null);
    const body = await res.json();
    assert.equal(body.id, 2);
    assert.equal(body.name, 'Widget Beta');
  } finally {
    started.server.close();
  }
});

test('mock-server impl tier: statefulness through the server — POST creates a resource, a later GET returns it', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0, implPath: GOOD_IMPL });
  try {
    const createRes = await fetch(`${serverUrl(started)}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zeta', description: 'newest prototype' }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.headers.get('x-mockify-tier'), 'implementation');
    const created = await createRes.json();
    assert.equal(created.name, 'Zeta');
    assert.ok(created.id > 5, 'created id should be beyond the 5 seeded items');

    const getRes = await fetch(`${serverUrl(started)}/api/items/${created.id}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('x-mockify-tier'), 'implementation');
    const fetched = await getRes.json();
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, 'Zeta');
  } finally {
    started.server.close();
  }
});

// ---------------------------------------------------------------------------
// Safety: throw / decline / hang never take the server down with them
// ---------------------------------------------------------------------------

test('mock-server impl tier: an implementation that throws falls through to 404 instead of 500ing', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0, implPath: THROWING_IMPL });
  try {
    const res = await fetch(`${serverUrl(started)}/api/items/2`);
    assert.equal(res.status, 404);
    assert.notEqual(res.status, 500);
    assert.equal(res.headers.get('x-mockify-tier'), null);
    const body = await res.json();
    assert.equal(body.error, 'No matching route');
  } finally {
    started.server.close();
  }
});

test('mock-server impl tier: an implementation that hangs is abandoned at the timeout and falls through', async () => {
  await withReplaySubprocess(
    [IMPL_CAPTURE_DIR, '--impl', HANGING_IMPL],
    { MOCKIFY_IMPL_TIMEOUT_MS: '150' },
    async (port) => {
      const start = Date.now();
      const res = await fetch(`http://localhost:${port}/api/items/2`);
      const elapsedMs = Date.now() - start;
      assert.equal(res.status, 404);
      // Well under the 2000ms default — proves MOCKIFY_IMPL_TIMEOUT_MS=150 was
      // actually honored, not just that the request eventually completed.
      assert.ok(elapsedMs < 1000, `expected the 150ms override to apply; took ${elapsedMs}ms`);
    }
  );
});

// ---------------------------------------------------------------------------
// --mode
// ---------------------------------------------------------------------------

test('mock-server impl tier: --mode record consults neither the implementation nor synthesis (recorded tier still works)', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0, mode: 'record', implPath: GOOD_IMPL });
  try {
    const recorded = await fetch(`${serverUrl(started)}/api/items`);
    assert.equal(recorded.status, 200);
    assert.equal(recorded.headers.get('x-mockify-tier'), 'recorded');

    // good.mjs would happily answer this — --mode record must never ask it.
    const unrecorded = await fetch(`${serverUrl(started)}/api/items/2`);
    assert.equal(unrecorded.status, 404);
    assert.equal(unrecorded.headers.get('x-mockify-tier'), null);
  } finally {
    started.server.close();
  }
});

test('mock-server impl tier: --mode impl does not consult synthesis (a declining implementation still 404s)', async () => {
  const dir = prepareSyntheticCaptureDir();

  // Sanity check first: in auto mode, good.mjs declines every /api/widgets/*
  // request (it only knows about /api/items), so synthesis still answers.
  const auto = await startMockServer({ dataPath: dir, port: 0, mode: 'auto', implPath: GOOD_IMPL });
  try {
    const res = await fetch(`${serverUrl(auto)}/api/widgets/9`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-tier'), 'synthetic');
  } finally {
    auto.server.close();
  }

  // Same capture, same implementation, --mode impl: the decline is real, but
  // synthesis is off-limits in this mode, so it 404s instead of answering.
  const implOnly = await startMockServer({ dataPath: dir, port: 0, mode: 'impl', implPath: GOOD_IMPL });
  try {
    const res = await fetch(`${serverUrl(implOnly)}/api/widgets/9`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-mockify-tier'), null);
  } finally {
    implOnly.server.close();
  }
});

// ---------------------------------------------------------------------------
// GET /_impl
// ---------------------------------------------------------------------------

test('mock-server impl tier: GET /_impl reports not-loaded when no implementation exists', async () => {
  const started = await startMockServer({ dataPath: IMPL_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/_impl`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.loaded, false);
    assert.equal(body.report, null);
    assert.ok(body.path.endsWith(path.join('impl', 'handlers.mjs')));
  } finally {
    started.server.close();
  }
});

test('mock-server impl tier: GET /_impl reports loaded + the report.json summary when both are present', async () => {
  const gapSummary = {
    gap: { trainRate: 1, holdoutRate: 0.9, gap: 0.1, verdict: 'ok', threshold: 0.25 },
  };
  const dir = prepareImplCaptureDir(GOOD_IMPL, gapSummary);
  const started = await startMockServer({ dataPath: dir, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/_impl`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.loaded, true);
    assert.equal(body.path, path.join(dir, 'impl', 'handlers.mjs'));
    assert.equal(body.report.gap.verdict, 'ok');
  } finally {
    started.server.close();
  }
});

// ---------------------------------------------------------------------------
// CLI banner (mockify replay)
// ---------------------------------------------------------------------------

test('mockify replay: the banner states the active tier chain and the implementation quality summary', async () => {
  const gapSummary = {
    gap: { trainRate: 1, holdoutRate: 0.8, gap: 0.2, verdict: 'ok', threshold: 0.25 },
  };
  const dir = prepareImplCaptureDir(GOOD_IMPL, gapSummary);

  await withReplaySubprocess([dir], {}, async (_port, banner) => {
    assert.match(banner, /tiers: implementation → recorded → synthetic/);
    assert.match(banner, /train 100% \/ holdout 80% pass rate, gap verdict: ok/);
    assert.doesNotMatch(banner, /likely_hardcoded/);
  });
});

test('mockify replay: a likely_hardcoded report.json prints a visible warning in the banner', async () => {
  const gapSummary = {
    gap: { trainRate: 1, holdoutRate: 0.1, gap: 0.9, verdict: 'likely_hardcoded', threshold: 0.25 },
  };
  const dir = prepareImplCaptureDir(GOOD_IMPL, gapSummary);

  await withReplaySubprocess([dir, '--mode', 'impl'], {}, async (_port, banner) => {
    assert.match(banner, /tiers: implementation → recorded/);
    assert.match(banner, /WARNING.*likely_hardcoded/);
  });
});
