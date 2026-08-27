import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MULTI_VALUE_HEADER_SEPARATOR,
  packMultiValueHeader,
  unpackMultiValueHeader,
  packHeadersArray,
  isVolatileRequestHeaderName,
  headersSubsetMatch,
  HOP_BY_HOP_RESPONSE_HEADERS,
  buildReplayResponseHeaders,
} from './headers.js';

// ---------------------------------------------------------------------------
// Multi-value header packing
// ---------------------------------------------------------------------------

test('packMultiValueHeader / unpackMultiValueHeader round-trip', () => {
  const packed = packMultiValueHeader(['session=s1; Path=/', 'theme=dark; Path=/']);
  assert.equal(packed, `session=s1; Path=/${MULTI_VALUE_HEADER_SEPARATOR}theme=dark; Path=/`);
  assert.deepEqual(unpackMultiValueHeader(packed), ['session=s1; Path=/', 'theme=dark; Path=/']);
});

test('unpackMultiValueHeader: a single (unpacked) value round-trips to a one-element array', () => {
  assert.deepEqual(unpackMultiValueHeader('session=s1; Path=/'), ['session=s1; Path=/']);
});

test('packHeadersArray: folds repeated header names (e.g. Set-Cookie) and lower-cases names', () => {
  const out = packHeadersArray([
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Set-Cookie', value: 'a=1' },
    { name: 'Set-Cookie', value: 'b=2' },
  ]);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['set-cookie'], `a=1${MULTI_VALUE_HEADER_SEPARATOR}b=2`);
});

test('packHeadersArray: a header that appears once packs to itself unchanged', () => {
  const out = packHeadersArray([{ name: 'X-Request-Id', value: 'r-1' }]);
  assert.equal(out['x-request-id'], 'r-1');
});

// ---------------------------------------------------------------------------
// Volatile header classification
// ---------------------------------------------------------------------------

test('isVolatileRequestHeaderName: matches documented volatile headers case-insensitively', () => {
  for (const name of ['Host', 'User-Agent', 'Date', 'Connection', 'Content-Length', 'Accept-Encoding']) {
    assert.equal(isVolatileRequestHeaderName(name), true, `expected "${name}" to be volatile`);
  }
});

test('isVolatileRequestHeaderName: leaves ordinary/application headers alone', () => {
  for (const name of ['x-tenant', 'x-feature-flag', 'authorization', 'content-type']) {
    assert.equal(isVolatileRequestHeaderName(name), false, `expected "${name}" to NOT be volatile`);
  }
});

// ---------------------------------------------------------------------------
// headersSubsetMatch — positive/negative subset matching (SP-lsc.8)
// ---------------------------------------------------------------------------

test('headersSubsetMatch: undefined recorded headers always match (permissive default for pre-SP-lsc.8 captures)', () => {
  assert.equal(headersSubsetMatch(undefined, {}), true);
  assert.equal(headersSubsetMatch(undefined, { 'x-tenant': 'acme' }), true);
});

test('headersSubsetMatch: POSITIVE — every significant recorded header is present in incoming with the same value', () => {
  const recorded = { 'x-tenant': 'acme', accept: 'application/json' };
  const incoming = { 'x-tenant': 'acme', accept: 'application/json', 'user-agent': 'test-client/1.0' };
  assert.equal(headersSubsetMatch(recorded, incoming), true);
});

test('headersSubsetMatch: POSITIVE — incoming may carry extra headers recorded never mentions (subset, not equality)', () => {
  const recorded = { 'x-tenant': 'acme' };
  const incoming = { 'x-tenant': 'acme', 'x-extra': 'whatever', 'content-length': '0' };
  assert.equal(headersSubsetMatch(recorded, incoming), true);
});

test('headersSubsetMatch: POSITIVE — header name comparison is case-insensitive', () => {
  const recorded = { 'X-Tenant': 'acme' };
  const incoming = { 'x-tenant': 'acme' };
  assert.equal(headersSubsetMatch(recorded, incoming), true);
});

test('headersSubsetMatch: NEGATIVE — a significant recorded header with a different incoming value does not match', () => {
  const recorded = { 'x-tenant': 'acme' };
  const incoming = { 'x-tenant': 'globex' };
  assert.equal(headersSubsetMatch(recorded, incoming), false);
});

test('headersSubsetMatch: NEGATIVE — a significant recorded header missing from incoming entirely does not match', () => {
  const recorded = { 'x-tenant': 'acme' };
  const incoming = { accept: 'application/json' };
  assert.equal(headersSubsetMatch(recorded, incoming), false);
});

test('headersSubsetMatch: volatile recorded headers are ignored even when they disagree with incoming', () => {
  const recorded = { 'user-agent': 'RecordingBrowser/1.0', host: 'original-target.example', 'x-tenant': 'acme' };
  const incoming = { 'user-agent': 'node-fetch/replay', host: 'localhost:3456', 'x-tenant': 'acme' };
  assert.equal(headersSubsetMatch(recorded, incoming), true);
});

test('headersSubsetMatch: secret (redacted) recorded headers are ignored, even though their stored value ("[REDACTED]") could never equal a live one', () => {
  const recorded = { authorization: '[REDACTED]', cookie: '[REDACTED]', 'x-tenant': 'acme' };
  const incoming = { authorization: 'Bearer live-token-xyz', cookie: 'session=live-value', 'x-tenant': 'acme' };
  assert.equal(headersSubsetMatch(recorded, incoming), true);
});

// ---------------------------------------------------------------------------
// buildReplayResponseHeaders — response header replay + hop-by-hop stripping
// ---------------------------------------------------------------------------

test('buildReplayResponseHeaders: forwards captured response headers, including CORS Access-Control-Allow-*', () => {
  const out = buildReplayResponseHeaders({
    contentType: 'application/json',
    responseHeaders: {
      'access-control-allow-origin': 'https://app.example.com',
      'access-control-allow-credentials': 'true',
    },
  });
  assert.equal(out['access-control-allow-origin'], 'https://app.example.com');
  assert.equal(out['access-control-allow-credentials'], 'true');
  assert.equal(out['content-type'], 'application/json');
});

test('buildReplayResponseHeaders: unpacks a packed multi-value Set-Cookie into a real string array', () => {
  const out = buildReplayResponseHeaders({
    contentType: 'application/json',
    responseHeaders: { 'set-cookie': `session=s1; Path=/${MULTI_VALUE_HEADER_SEPARATOR}theme=dark; Path=/` },
  });
  assert.deepEqual(out['set-cookie'], ['session=s1; Path=/', 'theme=dark; Path=/']);
});

test('buildReplayResponseHeaders: a single Set-Cookie value still becomes a one-element array', () => {
  const out = buildReplayResponseHeaders({
    contentType: 'application/json',
    responseHeaders: { 'set-cookie': 'session=s1; Path=/' },
  });
  assert.deepEqual(out['set-cookie'], ['session=s1; Path=/']);
});

test('buildReplayResponseHeaders: strips every hop-by-hop header', () => {
  const responseHeaders: Record<string, string> = {};
  for (const name of HOP_BY_HOP_RESPONSE_HEADERS) {
    responseHeaders[name] = 'bogus-captured-value';
  }
  const out = buildReplayResponseHeaders({ contentType: 'text/plain', responseHeaders });
  for (const name of HOP_BY_HOP_RESPONSE_HEADERS) {
    assert.equal(name in out, false, `expected hop-by-hop header "${name}" to be stripped`);
  }
});

test('buildReplayResponseHeaders: content-type always comes from entry.contentType, not a captured content-type header, and never duplicates', () => {
  const out = buildReplayResponseHeaders({
    contentType: 'application/json; charset=utf-8',
    responseHeaders: { 'Content-Type': 'text/html' },
  });
  assert.equal(out['content-type'], 'application/json; charset=utf-8');
  assert.equal(Object.keys(out).filter((k) => k === 'content-type').length, 1);
});

test('buildReplayResponseHeaders: falls back to application/octet-stream when contentType is empty', () => {
  const out = buildReplayResponseHeaders({ contentType: '' });
  assert.equal(out['content-type'], 'application/octet-stream');
});

test('buildReplayResponseHeaders: works with no responseHeaders at all (old-format capture, format version 1)', () => {
  const out = buildReplayResponseHeaders({ contentType: 'application/json' });
  assert.deepEqual(out, { 'content-type': 'application/json' });
});

test('buildReplayResponseHeaders: `extra` is applied last and wins over anything captured, even under different casing (no duplicate header line)', () => {
  const out = buildReplayResponseHeaders(
    { contentType: 'application/json', responseHeaders: { 'X-Mockify-Tier': 'should-not-survive' } },
    { 'X-Mockify-Tier': 'recorded' },
  );
  assert.equal(out['x-mockify-tier'], 'recorded');
  assert.equal(Object.keys(out).filter((k) => k === 'x-mockify-tier').length, 1);
});
