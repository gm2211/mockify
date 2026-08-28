import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveTargetUrl, buildOutgoingHeaders, fireCapturedRequest } from './fire.js';
import { REDACTED } from '../format/redact.js';
import type { CapturedTraffic } from '../format/types.js';

function entry(overrides: Partial<CapturedTraffic> = {}): CapturedTraffic {
  return {
    url: 'https://original.example.test/api/widgets/1?verbose=true',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: 0,
    responseBody: '{"id":1}',
    ...overrides,
  };
}

test('resolveTargetUrl: swaps the origin but keeps path + query', () => {
  const url = resolveTargetUrl('https://original.example.test/api/widgets/1?verbose=true', 'http://localhost:9999');
  assert.equal(url, 'http://localhost:9999/api/widgets/1?verbose=true');
});

test('resolveTargetUrl: falls back to treating an unparseable entry URL as a path', () => {
  const url = resolveTargetUrl('/api/widgets/1', 'http://localhost:9999/');
  assert.equal(url, 'http://localhost:9999/api/widgets/1');
});

test('buildOutgoingHeaders: drops volatile/hop-by-hop headers (Host, User-Agent, ...)', () => {
  const headers = buildOutgoingHeaders({
    requestHeaders: { host: 'original.example.test', 'user-agent': 'Mozilla/5', accept: 'application/json', 'x-tenant': 'acme' },
  });
  assert.equal(headers.host, undefined);
  assert.equal(headers['user-agent'], undefined);
  assert.equal(headers.accept, undefined); // accept is in the volatile/content-negotiation list too
  assert.equal(headers['x-tenant'], 'acme');
});

test('buildOutgoingHeaders: drops a header whose recorded value is the redaction placeholder', () => {
  const headers = buildOutgoingHeaders({ requestHeaders: { authorization: REDACTED, 'x-tenant': 'acme' } });
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-tenant'], 'acme');
});

test('buildOutgoingHeaders: extraHeaders win over recorded ones', () => {
  const headers = buildOutgoingHeaders(
    { requestHeaders: { 'x-tenant': 'acme' } },
    { 'x-tenant': 'globex', authorization: 'Bearer live-token' },
  );
  assert.equal(headers['x-tenant'], 'globex');
  assert.equal(headers.authorization, 'Bearer live-token');
});

test('buildOutgoingHeaders: no recorded headers at all still works (pre-format-v2 capture)', () => {
  const headers = buildOutgoingHeaders({});
  assert.deepEqual(headers, {});
});

// ---------------------------------------------------------------------------
// HTTP-level: fire a captured entry at a real local server
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

test('fireCapturedRequest: GET against a real server returns status + body', async () => {
  await withTestServer(
    (req, res) => {
      assert.equal(req.url, '/api/widgets/1?verbose=true');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":1,"label":"widget"}');
    },
    async (baseUrl) => {
      const result = await fireCapturedRequest(entry(), baseUrl);
      assert.equal(result.status, 200);
      assert.equal(result.body, '{"id":1,"label":"widget"}');
    },
  );
});

test('fireCapturedRequest: POST forwards the recorded body', async () => {
  await withTestServer(
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        assert.equal(Buffer.concat(chunks).toString(), '{"name":"new widget"}');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"id":2,"name":"new widget"}');
      });
    },
    async (baseUrl) => {
      const result = await fireCapturedRequest(
        entry({ method: 'POST', postData: '{"name":"new widget"}', url: 'https://original.example.test/api/widgets' }),
        baseUrl,
      );
      assert.equal(result.status, 201);
      assert.equal(result.body, '{"id":2,"name":"new widget"}');
    },
  );
});

test('fireCapturedRequest: a redacted Authorization header is not forwarded literally', async () => {
  await withTestServer(
    (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200);
      res.end('ok');
    },
    async (baseUrl) => {
      await fireCapturedRequest(entry({ requestHeaders: { authorization: REDACTED } }), baseUrl);
    },
  );
});

test('fireCapturedRequest: extraHeaders (e.g. --header auth) reach the target', async () => {
  await withTestServer(
    (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer real-token');
      res.writeHead(200);
      res.end('ok');
    },
    async (baseUrl) => {
      await fireCapturedRequest(entry(), baseUrl, { extraHeaders: { Authorization: 'Bearer real-token' } });
    },
  );
});
