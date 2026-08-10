/**
 * src/infer/fixtures.test.ts — proves the harness works end-to-end (SP-q50.1)
 *
 * Runs the two hand-written fixture implementations
 * (test/fixtures/impl/good.mjs, cheating.mjs) against the same small fixture
 * capture (test/fixtures/infer-capture/traffic.json) through the real
 * pipeline: splitPairs -> validateImplementation -> computeGap /
 * scanForHardcoding. This is the point of the phase: a harness that can't
 * tell a real implementation from a memorized lookup table isn't worth
 * building.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImplementation } from './contract.js';
import { splitPairs } from './split.js';
import { validateImplementation } from './harness.js';
import { computeGap, scanForHardcoding, DEFAULT_GAP_THRESHOLD } from './hardcoding.js';
import type { CapturedTraffic } from '../format/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_TRAFFIC = path.join(REPO_ROOT, 'test', 'fixtures', 'infer-capture', 'traffic.json');
const GOOD_IMPL = path.join(REPO_ROOT, 'test', 'fixtures', 'impl', 'good.mjs');
const CHEATING_IMPL = path.join(REPO_ROOT, 'test', 'fixtures', 'impl', 'cheating.mjs');

function loadFixtureEntries(): CapturedTraffic[] {
  return JSON.parse(fs.readFileSync(FIXTURE_TRAFFIC, 'utf8')) as CapturedTraffic[];
}

test('good.mjs: scores well on BOTH train and holdout, with a small gap', async () => {
  const entries = loadFixtureEntries();
  const { train, holdout } = splitPairs(entries);
  assert.ok(holdout.length > 0, 'test setup: fixture must actually produce a holdout set');

  const impl = await loadImplementation(GOOD_IMPL);
  const trainResult = await validateImplementation(impl, train);
  const holdoutResult = await validateImplementation(impl, holdout);

  assert.equal(trainResult.overall.fail, 0, 'good.mjs should not fail any train pair');
  assert.equal(holdoutResult.overall.fail, 0, 'good.mjs should not fail any holdout pair');

  const gap = computeGap(trainResult, holdoutResult);
  assert.equal(gap.verdict, 'ok');
  assert.ok(gap.gap !== null && gap.gap <= DEFAULT_GAP_THRESHOLD, `expected a small gap, got ${gap.gap}`);
});

test('cheating.mjs: scores well on train, collapses on holdout, and is flagged likely_hardcoded', async () => {
  const entries = loadFixtureEntries();
  const { train, holdout } = splitPairs(entries);
  assert.ok(holdout.length > 0, 'test setup: fixture must actually produce a holdout set');

  const impl = await loadImplementation(CHEATING_IMPL);
  const trainResult = await validateImplementation(impl, train);
  const holdoutResult = await validateImplementation(impl, holdout);

  // Scores well on train: it memorized every train pair verbatim.
  assert.equal(trainResult.overall.exact, train.length);
  assert.equal(trainResult.overall.fail, 0);

  // Collapses on holdout: declines everything it wasn't shown.
  assert.equal(holdoutResult.overall.fail, holdout.length);
  assert.equal(holdoutResult.overall.exact, 0);
  assert.equal(holdoutResult.overall.structural, 0);

  const gap = computeGap(trainResult, holdoutResult);
  assert.equal(gap.verdict, 'likely_hardcoded');
  assert.ok(gap.gap !== null && gap.gap > DEFAULT_GAP_THRESHOLD);
});

test('cheating.mjs: caught by the static hardcoding scan', () => {
  const entries = loadFixtureEntries();
  const source = fs.readFileSync(CHEATING_IMPL, 'utf8');
  const responses = entries.map((e) => e.responseBody ?? '');

  const scan = scanForHardcoding(source, responses);
  assert.ok(scan.matchedValues > 0, 'expected at least one distinctive captured value to appear verbatim');
  assert.ok(scan.ratio >= 0.5, `expected a high overlap ratio for a memorized lookup table, got ${scan.ratio}`);
});

test('good.mjs: static-scan overlap is markedly lower than cheating.mjs\'s', () => {
  const entries = loadFixtureEntries();
  const responses = entries.map((e) => e.responseBody ?? '');

  const goodScan = scanForHardcoding(fs.readFileSync(GOOD_IMPL, 'utf8'), responses);
  const cheatingScan = scanForHardcoding(fs.readFileSync(CHEATING_IMPL, 'utf8'), responses);

  assert.ok(
    goodScan.ratio < cheatingScan.ratio,
    `expected good.mjs ratio (${goodScan.ratio}) < cheating.mjs ratio (${cheatingScan.ratio})`
  );
});

test('good.mjs: cross-request statefulness — a POST is visible to a subsequent GET', async () => {
  const impl = await loadImplementation(GOOD_IMPL);
  await impl.reset();

  const created = await impl.handle({
    method: 'POST',
    path: '/api/items',
    query: {},
    headers: {},
    body: JSON.stringify({ name: 'Widget Theta', description: 'Created during the statefulness test' }),
  });
  assert.ok(created);
  assert.equal(created?.status, 201);
  const createdBody = created?.body as { id: number; name: string };
  assert.equal(createdBody.name, 'Widget Theta');

  const fetched = await impl.handle({
    method: 'GET',
    path: `/api/items/${createdBody.id}`,
    query: {},
    headers: {},
    body: undefined,
  });
  assert.ok(fetched);
  assert.equal(fetched?.status, 200);
  const fetchedBody = fetched?.body as { id: number; name: string };
  assert.equal(fetchedBody.id, createdBody.id);
  assert.equal(fetchedBody.name, 'Widget Theta');
});

test('good.mjs: reset() actually clears state created by a prior POST', async () => {
  const impl = await loadImplementation(GOOD_IMPL);
  await impl.reset();

  await impl.handle({
    method: 'POST',
    path: '/api/items',
    query: {},
    headers: {},
    body: JSON.stringify({ name: 'Widget Omega' }),
  });

  await impl.reset();

  const collection = await impl.handle({ method: 'GET', path: '/api/items', query: {}, headers: {}, body: undefined });
  const items = collection?.body as Array<{ name: string }>;
  assert.ok(!items.some((i) => i.name === 'Widget Omega'), 'reset() should have discarded the earlier insert');
});
