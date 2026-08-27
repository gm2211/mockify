/**
 * src/mock-server-headers.test.ts — header capture + replay (SP-lsc.8)
 *
 * Exercises the HTTP-visible behavior added by SP-lsc.8 on top of
 * src/mock-server.ts's recorded tier: request-header SUBSET matching
 * (src/format/headers.ts's headersSubsetMatch, unit-tested directly in
 * src/format/headers.test.ts) and response-header replay, including
 * Set-Cookie, CORS, and hop-by-hop stripping.
 *
 * test/fixtures/header-match-capture/traffic.json records:
 *   - two GET /api/dashboard entries distinguished only by an X-Tenant
 *     request header ("acme" vs "globex") — the subset-matching positive
 *     cases.
 *   - one GET /api/profile entry whose responseHeaders carry a redacted
 *     Set-Cookie, CORS Access-Control-Allow-* headers, and bogus
 *     hop-by-hop values (transfer-encoding/connection/content-length) that
 *     must never reach the client verbatim.
 *   - one OPTIONS /api/profile entry (a CORS preflight response).
 *   - one GET /api/multi-cookie entry with two packed Set-Cookie values.
 *   - one GET /api/legacy-no-headers entry with no requestHeaders/
 *     responseHeaders at all, standing in for a pre-SP-lsc.8 capture.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HEADER_MATCH_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'header-match-capture');
const LEGACY_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'post-match-capture');

function serverUrl(started: { server: http.Server }): string {
  const address = started.server.address();
  if (!address || typeof address === 'string') {
    throw new Error(`expected an AddressInfo, got ${JSON.stringify(address)}`);
  }
  return `http://localhost:${address.port}`;
}

// ---------------------------------------------------------------------------
// Request header SUBSET matching — positive and negative (permissive) cases
// ---------------------------------------------------------------------------

test('header matching: a request with the recorded X-Tenant value matches the correct recorded variant', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const acme = await fetch(`${serverUrl(started)}/api/dashboard`, { headers: { 'X-Tenant': 'acme' } });
    assert.equal(acme.status, 200);
    assert.deepEqual(await acme.json(), { tenant: 'acme', widgets: 3 });

    const globex = await fetch(`${serverUrl(started)}/api/dashboard`, { headers: { 'X-Tenant': 'globex' } });
    assert.equal(globex.status, 200);
    assert.deepEqual(await globex.json(), { tenant: 'globex', widgets: 9 });
  } finally {
    started.server.close();
  }
});

test('header matching: a request whose X-Tenant matches neither recorded variant still gets a 200 (permissive default), not a 404', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/dashboard`, { headers: { 'X-Tenant': 'initech' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-tier'), 'recorded');
    const body = (await res.json()) as { tenant: string };
    assert.ok(['acme', 'globex'].includes(body.tenant), 'expected a fallback to one of the recorded variants');
  } finally {
    started.server.close();
  }
});

test('header matching: a request with no X-Tenant header at all also falls back permissively instead of 404ing', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/dashboard`);
    assert.equal(res.status, 200);
  } finally {
    started.server.close();
  }
});

// ---------------------------------------------------------------------------
// Response header replay — Set-Cookie, CORS, hop-by-hop stripping
// ---------------------------------------------------------------------------

test('response header replay: Set-Cookie and CORS Access-Control-Allow-* headers are replayed, not dropped', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/profile`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.fixture.test');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.deepEqual(res.headers.getSetCookie(), ['session=[REDACTED]; Path=/; HttpOnly']);
  } finally {
    started.server.close();
  }
});

test('response header replay: hop-by-hop headers (Transfer-Encoding, Connection, Content-Length) never reach the client verbatim', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/profile`);
    assert.notEqual(res.headers.get('transfer-encoding'), 'bogus-captured-encoding');
    assert.notEqual(res.headers.get('connection'), 'bogus-captured-connection');
    assert.notEqual(res.headers.get('content-length'), '999999');
    // The body is still received correctly regardless — stripping the
    // captured (wrong) framing headers doesn't corrupt the response.
    assert.deepEqual(await res.json(), { id: 1, name: 'alice' });
  } finally {
    started.server.close();
  }
});

test('response header replay: a CORS preflight (OPTIONS) response replays its recorded Access-Control-* headers', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/profile`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.fixture.test');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, X-Tenant');
  } finally {
    started.server.close();
  }
});

test('response header replay: a packed multi-value Set-Cookie replays as two separate Set-Cookie lines', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/multi-cookie`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers.getSetCookie(), ['session=[REDACTED]; Path=/', 'theme=dark; Path=/']);
  } finally {
    started.server.close();
  }
});

// ---------------------------------------------------------------------------
// Backward compatibility — entries with no header data at all
// ---------------------------------------------------------------------------

test('an entry with no requestHeaders/responseHeaders (pre-SP-lsc.8 shape) still replays fine, with just Content-Type set', async () => {
  const started = await startMockServer({ dataPath: HEADER_MATCH_CAPTURE_DIR, port: 0 });
  try {
    const res = await fetch(`${serverUrl(started)}/api/legacy-no-headers`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { legacy: true });
  } finally {
    started.server.close();
  }
});

test('an entirely pre-SP-lsc.8 fixture (test/fixtures/post-match-capture, no header fields anywhere) still loads and replays unchanged', async () => {
  const started = await startMockServer({ dataPath: LEGACY_CAPTURE_DIR, port: 0 });
  try {
    assert.ok(started.entryCount > 0);
    const res = await fetch(`${serverUrl(started)}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=alice&password=secret',
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'OK: alice');
  } finally {
    started.server.close();
  }
});
