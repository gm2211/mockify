import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_DELAY_MS,
  DEFAULT_LATENCY_OPTIONS,
  computeRawDurationMs,
  scaleDelayMs,
  resolveDelayMs,
  computeEntryDelayMs,
  median,
  buildTemplateLatencyIndex,
  resolveSyntheticDelayMs,
  delayFor,
  type LatencyOptions,
} from './latency.js';
import type { CapturedTraffic } from './format/types.js';

function entry(overrides: Partial<CapturedTraffic> = {}): CapturedTraffic {
  return {
    url: 'https://example.com/api/widgets',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: 1000,
    responseBody: '{}',
    ...overrides,
  };
}

const ENABLED: LatencyOptions = { enabled: true, speed: 1 };
const DISABLED: LatencyOptions = { enabled: false, speed: 1 };

// ---------------------------------------------------------------------------
// computeRawDurationMs — duration extraction, missing/invalid timestamps
// ---------------------------------------------------------------------------

test('computeRawDurationMs: tsEnd - tsStart for a normal pair', () => {
  assert.equal(computeRawDurationMs(entry({ tsStart: 1000, tsEnd: 1250 })), 250);
});

test('computeRawDurationMs: zero duration is a valid (not missing) value', () => {
  assert.equal(computeRawDurationMs(entry({ tsStart: 1000, tsEnd: 1000 })), 0);
});

test('computeRawDurationMs: missing tsStart/tsEnd → null (pre-SP-lsc.8 captures)', () => {
  assert.equal(computeRawDurationMs(entry({})), null);
  assert.equal(computeRawDurationMs(entry({ tsStart: 1000 })), null);
  assert.equal(computeRawDurationMs(entry({ tsEnd: 1000 })), null);
});

test('computeRawDurationMs: tsEnd before tsStart (clock skew / bad fixture data) → null', () => {
  assert.equal(computeRawDurationMs(entry({ tsStart: 2000, tsEnd: 1000 })), null);
});

test('computeRawDurationMs: non-finite timestamps → null', () => {
  assert.equal(computeRawDurationMs(entry({ tsStart: NaN, tsEnd: 1000 })), null);
  assert.equal(computeRawDurationMs(entry({ tsStart: 1000, tsEnd: Infinity })), null);
});

test('computeRawDurationMs: non-number timestamps (hand-edited fixture) → null', () => {
  assert.equal(
    computeRawDurationMs(entry({ tsStart: '1000' as unknown as number, tsEnd: 1200 })),
    null
  );
});

// ---------------------------------------------------------------------------
// scaleDelayMs — speed scaling math + the direction contract
// ---------------------------------------------------------------------------

test('scaleDelayMs: speed 1 replays the observed duration unchanged', () => {
  assert.equal(scaleDelayMs(500, 1), 500);
});

test('scaleDelayMs: speed 2 halves the delay (twice as fast)', () => {
  assert.equal(scaleDelayMs(500, 2), 250);
});

test('scaleDelayMs: speed 0.5 doubles the delay (half as fast / slower)', () => {
  assert.equal(scaleDelayMs(500, 0.5), 1000);
});

test('scaleDelayMs: caps at MAX_DELAY_MS regardless of how large the scaled value would be', () => {
  assert.equal(scaleDelayMs(1_000_000, 1), MAX_DELAY_MS);
  assert.equal(scaleDelayMs(100_000, 0.001), MAX_DELAY_MS);
});

test('scaleDelayMs: a non-positive or non-finite speed degrades to 0 rather than throwing/NaN', () => {
  assert.equal(scaleDelayMs(500, 0), 0);
  assert.equal(scaleDelayMs(500, -1), 0);
  assert.equal(scaleDelayMs(500, NaN), 0);
  assert.equal(scaleDelayMs(500, Infinity), 0);
});

// ---------------------------------------------------------------------------
// resolveDelayMs / computeEntryDelayMs — disabled + missing-data fallbacks
// ---------------------------------------------------------------------------

test('resolveDelayMs: disabled options always resolve to 0, even with a known duration', () => {
  assert.equal(resolveDelayMs(500, DISABLED), 0);
});

test('resolveDelayMs: enabled + null duration (no data) resolves to 0', () => {
  assert.equal(resolveDelayMs(null, ENABLED), 0);
});

test('resolveDelayMs: enabled + known duration scales normally', () => {
  assert.equal(resolveDelayMs(500, { enabled: true, speed: 2 }), 250);
});

test('computeEntryDelayMs: --no-latency (disabled) → 0 delay regardless of the entry', () => {
  assert.equal(computeEntryDelayMs(entry({ tsStart: 0, tsEnd: 5000 }), DISABLED), 0);
});

test('computeEntryDelayMs: enabled + a normal entry replays the scaled observed duration', () => {
  assert.equal(computeEntryDelayMs(entry({ tsStart: 1000, tsEnd: 1300 }), ENABLED), 300);
  assert.equal(computeEntryDelayMs(entry({ tsStart: 1000, tsEnd: 1300 }), { enabled: true, speed: 3 }), 100);
});

test('computeEntryDelayMs: an entry with missing timestamps never delays, even when enabled', () => {
  assert.equal(computeEntryDelayMs(entry({}), ENABLED), 0);
});

test('DEFAULT_LATENCY_OPTIONS is disabled — instant responses unless a caller opts in', () => {
  assert.equal(DEFAULT_LATENCY_OPTIONS.enabled, false);
  assert.equal(computeEntryDelayMs(entry({ tsStart: 0, tsEnd: 10_000 }), DEFAULT_LATENCY_OPTIONS), 0);
});

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

test('median: empty array → null', () => {
  assert.equal(median([]), null);
});

test('median: odd-length array → the middle value', () => {
  assert.equal(median([300, 100, 200]), 200);
});

test('median: even-length array → the average of the two middle values', () => {
  assert.equal(median([100, 200, 300, 400]), 250);
});

test('median: a single value → itself', () => {
  assert.equal(median([42]), 42);
});

// ---------------------------------------------------------------------------
// buildTemplateLatencyIndex / resolveSyntheticDelayMs — per-template stats
// for the synthetic tier, with overall-median + zero fallbacks
// ---------------------------------------------------------------------------

const ROOM_TEMPLATE = { method: 'GET', pathTemplate: '/api/room/{p2}', regex: '^/api/room/([^/]+)$' };
const WIDGET_TEMPLATE = { method: 'GET', pathTemplate: '/api/widget/{p2}', regex: '^/api/widget/([^/]+)$' };

test('buildTemplateLatencyIndex: per-template median from entries matching that template', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://example.com/api/room/1', tsStart: 0, tsEnd: 100 }),
    entry({ url: 'https://example.com/api/room/2', tsStart: 0, tsEnd: 300 }),
    entry({ url: 'https://example.com/api/room/3', tsStart: 0, tsEnd: 200 }),
  ];
  const index = buildTemplateLatencyIndex(entries, [ROOM_TEMPLATE]);
  assert.equal(index.perTemplateMedianMs.get('GET /api/room/{p2}'), 200);
  assert.equal(index.overallMedianMs, 200);
});

test('buildTemplateLatencyIndex: entries are only attributed to the template they match (method + path)', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://example.com/api/room/1', tsStart: 0, tsEnd: 100 }),
    entry({ url: 'https://example.com/api/widget/1', tsStart: 0, tsEnd: 900 }),
  ];
  const index = buildTemplateLatencyIndex(entries, [ROOM_TEMPLATE, WIDGET_TEMPLATE]);
  assert.equal(index.perTemplateMedianMs.get('GET /api/room/{p2}'), 100);
  assert.equal(index.perTemplateMedianMs.get('GET /api/widget/{p2}'), 900);
  assert.equal(index.overallMedianMs, 500);
});

test('buildTemplateLatencyIndex: entries with no valid duration are excluded from every stat', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://example.com/api/room/1' }), // no tsStart/tsEnd
    entry({ url: 'https://example.com/api/room/2', tsStart: 0, tsEnd: 100 }),
  ];
  const index = buildTemplateLatencyIndex(entries, [ROOM_TEMPLATE]);
  assert.equal(index.perTemplateMedianMs.get('GET /api/room/{p2}'), 100);
  assert.equal(index.overallMedianMs, 100);
});

test('buildTemplateLatencyIndex: a capture with no valid timestamps anywhere → overallMedianMs null, no per-template entries', () => {
  const entries: CapturedTraffic[] = [entry({ url: 'https://example.com/api/room/1' })];
  const index = buildTemplateLatencyIndex(entries, [ROOM_TEMPLATE]);
  assert.equal(index.overallMedianMs, null);
  assert.equal(index.perTemplateMedianMs.has('GET /api/room/{p2}'), false);
});

test('resolveSyntheticDelayMs: uses the template median when available', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://example.com/api/room/1', tsStart: 0, tsEnd: 400 }),
  ];
  const index = buildTemplateLatencyIndex(entries, [ROOM_TEMPLATE]);
  assert.equal(resolveSyntheticDelayMs(ROOM_TEMPLATE, index, ENABLED), 400);
  assert.equal(resolveSyntheticDelayMs(ROOM_TEMPLATE, index, { enabled: true, speed: 4 }), 100);
});

test('resolveSyntheticDelayMs: falls back to the overall median for a template with no timing data of its own', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://example.com/api/widget/1', tsStart: 0, tsEnd: 600 }),
  ];
  // ROOM_TEMPLATE has zero matching entries — no per-template stat exists —
  // but the overall median (from the widget entry) is still available.
  const index = buildTemplateLatencyIndex(entries, [ROOM_TEMPLATE, WIDGET_TEMPLATE]);
  assert.equal(resolveSyntheticDelayMs(ROOM_TEMPLATE, index, ENABLED), 600);
});

test('resolveSyntheticDelayMs: falls back to 0 when neither a per-template nor an overall median exists', () => {
  const index = buildTemplateLatencyIndex([], [ROOM_TEMPLATE]);
  assert.equal(resolveSyntheticDelayMs(ROOM_TEMPLATE, index, ENABLED), 0);
});

test('resolveSyntheticDelayMs: disabled options resolve to 0 even with template data present', () => {
  const entries: CapturedTraffic[] = [
    entry({ url: 'https://example.com/api/room/1', tsStart: 0, tsEnd: 400 }),
  ];
  const index = buildTemplateLatencyIndex(entries, [ROOM_TEMPLATE]);
  assert.equal(resolveSyntheticDelayMs(ROOM_TEMPLATE, index, DISABLED), 0);
});

// ---------------------------------------------------------------------------
// delayFor — real (but tiny) delays, since this is the one function with an
// actual setTimeout side effect
// ---------------------------------------------------------------------------

test('delayFor: resolves immediately for 0 or negative ms (no timer scheduled)', async () => {
  const start = Date.now();
  await delayFor(0);
  await delayFor(-5);
  assert.ok(Date.now() - start < 50, 'expected delayFor(0/-5) to resolve near-instantly');
});

test('delayFor: actually waits roughly the requested time for a small positive value', async () => {
  const start = Date.now();
  await delayFor(20);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15, `expected at least ~20ms to have elapsed, got ${elapsed}ms`);
});
