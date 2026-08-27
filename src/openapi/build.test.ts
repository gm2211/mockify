import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, type OpenApiParameter } from './build.js';
import type { CapturedTraffic } from '../format/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures');

function loadFixture(name: string): CapturedTraffic[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name, 'traffic.json'), 'utf8')) as CapturedTraffic[];
}

function entry(overrides: Partial<CapturedTraffic> & Pick<CapturedTraffic, 'url' | 'method' | 'status'>): CapturedTraffic {
  return {
    postData: null,
    contentType: 'application/json',
    ts: 0,
    responseBody: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic document shape
// ---------------------------------------------------------------------------

test('buildOpenApiDocument: emits a well-formed OpenAPI 3.1 envelope', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'), { title: 'Widgets API', version: '2.0.0' });
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.title, 'Widgets API');
  assert.equal(doc.info.version, '2.0.0');
  assert.ok(doc.paths && typeof doc.paths === 'object');
});

test('buildOpenApiDocument: defaults title/version when not given', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'));
  assert.equal(doc.info.title, 'Mockify Capture');
  assert.equal(doc.info.version, '0.0.0');
});

test('buildOpenApiDocument: infers servers from observed request origins', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'));
  assert.ok(doc.servers?.some((s) => s.url === 'https://example.com'));
});

// ---------------------------------------------------------------------------
// Template -> path item mapping: params, methods, status codes
// ---------------------------------------------------------------------------

test('buildOpenApiDocument: a numeric id template becomes a path with a {name}Id parameter', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'));
  const pathItem = doc.paths['/api/widgets/{widgetId}'];
  assert.ok(pathItem, `expected a /api/widgets/{widgetId} path, got: ${Object.keys(doc.paths).join(', ')}`);
  const get = pathItem!.get;
  assert.ok(get);
  const param = get!.parameters?.find((p) => p.name === 'widgetId');
  assert.ok(param);
  assert.equal(param!.in, 'path');
  assert.equal(param!.required, true);
  assert.equal(param!.schema.type, 'integer');
});

test('buildOpenApiDocument: a literal-only path (no variable) stays literal and does not get a path parameter', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'));
  const pathItem = doc.paths['/api/widgets/count'];
  assert.ok(pathItem);
  assert.equal(pathItem!.get?.parameters, undefined);
});

test('buildOpenApiDocument: method is keyed correctly (GET vs POST land on separate operations)', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'));
  const widgetsOne = doc.paths['/api/widgets/{widgetId}'] ?? doc.paths['/api/widgets/1'];
  assert.ok(widgetsOne?.get, 'expected a GET operation on the widgets id path');

  const postPath = doc.paths['/api/widgets/1'];
  assert.ok(postPath?.post, 'expected a POST operation on /api/widgets/1');
  assert.equal(postPath!.post!.responses['201'].description, 'Created');
});

test('buildOpenApiDocument: multiple observed status codes on one template each get their own response entry', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://api.test/api/widgets/1', method: 'GET', status: 200, responseBody: JSON.stringify({ id: 1 }) }),
    entry({ url: 'https://api.test/api/widgets/2', method: 'GET', status: 200, responseBody: JSON.stringify({ id: 2 }) }),
    entry({
      url: 'https://api.test/api/widgets/999',
      method: 'GET',
      status: 404,
      responseBody: JSON.stringify({ error: 'not found' }),
    }),
  ];
  const doc = buildOpenApiDocument(entries);
  const get = doc.paths['/api/widgets/{widgetId}']!.get!;
  assert.deepEqual(Object.keys(get.responses).sort(), ['200', '404']);
  assert.equal(get.responses['200'].description, 'OK');
  assert.equal(get.responses['404'].description, 'Not Found');
  const errorSchema = get.responses['404'].content!['application/json'].schema;
  assert.equal((errorSchema.properties as Record<string, { type: string }>).error.type, 'string');
});

test('buildOpenApiDocument: a status code with no captured body (e.g. 204) gets no content entry', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://api.test/api/ping', method: 'DELETE', status: 204, responseBody: null, contentType: '' }),
  ];
  const doc = buildOpenApiDocument(entries);
  const del = doc.paths['/api/ping']!.delete!;
  assert.equal(del.responses['204'].content, undefined);
});

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

test('buildOpenApiDocument: query params observed on every request are required; params seen only sometimes are not', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://api.test/api/search?q=foo', method: 'GET', status: 200, responseBody: '{"results":[]}' }),
    entry({ url: 'https://api.test/api/search?q=bar&page=2', method: 'GET', status: 200, responseBody: '{"results":[]}' }),
  ];
  const doc = buildOpenApiDocument(entries);
  const params = (doc.paths['/api/search']!.get!.parameters ?? []) as OpenApiParameter[];
  const q = params.find((p) => p.name === 'q');
  const pg = params.find((p) => p.name === 'page');
  assert.ok(q && pg);
  assert.equal(q!.in, 'query');
  assert.equal(q!.required, true);
  assert.equal(pg!.required, false);
  assert.equal(pg!.schema.type, 'integer');
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

test('buildOpenApiDocument: JSON request bodies produce an application/json requestBody schema', () => {
  const doc = buildOpenApiDocument(loadFixture('post-match-capture'));
  const post = doc.paths['/api/orders']!.post!;
  assert.ok(post.requestBody);
  assert.equal(post.requestBody!.required, true);
  const schema = post.requestBody!.content['application/json'].schema;
  assert.equal(schema.type, 'object');
  assert.ok((schema.properties as Record<string, unknown>).item);
  assert.ok((schema.properties as Record<string, unknown>).qty);
});

test('buildOpenApiDocument: form-encoded request bodies produce an application/x-www-form-urlencoded schema', () => {
  const doc = buildOpenApiDocument(loadFixture('post-match-capture'));
  const post = doc.paths['/api/login']!.post!;
  assert.ok(post.requestBody);
  const content = post.requestBody!.content;
  assert.ok('application/x-www-form-urlencoded' in content);
  const schema = content['application/x-www-form-urlencoded'].schema;
  assert.equal((schema.properties as Record<string, { type: string }>).username.type, 'string');
});

test('buildOpenApiDocument: a GET with no postData gets no requestBody', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'));
  const get = doc.paths['/api/widgets/{widgetId}']!.get!;
  assert.equal(get.requestBody, undefined);
});

// ---------------------------------------------------------------------------
// Response headers (format v2, optional)
// ---------------------------------------------------------------------------

test('buildOpenApiDocument: response headers are documented when present, excluding hop-by-hop and content-type', () => {
  const doc = buildOpenApiDocument(loadFixture('header-match-capture'));
  const profileGet = doc.paths['/api/profile']!.get!;
  const headers = profileGet.responses['200'].headers;
  assert.ok(headers);
  assert.ok('access-control-allow-origin' in headers!);
  assert.ok('set-cookie' in headers!);
  assert.ok(!('content-type' in headers!), 'content-type is represented via the content media type, not headers');
  assert.ok(!('transfer-encoding' in headers!), 'hop-by-hop headers must not be documented');
  assert.ok(!('connection' in headers!), 'hop-by-hop headers must not be documented');
  assert.ok(!('content-length' in headers!), 'hop-by-hop headers must not be documented');
});

test('buildOpenApiDocument: entries with no responseHeaders at all (pre-SP-lsc.8 captures) get no headers field', () => {
  const doc = buildOpenApiDocument(loadFixture('header-match-capture'));
  const legacy = doc.paths['/api/legacy-no-headers']!.get!;
  assert.equal(legacy.responses['200'].headers, undefined);
});

// ---------------------------------------------------------------------------
// JSON round trip (serialization correctness independent of YAML)
// ---------------------------------------------------------------------------

test('buildOpenApiDocument output round-trips through JSON.stringify/parse unchanged', () => {
  const doc = buildOpenApiDocument(loadFixture('synthetic-captures'), { title: 'RT', version: '1.0.0' });
  const roundTripped = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(roundTripped, doc);
});
