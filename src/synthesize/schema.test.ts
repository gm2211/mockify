import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { inferShape, synthesizeValue, hashSeed, mulberry32, fixInvariantPairs } from './schema.js';
import type { ResolvedParam, SynthContext } from './schema.js';

test('inferShape: merges object keys across samples, marking sometimes-missing keys optional', () => {
  const bodies = [
    JSON.stringify({ id: 1, name: 'Sprocket', extra: 'x' }),
    JSON.stringify({ id: 2, name: 'Cog' }),
    JSON.stringify({ id: 3, name: 'Gear' }),
  ];
  const shape = inferShape(bodies);
  assert.equal(shape.type, 'object');
  if (shape.type !== 'object') return;
  assert.equal(shape.keys.id.optional, false);
  assert.equal(shape.keys.name.optional, false);
  assert.equal(shape.keys.extra.optional, true);
  assert.equal(shape.keys.id.shape.type, 'number');
  assert.equal(shape.keys.name.shape.type, 'string');
});

test('inferShape: arrays merge element shape and track an observed length range', () => {
  const bodies = [
    JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }),
    JSON.stringify({ items: [{ id: 3 }] }),
  ];
  const shape = inferShape(bodies);
  assert.equal(shape.type, 'object');
  if (shape.type !== 'object') return;
  const items = shape.keys.items.shape;
  assert.equal(items.type, 'array');
  if (items.type !== 'array') return;
  assert.equal(items.minLength, 1);
  assert.equal(items.maxLength, 2);
  assert.equal(items.element.type, 'object');
});

test('inferShape: non-JSON bodies (e.g. HTML) fall back to a pooled string primitive', () => {
  const bodies = ['<html>one</html>', '<html>two</html>'];
  const shape = inferShape(bodies);
  assert.equal(shape.type, 'string');
  if (shape.type !== 'string') return;
  assert.deepEqual(shape.pool.sort(), bodies.sort());
});

test('inferShape: primitive pools observed values, capped and deduped', () => {
  const bodies = Array.from({ length: 80 }, (_, i) => JSON.stringify(i % 5));
  const shape = inferShape(bodies);
  assert.equal(shape.type, 'number');
  if (shape.type !== 'number') return;
  assert.ok(shape.pool.length <= 50);
  assert.deepEqual([...shape.pool].sort(), [0, 1, 2, 3, 4]);
});

test('synthesizeValue: same seed + path yields identical output on repeated calls', () => {
  const shape = inferShape([
    JSON.stringify({ roomid: 1, roomPrice: 100, type: 'Single' }),
    JSON.stringify({ roomid: 2, roomPrice: 150, type: 'Double' }),
    JSON.stringify({ roomid: 3, roomPrice: 225, type: 'Suite' }),
  ]);
  const params: ResolvedParam[] = [{ name: 'p2', value: '7', resourceNoun: 'room' }];
  const seed = hashSeed('GET /api/room/7');

  const a = synthesizeValue(shape, { params, seed });
  const b = synthesizeValue(shape, { params, seed });
  assert.deepEqual(a, b);
});

test('synthesizeValue: different paths (different seeds) can yield different output', () => {
  const shape = inferShape([
    JSON.stringify({ roomPrice: 100 }),
    JSON.stringify({ roomPrice: 150 }),
    JSON.stringify({ roomPrice: 225 }),
    JSON.stringify({ roomPrice: 300 }),
  ]);
  const results = new Set<string>();
  for (const path of ['/api/room/1', '/api/room/2', '/api/room/3', '/api/room/4', '/api/room/5']) {
    const ctx: SynthContext = { params: [], seed: hashSeed(`GET ${path}`) };
    results.add(JSON.stringify(synthesizeValue(shape, ctx)));
  }
  assert.ok(results.size > 1, 'expected at least some variation across different seeds');
});

test('synthesizeValue: string fields draw only from the observed pool', () => {
  const shape = inferShape([
    JSON.stringify({ type: 'Single' }),
    JSON.stringify({ type: 'Double' }),
    JSON.stringify({ type: 'Suite' }),
  ]);
  const pool = new Set(['Single', 'Double', 'Suite']);
  for (let i = 0; i < 20; i++) {
    const ctx: SynthContext = { params: [], seed: hashSeed(`probe-${i}`) };
    const value = synthesizeValue(shape, ctx) as { type: string };
    assert.ok(pool.has(value.type), `${value.type} should come from the observed pool`);
  }
});

test('synthesizeValue: param substitution sets the id field to the request param, coerced to the observed type', () => {
  const shape = inferShape([
    JSON.stringify({ roomid: 1, roomName: '101' }),
    JSON.stringify({ roomid: 2, roomName: '102' }),
    JSON.stringify({ roomid: 3, roomName: '103' }),
  ]);
  const params: ResolvedParam[] = [{ name: 'p2', value: '7', resourceNoun: 'room' }];
  const ctx: SynthContext = { params, seed: hashSeed('GET /api/room/7') };
  const value = synthesizeValue(shape, ctx) as { roomid: unknown };
  assert.equal(value.roomid, 7);
  assert.equal(typeof value.roomid, 'number');
});

test('synthesizeValue: bare "id" key matches the sole path param', () => {
  const shape = inferShape([JSON.stringify({ id: 1 }), JSON.stringify({ id: 2 })]);
  const params: ResolvedParam[] = [{ name: 'p1', value: '99', resourceNoun: 'order' }];
  const ctx: SynthContext = { params, seed: hashSeed('GET /api/order/99') };
  const value = synthesizeValue(shape, ctx) as { id: unknown };
  assert.equal(value.id, 99);
});

// ---------------------------------------------------------------------------
// SP-lsc.4 — whole-object base sampling preserves intra-object invariants.
//
// Real-world bug: GET /api/report/room/9 synthesized start=2026-04-11 with
// end=2026-02-04 (end before start) because the old implementation sampled
// each field independently from its own observed pool, so "start" from one
// captured booking could pair with "end" from an unrelated one. No real
// backend emits an inverted range, and range-validating consumers broke on
// it.
// ---------------------------------------------------------------------------

test('SP-lsc.4: synthesized start/end never violates start<=end (demo-grok bug class)', () => {
  const bodies = [
    JSON.stringify({ roomid: 1, start: '2026-01-01', end: '2026-01-05' }),
    JSON.stringify({ roomid: 2, start: '2026-02-10', end: '2026-02-20' }),
    JSON.stringify({ roomid: 3, start: '2026-04-11', end: '2026-04-15' }),
    JSON.stringify({ roomid: 4, start: '2026-06-01', end: '2026-06-02' }),
    JSON.stringify({ roomid: 5, start: '2026-02-04', end: '2026-02-06' }),
  ];
  const shape = inferShape(bodies);
  const params: ResolvedParam[] = [{ name: 'p3', value: '9', resourceNoun: 'room' }];

  for (let i = 0; i < 300; i++) {
    const ctx: SynthContext = { params, seed: hashSeed(`GET /api/report/room/9#${i}`) };
    const value = synthesizeValue(shape, ctx) as { start: string; end: string };
    assert.ok(
      Date.parse(value.start) <= Date.parse(value.end),
      `expected start (${value.start}) <= end (${value.end})`
    );
  }
});

test('SP-lsc.4: whole-object coherence — every synthesized object matches one observed base exactly (no params to substitute)', () => {
  const samples: Array<{ id: number; category: string; label: string }> = [
    { id: 1, category: 'A', label: 'alpha' },
    { id: 2, category: 'B', label: 'beta' },
    { id: 3, category: 'C', label: 'gamma' },
  ];
  const bodies = samples.map((s) => JSON.stringify(s));
  const shape = inferShape(bodies);

  for (let i = 0; i < 100; i++) {
    const ctx: SynthContext = { params: [], seed: hashSeed(`probe-${i}`) };
    const value = synthesizeValue(shape, ctx) as { id: number; category: string; label: string };
    const matchesSomeSample = samples.some(
      (s) => s.id === value.id && s.category === value.category && s.label === value.label
    );
    assert.ok(matchesSomeSample, `expected ${JSON.stringify(value)} to exactly match one observed sample`);
  }
});

test('SP-lsc.4: whole-object coherence survives id substitution — non-id fields still come from the same base', () => {
  const samples: Array<{ roomid: number; category: string; label: string }> = [
    { roomid: 1, category: 'A', label: 'alpha' },
    { roomid: 2, category: 'B', label: 'beta' },
    { roomid: 3, category: 'C', label: 'gamma' },
  ];
  const bodies = samples.map((s) => JSON.stringify(s));
  const shape = inferShape(bodies);
  const params: ResolvedParam[] = [{ name: 'p2', value: '999', resourceNoun: 'room' }];

  for (let i = 0; i < 100; i++) {
    const ctx: SynthContext = { params, seed: hashSeed(`GET /api/room/999#${i}`) };
    const value = synthesizeValue(shape, ctx) as { roomid: number; category: string; label: string };
    assert.equal(value.roomid, 999, 'the id field should be substituted from the request');
    const matchesSomeSampleModuloId = samples.some(
      (s) => s.category === value.category && s.label === value.label
    );
    assert.ok(
      matchesSomeSampleModuloId,
      `expected {category, label} of ${JSON.stringify(value)} to match one observed base, modulo the substituted id`
    );
  }
});

// ---------------------------------------------------------------------------
// SP-lsc.4 direction (b) — invariant-pair post-fix safety net.
// ---------------------------------------------------------------------------

test('fixInvariantPairs: swaps an inverted start/end date pair back into order', () => {
  const obj = { roomid: 9, start: '2026-04-11', end: '2026-02-04' };
  const fixed = fixInvariantPairs({ ...obj });
  assert.equal(fixed.start, '2026-02-04');
  assert.equal(fixed.end, '2026-04-11');
});

test('fixInvariantPairs: swaps an inverted numeric min/max pair back into order', () => {
  const fixed = fixInvariantPairs({ minPrice: 100, maxPrice: 10 });
  assert.equal(fixed.minPrice, 10);
  assert.equal(fixed.maxPrice, 100);
});

test('fixInvariantPairs: leaves an already-ordered pair untouched', () => {
  const obj = { from: 5, to: 12 };
  const fixed = fixInvariantPairs({ ...obj });
  assert.equal(fixed.from, 5);
  assert.equal(fixed.to, 12);
});

test('fixInvariantPairs: leaves unrelated keys alone (no false-positive pairing)', () => {
  const obj = { minA: 5, maxB: 1, name: 'unchanged' };
  const fixed = fixInvariantPairs({ ...obj });
  assert.deepEqual(fixed, obj);
});

test('fixInvariantPairs: skips a pair when either side is not comparable', () => {
  const obj = { start: 'not-a-date', end: '2026-01-01' };
  const fixed = fixInvariantPairs({ ...obj });
  assert.deepEqual(fixed, obj);
});

test('fixInvariantPairs: matches createdAt/updatedAt case-insensitively', () => {
  const fixed = fixInvariantPairs({ createdAt: '2026-05-01', updatedAt: '2026-01-01' });
  assert.equal(fixed.createdAt, '2026-01-01');
  assert.equal(fixed.updatedAt, '2026-05-01');
});

test('mulberry32: deterministic sequence for a given seed', () => {
  const rngA = mulberry32(42);
  const rngB = mulberry32(42);
  const seqA = [rngA(), rngA(), rngA()];
  const seqB = [rngB(), rngB(), rngB()];
  assert.deepEqual(seqA, seqB);
});
