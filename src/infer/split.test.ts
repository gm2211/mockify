import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitPairs } from './split.js';
import type { CapturedTraffic } from '../format/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_TRAFFIC = path.join(__dirname, '..', '..', 'test', 'fixtures', 'infer-capture', 'traffic.json');

function loadFixtureEntries(): CapturedTraffic[] {
  return JSON.parse(fs.readFileSync(FIXTURE_TRAFFIC, 'utf8')) as CapturedTraffic[];
}

function entryKey(e: CapturedTraffic): string {
  return `${e.method} ${e.url} ${e.postData ?? ''}`;
}

test('splitPairs: deterministic — same input yields the same split every time', () => {
  const entries = loadFixtureEntries();
  const a = splitPairs(entries);
  const b = splitPairs(entries);
  assert.deepEqual(a.train.map(entryKey), b.train.map(entryKey));
  assert.deepEqual(a.holdout.map(entryKey), b.holdout.map(entryKey));
});

test('splitPairs: deterministic across freshly-parsed copies of the same data', () => {
  // A fresh JSON.parse gives distinct object references — determinism must
  // not accidentally depend on object identity.
  const a = splitPairs(loadFixtureEntries());
  const b = splitPairs(loadFixtureEntries());
  assert.deepEqual(a.train.map(entryKey), b.train.map(entryKey));
  assert.deepEqual(a.holdout.map(entryKey), b.holdout.map(entryKey));
});

test('splitPairs: train + holdout is a full partition of the input', () => {
  const entries = loadFixtureEntries();
  const { train, holdout } = splitPairs(entries);
  assert.equal(train.length + holdout.length, entries.length);
  const seen = new Set([...train, ...holdout]);
  assert.equal(seen.size, entries.length);
});

test('splitPairs: a multi-pair template gets holdout coverage', () => {
  const entries = loadFixtureEntries();
  const { counts } = splitPairs(entries);
  const detail = counts.find((c) => c.pathTemplate === '/api/items/{p2}');
  assert.ok(detail, 'expected a template for /api/items/{p2}');
  assert.equal(detail?.total, 5);
  assert.ok((detail?.holdout ?? 0) >= 1, 'expected at least one holdout pair for a 5-pair template');
  assert.ok((detail?.train ?? 0) >= 1, 'expected train to keep at least one pair too');
});

test('splitPairs: a 2-pair template also gets holdout coverage, not just 3+', () => {
  const entries = loadFixtureEntries();
  const { counts } = splitPairs(entries);
  const postTemplate = counts.find((c) => c.pathTemplate === '/api/items' && c.method === 'POST');
  assert.ok(postTemplate);
  assert.equal(postTemplate?.total, 2);
  assert.equal(postTemplate?.holdout, 1);
  assert.equal(postTemplate?.train, 1);
});

test('splitPairs: a template with only 1 pair goes entirely to train', () => {
  const entries = loadFixtureEntries();
  const { counts } = splitPairs(entries);
  const collection = counts.find((c) => c.pathTemplate === '/api/items' && c.method === 'GET');
  assert.ok(collection);
  assert.equal(collection?.total, 1);
  assert.equal(collection?.holdout, 0);
  assert.equal(collection?.train, 1);
});

test('splitPairs: holdoutRatio is configurable', () => {
  const entries = loadFixtureEntries();
  const { counts } = splitPairs(entries, { holdoutRatio: 0.5 });
  const detail = counts.find((c) => c.pathTemplate === '/api/items/{p2}');
  assert.ok(detail);
  assert.ok((detail?.holdout ?? 0) >= 2, `expected roughly half of 5 pairs held out, got ${detail?.holdout}`);
});

test('splitPairs: entries whose URL fails to parse are not dropped, and go to train', () => {
  const entries: CapturedTraffic[] = [
    {
      url: 'not a url at all',
      method: 'GET',
      postData: null,
      status: 200,
      contentType: 'text/plain',
      ts: 0,
      responseBody: 'x',
    },
  ];
  const { train, holdout } = splitPairs(entries);
  assert.equal(train.length, 1);
  assert.equal(holdout.length, 0);
});
