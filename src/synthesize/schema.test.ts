import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { inferShape, synthesizeValue, hashSeed, mulberry32 } from './schema.js';
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

test('mulberry32: deterministic sequence for a given seed', () => {
  const rngA = mulberry32(42);
  const rngB = mulberry32(42);
  const seqA = [rngA(), rngA(), rngA()];
  const seqB = [rngB(), rngB(), rngB()];
  assert.deepEqual(seqA, seqB);
});
