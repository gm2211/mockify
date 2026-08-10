import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGap, scanForHardcoding, DEFAULT_GAP_THRESHOLD } from './hardcoding.js';
import type { ValidationResult, Grade } from './harness.js';

function fakeResult(overall: Record<Grade, number>): ValidationResult {
  const total = overall.exact + overall.structural + overall.status_only + overall.fail;
  return { total, overall, perTemplate: [], results: [] };
}

test('computeGap: a small gap between similar train/holdout rates is "ok"', () => {
  const train = fakeResult({ exact: 8, structural: 1, status_only: 1, fail: 0 }); // 90%
  const holdout = fakeResult({ exact: 3, structural: 1, status_only: 0, fail: 1 }); // 80%
  const gap = computeGap(train, holdout);
  assert.equal(gap.verdict, 'ok');
  assert.ok(gap.gap !== null && gap.gap < DEFAULT_GAP_THRESHOLD);
});

test('computeGap: a large train/holdout drop is "likely_hardcoded"', () => {
  const train = fakeResult({ exact: 10, structural: 0, status_only: 0, fail: 0 }); // 100%
  const holdout = fakeResult({ exact: 0, structural: 0, status_only: 0, fail: 5 }); // 0%
  const gap = computeGap(train, holdout);
  assert.equal(gap.verdict, 'likely_hardcoded');
  assert.equal(gap.gap, 1);
});

test('computeGap: exactly at the threshold is not flagged (verdict flips on ">", not ">=")', () => {
  const train = fakeResult({ exact: 100, structural: 0, status_only: 0, fail: 0 }); // 100%
  const holdout = fakeResult({ exact: 75, structural: 0, status_only: 0, fail: 25 }); // 75% -> gap exactly 0.25
  const gap = computeGap(train, holdout);
  assert.ok(Math.abs((gap.gap ?? 0) - DEFAULT_GAP_THRESHOLD) < 1e-9);
  assert.equal(gap.verdict, 'ok');
});

test('computeGap: an empty holdout set reports insufficient_holdout, not a false verdict', () => {
  const train = fakeResult({ exact: 5, structural: 0, status_only: 0, fail: 0 });
  const holdout = fakeResult({ exact: 0, structural: 0, status_only: 0, fail: 0 });
  const gap = computeGap(train, holdout);
  assert.equal(gap.verdict, 'insufficient_holdout');
  assert.equal(gap.holdoutRate, null);
  assert.equal(gap.gap, null);
});

test('scanForHardcoding: flags a distinctive captured string embedded verbatim in source', () => {
  const responses = ['{"id":1,"description":"A sturdy alpha-grade widget rated for industrial vibration testing"}'];
  const source = 'const body = "A sturdy alpha-grade widget rated for industrial vibration testing";';
  const scan = scanForHardcoding(source, responses);
  assert.equal(scan.totalDistinctiveValues, 1);
  assert.equal(scan.matchedValues, 1);
  assert.equal(scan.ratio, 1);
  assert.ok(scan.evidence.some((e) => e.value.includes('alpha-grade')));
});

test('scanForHardcoding: skips short values and common stopwords', () => {
  const responses = ['{"id":1,"status":"ok","count":3}'];
  const source = 'function handle() { return { status: "ok", id: 1, count: 3 }; }';
  const scan = scanForHardcoding(source, responses);
  assert.equal(scan.totalDistinctiveValues, 0);
  assert.equal(scan.matchedValues, 0);
  assert.equal(scan.ratio, 0);
});

test('scanForHardcoding: skips numbers under ~4 digits but flags larger ones', () => {
  const responses = ['{"smallId":42,"trackingCode":123456789}'];
  const source = 'const trackingCode = 123456789;';
  const scan = scanForHardcoding(source, responses);
  assert.equal(scan.totalDistinctiveValues, 1); // only the 9-digit number qualifies
  assert.equal(scan.matchedValues, 1);
  assert.equal(scan.evidence[0].value, '123456789');
});

test('scanForHardcoding: ratio reflects partial overlap, not a boolean', () => {
  const responses = [
    '{"a":"a genuinely distinctive descriptive phrase one"}',
    '{"b":"a genuinely distinctive descriptive phrase two"}',
  ];
  const source = 'const x = "a genuinely distinctive descriptive phrase one";'; // only one of the two appears
  const scan = scanForHardcoding(source, responses);
  assert.equal(scan.totalDistinctiveValues, 2);
  assert.equal(scan.matchedValues, 1);
  assert.equal(scan.ratio, 0.5);
});

test('scanForHardcoding: non-JSON response bodies are skipped rather than crashing', () => {
  const responses = ['<html><body>not json</body></html>'];
  const source = 'const x = "<html><body>not json</body></html>";';
  const scan = scanForHardcoding(source, responses);
  assert.equal(scan.totalDistinctiveValues, 0);
});

test('scanForHardcoding: counts multiple occurrences of the same value', () => {
  const responses = ['{"a":"a repeated distinctive phrase for counting"}'];
  const source =
    'const x = "a repeated distinctive phrase for counting"; ' +
    'const y = "a repeated distinctive phrase for counting";';
  const scan = scanForHardcoding(source, responses);
  assert.equal(scan.evidence[0].occurrences, 2);
});
