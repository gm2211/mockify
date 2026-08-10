/**
 * src/mock-server-start.test.ts — startMockServer() as a programmatic API
 *
 * mock-server.test.ts / mock-server-synthetic.test.ts exercise the server
 * by spawning the CLI as a subprocess (because the module used to self-start
 * as an unconditional side effect of import). Now that startup is exported
 * as `startMockServer()` (src/mock-server.ts), guarded to self-start only
 * when the module is the process entry point, it can be exercised directly
 * in-process too — this is what `mockify replay <name>` (src/cli.ts) calls.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';
import { resolveCapture } from './captures/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'captures');
const POST_MATCH_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'post-match-capture');

/** `started.port` is `opts.port ?? DEFAULT_PORT` — with `port: 0` (ask the OS
 * for any free port) that stays 0, not the port actually bound. Read the
 * real bound port here so `port: 0` tests hit a live server. */
function serverUrl(started: { server: http.Server }): string {
  const address = started.server.address();
  if (!address || typeof address === 'string') {
    throw new Error(`expected an AddressInfo, got ${JSON.stringify(address)}`);
  }
  return `http://localhost:${address.port}`;
}

test('startMockServer: serves a resolved capture directory without any env vars set', async () => {
  const { dir } = resolveCapture(FIXTURE_CAPTURE_DIR);
  const started = await startMockServer({ dataPath: dir, port: 0 });
  try {
    assert.equal(started.captureDir, dir);
    assert.ok(started.entryCount > 0);
    assert.ok(started.routeCount > 0);

    const address = started.server.address();
    assert.ok(address && typeof address === 'object');
    const port = (address as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/_traffic`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ url: string }>;
    assert.ok(body.some((e) => e.url.includes('/api/widgets')));
  } finally {
    started.server.close();
  }
});

test('startMockServer: an explicit port option is honored', async () => {
  const port = 34567 + Math.floor(Math.random() * 1000);
  const started = await startMockServer({ dataPath: FIXTURE_CAPTURE_DIR, port });
  try {
    assert.equal(started.port, port);
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
  } finally {
    started.server.close();
  }
});

// ---------------------------------------------------------------------------
// Recorded POST matching — JSON bodies (test/fixtures/post-match-capture)
//
// Body scoring used to only understand form-encoded payloads (a query-string
// style k=v&k2=v2 parse); a JSON body scored the same as any other JSON body
// on the same path, so the "best" match was really just "whichever recorded
// entry happened to come first" — wrong response, same status. The fixture
// here records two POSTs to the same path with different JSON bodies plus
// one form-encoded POST, so each of those failure modes has something real
// to catch it.
// ---------------------------------------------------------------------------

test('mock-server recorded matching: two JSON POSTs to the same path each match their own body', async () => {
  const started = await startMockServer({ dataPath: POST_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const sprocket = await fetch(`${serverUrl(started)}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: 'Sprocket', qty: 5 }),
    });
    assert.equal(sprocket.status, 201);
    assert.equal((await sprocket.json()).matched, 'sprocket-order');

    const cog = await fetch(`${serverUrl(started)}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: 'Cog', qty: 9 }),
    });
    assert.equal(cog.status, 201);
    assert.equal((await cog.json()).matched, 'cog-order');
  } finally {
    started.server.close();
  }
});

test('mock-server recorded matching: a JSON POST body that agrees with neither recorded candidate matches neither (falls through to 404)', async () => {
  const started = await startMockServer({ dataPath: POST_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: 'Widget', qty: 1 }),
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-mockify-tier'), null);
  } finally {
    started.server.close();
  }
});

test('mock-server recorded matching: form-encoded POST bodies still match (JSON scoring does not regress the old path)', async () => {
  const started = await startMockServer({ dataPath: POST_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=alice&password=secret',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-tier'), 'recorded');
    assert.equal(await res.text(), 'OK: alice');
  } finally {
    started.server.close();
  }
});
