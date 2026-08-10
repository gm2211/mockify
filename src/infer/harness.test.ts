import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImplementation } from './harness.js';
import type { CapturedTraffic } from '../format/types.js';
import type { Implementation } from './contract.js';

function entry(overrides: Partial<CapturedTraffic> = {}): CapturedTraffic {
  return {
    url: 'https://example.test/api/thing/1',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: 0,
    responseBody: '{"id":1,"label":"a"}',
    ...overrides,
  };
}

test('validateImplementation: exact grade when status and body match exactly', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => ({ status: 200, contentType: 'application/json', body: { id: 1, label: 'a' } }),
  };
  const result = await validateImplementation(impl, [entry()]);
  assert.equal(result.total, 1);
  assert.equal(result.overall.exact, 1);
  assert.equal(result.overall.structural, 0);
  assert.equal(result.overall.status_only, 0);
  assert.equal(result.overall.fail, 0);
});

test('validateImplementation: exact grade tolerates a string body that JSON-parses equal', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => ({ status: 200, contentType: 'application/json', body: '{"id":1,"label":"a"}' }),
  };
  const result = await validateImplementation(impl, [entry()]);
  assert.equal(result.overall.exact, 1);
});

test('validateImplementation: structural grade when shape matches but values differ (e.g. ids/timestamps)', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => ({ status: 200, contentType: 'application/json', body: { id: 999, label: 'totally different' } }),
  };
  const result = await validateImplementation(impl, [entry()]);
  assert.equal(result.overall.structural, 1);
  assert.equal(result.overall.exact, 0);
});

test('validateImplementation: structural grade requires arrays to be non-empty when recorded was non-empty', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => ({ status: 200, contentType: 'application/json', body: { items: [] } }),
  };
  const result = await validateImplementation(impl, [entry({ responseBody: '{"items":[{"id":1}]}' })]);
  assert.equal(result.overall.status_only, 1);
});

test('validateImplementation: status_only grade when status matches but shape differs', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => ({ status: 200, contentType: 'application/json', body: { totally: 'different', shape: true } }),
  };
  const result = await validateImplementation(impl, [entry()]);
  assert.equal(result.overall.status_only, 1);
});

test('validateImplementation: fail grade when status differs', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => ({ status: 500, contentType: 'application/json', body: { id: 1, label: 'a' } }),
  };
  const result = await validateImplementation(impl, [entry()]);
  assert.equal(result.overall.fail, 1);
});

test('validateImplementation: fail grade when handler declines (returns null)', async () => {
  const impl: Implementation = { reset() {}, handle: () => null };
  const result = await validateImplementation(impl, [entry()]);
  assert.equal(result.overall.fail, 1);
  assert.match(result.results[0].detail ?? '', /declined/);
});

test('validateImplementation: fail grade when the handler throws', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => {
      throw new Error('boom');
    },
  };
  const result = await validateImplementation(impl, [entry()]);
  assert.equal(result.overall.fail, 1);
  assert.match(result.results[0].detail ?? '', /threw/);
});

test('validateImplementation: reset() is called once per run; state persists across pairs within the run', async () => {
  let resets = 0;
  let counter = 0;
  const impl: Implementation = {
    reset() {
      resets++;
      counter = 0;
    },
    handle: () => {
      counter++;
      return { status: 200, contentType: 'text/plain', body: String(counter) };
    },
  };
  const pairs = [entry({ responseBody: '1', contentType: 'text/plain' }), entry({ responseBody: '2', contentType: 'text/plain' })];
  const result = await validateImplementation(impl, pairs);
  assert.equal(resets, 1);
  assert.equal(result.overall.exact, 2);
});

test('validateImplementation: per-template breakdown groups pairs by endpoint template', async () => {
  const impl: Implementation = {
    reset() {},
    handle: () => ({ status: 200, contentType: 'application/json', body: { id: 1, label: 'a' } }),
  };
  const pairs = [
    entry({ url: 'https://example.test/api/thing/1' }),
    entry({ url: 'https://example.test/api/thing/2' }),
  ];
  const result = await validateImplementation(impl, pairs);
  assert.equal(result.perTemplate.length, 1);
  assert.equal(result.perTemplate[0].pathTemplate, '/api/thing/{p2}');
  assert.equal(result.perTemplate[0].pairs, 2);
  assert.equal(result.perTemplate[0].grades.exact, 2);
});

test('validateImplementation: an empty pairs list still resets and returns zeroed totals', async () => {
  let resets = 0;
  const impl: Implementation = { reset: () => { resets++; }, handle: () => null };
  const result = await validateImplementation(impl, []);
  assert.equal(resets, 1);
  assert.equal(result.total, 0);
  assert.deepEqual(result.overall, { exact: 0, structural: 0, status_only: 0, fail: 0 });
});
