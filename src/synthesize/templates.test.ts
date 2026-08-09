import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { inferTemplates } from './templates.js';
import type { CapturedTraffic } from '../format/types.js';

function entry(partial: Partial<CapturedTraffic> & Pick<CapturedTraffic, 'url' | 'method'>): CapturedTraffic {
  return {
    postData: null,
    status: 200,
    contentType: 'application/json; charset=utf-8',
    ts: Date.now(),
    responseBody: null,
    ...partial,
  };
}

test('inferTemplates: repeated numeric ids collapse into one templated variable', () => {
  const entries = [
    entry({ url: 'https://x.test/api/room/1', method: 'GET', responseBody: '{"roomid":1}' }),
    entry({ url: 'https://x.test/api/room/2', method: 'GET', responseBody: '{"roomid":2}' }),
    entry({ url: 'https://x.test/api/room/3', method: 'GET', responseBody: '{"roomid":3}' }),
  ];
  const templates = inferTemplates(entries);
  assert.equal(templates.length, 1);
  const t = templates[0];
  assert.equal(t.method, 'GET');
  assert.equal(t.pathTemplate, '/api/room/{p2}');
  assert.deepEqual(t.paramNames, ['p2']);
  assert.deepEqual(t.observedValues.p2.sort(), ['1', '2', '3']);
  assert.equal(t.entryCount, 3);
  assert.ok(new RegExp(t.regex).test('/api/room/7'), 'regex should match an unrecorded id too');
});

test('inferTemplates: a single observed value stays fully literal', () => {
  const entries = [
    entry({ url: 'https://x.test/api/message/10', method: 'GET', responseBody: '{"messageid":10}' }),
  ];
  const templates = inferTemplates(entries);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].pathTemplate, '/api/message/10');
  assert.deepEqual(templates[0].paramNames, []);
});

test('inferTemplates: different methods on the same path do not merge', () => {
  const entries = [
    entry({ url: 'https://x.test/api/widgets/1', method: 'GET' }),
    entry({ url: 'https://x.test/api/widgets/1', method: 'POST', status: 201 }),
  ];
  const templates = inferTemplates(entries);
  assert.equal(templates.length, 2);
  const methods = templates.map((t) => t.method).sort();
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('inferTemplates: an id family is not shattered by a sibling literal action route', () => {
  // /api/widgets/1..3 (ids) share a segment count with /api/widgets/count
  // (a literal action route). The id family must still collapse into one
  // template instead of each numeric id becoming its own literal template.
  const entries = [
    entry({ url: 'https://x.test/api/widgets/1', method: 'GET' }),
    entry({ url: 'https://x.test/api/widgets/2', method: 'GET' }),
    entry({ url: 'https://x.test/api/widgets/3', method: 'GET' }),
    entry({ url: 'https://x.test/api/widgets/count', method: 'GET', responseBody: '{"count":42}' }),
  ];
  const templates = inferTemplates(entries);
  const byPath = new Map(templates.map((t) => [t.pathTemplate, t]));
  assert.ok(byPath.has('/api/widgets/{p2}'), `expected a widgets id template, got: ${[...byPath.keys()]}`);
  assert.equal(byPath.get('/api/widgets/{p2}')?.entryCount, 3);
  assert.ok(byPath.has('/api/widgets/count'));
  assert.equal(byPath.get('/api/widgets/count')?.paramNames.length, 0);
});

test('inferTemplates: two literal word families sharing a segment count split apart cleanly', () => {
  const entries = [
    entry({ url: 'https://x.test/api/room/1', method: 'GET' }),
    entry({ url: 'https://x.test/api/room/2', method: 'GET' }),
    entry({ url: 'https://x.test/api/message/10', method: 'GET' }),
  ];
  const templates = inferTemplates(entries);
  const byPath = new Map(templates.map((t) => [t.pathTemplate, t]));
  assert.ok(byPath.has('/api/room/{p2}'));
  assert.ok(byPath.has('/api/message/10'));
});

test('inferTemplates: templates whose entries are all non-2xx are skipped', () => {
  const entries = [
    entry({ url: 'https://x.test/api/broken', method: 'GET', status: 404 }),
    entry({ url: 'https://x.test/api/broken', method: 'GET', status: 500 }),
  ];
  const templates = inferTemplates(entries);
  assert.equal(templates.length, 0);
});

test('inferTemplates: modal status/content-type is used when entries disagree', () => {
  const entries = [
    entry({ url: 'https://x.test/api/thing', method: 'POST', status: 400 }),
    entry({ url: 'https://x.test/api/thing', method: 'POST', status: 400 }),
    entry({ url: 'https://x.test/api/thing', method: 'POST', status: 201 }),
  ];
  const templates = inferTemplates(entries);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].status, 400);
});
