/**
 * src/synthesize/schema.ts — response shape inference + seeded synthesis
 *
 * inferShape() looks at the JSON bodies observed for one endpoint template
 * and builds a small recursive description of their shape: objects (per-key
 * shape, tracking which keys aren't always present), arrays (a merged
 * element shape + observed length range), and primitives (a deduped pool of
 * observed values, capped so pathological captures can't blow up the
 * synthetic index).
 *
 * synthesizeValue() walks a Shape back into a concrete value, drawing from
 * the observed pools via a seeded PRNG so that a given (method, resolved
 * path) always produces the same synthetic body — determinism matters both
 * for tests and so a client polling the same not-really-there resource
 * twice gets a stable answer instead of a new random one each time.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface ObjectShape {
  type: 'object';
  keys: Record<string, { shape: Shape; optional: boolean }>;
}

export interface ArrayShape {
  type: 'array';
  element: Shape;
  minLength: number;
  maxLength: number;
}

export interface PrimitiveShape {
  type: 'string' | 'number' | 'boolean' | 'null';
  /** Deduped observed values, capped at ~50 entries. */
  pool: unknown[];
}

export interface UnknownShape {
  type: 'unknown';
}

export type Shape = ObjectShape | ArrayShape | PrimitiveShape | UnknownShape;

const POOL_CAP = 50;

function dedupCapped(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of values) {
    const key = JSON.stringify(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= POOL_CAP) break;
  }
  return out;
}

/** Merge a set of already-parsed JSON values (all samples for one position
 * in the document tree) into a single Shape. */
function mergeValues(values: unknown[]): Shape {
  const nonNull = values.filter((v) => v !== null && v !== undefined);

  if (nonNull.length === 0) {
    return { type: 'null', pool: [null] };
  }

  if (nonNull.every((v) => Array.isArray(v))) {
    const arrays = nonNull as unknown[][];
    const lengths = arrays.map((a) => a.length);
    const allElements = arrays.flat();
    return {
      type: 'array',
      element: allElements.length > 0 ? mergeValues(allElements) : { type: 'unknown' },
      minLength: Math.min(...lengths),
      maxLength: Math.max(...lengths),
    };
  }

  if (nonNull.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))) {
    const objects = nonNull as Record<string, unknown>[];
    const allKeys = new Set<string>();
    for (const o of objects) for (const k of Object.keys(o)) allKeys.add(k);

    const keys: ObjectShape['keys'] = {};
    for (const key of allKeys) {
      const present = objects.filter((o) => Object.prototype.hasOwnProperty.call(o, key));
      keys[key] = {
        shape: mergeValues(present.map((o) => o[key])),
        optional: present.length < objects.length,
      };
    }
    return { type: 'object', keys };
  }

  // Primitives (possibly a mix of types across samples — pick the most
  // common typeof and pool only those, which is the common real-world case
  // of a field that's "usually a number" etc.).
  const byType = new Map<string, unknown[]>();
  for (const v of nonNull) {
    const t = typeof v;
    const arr = byType.get(t);
    if (arr) arr.push(v);
    else byType.set(t, [v]);
  }
  let bestType = '';
  let bestValues: unknown[] = [];
  for (const [t, vs] of byType) {
    if (vs.length > bestValues.length) {
      bestType = t;
      bestValues = vs;
    }
  }

  const typeMap: Record<string, PrimitiveShape['type']> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
  };
  const shapeType = typeMap[bestType];
  if (!shapeType) return { type: 'unknown' };

  return { type: shapeType, pool: dedupCapped(bestValues) };
}

/** Infer a Shape from a set of raw response bodies. Bodies that parse as
 * JSON are merged structurally; if none parse (e.g. HTML pages), the whole
 * set is treated as an opaque string primitive pooled from the raw text. */
export function inferShape(bodies: string[]): Shape {
  const parsed: unknown[] = [];
  const raw: string[] = [];
  for (const body of bodies) {
    if (body === null || body === undefined || body === '') {
      raw.push(body ?? '');
      continue;
    }
    try {
      parsed.push(JSON.parse(body));
    } catch {
      raw.push(body);
    }
  }

  if (parsed.length > 0) return mergeValues(parsed);
  return { type: 'string', pool: dedupCapped(raw) };
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic, tiny, good enough for plausible
// mock data (not cryptographic, not statistically rigorous).
// ---------------------------------------------------------------------------

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, pool: T[]): T {
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

// ---------------------------------------------------------------------------
// Param substitution
// ---------------------------------------------------------------------------

/** A path-template variable resolved against a real incoming request. */
export interface ResolvedParam {
  /** Template variable name, e.g. "p2". */
  name: string;
  /** The literal path segment the incoming request supplied, e.g. "7". */
  value: string;
  /** The literal path segment immediately preceding this one (singular
   * resource noun, e.g. "room" for /api/room/{p2}), used to match object
   * keys like "roomid" semantically. */
  resourceNoun: string;
}

function paramForKey(key: string, params: ResolvedParam[]): ResolvedParam | undefined {
  const lower = key.toLowerCase();

  // Bare "id" is unambiguous only when there's exactly one path variable.
  if (params.length === 1 && lower === 'id') return params[0];

  for (const p of params) {
    const noun = p.resourceNoun.toLowerCase();
    // A path segment is often plural ("/api/widgets/7") while the matching
    // response key is singular ("widgetid") — naive singularization (strip
    // a trailing "s") covers the common case without a full inflection
    // library.
    const nounSingular = noun.endsWith('s') && noun.length > 1 ? noun.slice(0, -1) : noun;
    if (lower === `${noun}id` || lower === `${nounSingular}id`) return p;
    if ((key.endsWith('id') || key.endsWith('Id')) && key.length > 2) {
      const prefix = key.slice(0, key.length - 2).toLowerCase();
      if (prefix === noun || prefix === nounSingular) return p;
    }
  }
  return undefined;
}

function coerceToObservedType(value: string, shape: Shape): unknown {
  if (shape.type === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (shape.type === 'boolean') {
    return value === 'true';
  }
  return value;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface SynthContext {
  params: ResolvedParam[];
  /** Seed the PRNG is derived from — pass hashSeed(method + ' ' + resolvedPath). */
  seed: number;
  /** Internal: lazily created and cached across the whole recursive walk so
   * a single seed produces one deterministic sequence, not a fresh one per
   * node. Callers should not set this. */
  rng?: () => number;
}

function rngOf(ctx: SynthContext): () => number {
  if (!ctx.rng) ctx.rng = mulberry32(ctx.seed);
  return ctx.rng;
}

/** Interpolate a plausible new number from an observed numeric pool instead
 * of only ever echoing back an exact previously-seen value. */
function synthesizeNumber(rng: () => number, pool: unknown[]): number {
  const nums = (pool as number[]).filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (nums.length === 0) return 0;
  if (nums.length === 1) return nums[0];

  const sorted = [...nums].sort((a, b) => a - b);
  const allInts = sorted.every((n) => Number.isInteger(n));
  const i = Math.floor(rng() * (sorted.length - 1));
  const lo = sorted[i];
  const hi = sorted[i + 1];
  const frac = rng();
  const value = lo + frac * (hi - lo);
  return allInts ? Math.round(value) : value;
}

/** Draw a concrete value for `shape`, substituting request params where a
 * key semantically matches one (e.g. "roomid" for /api/room/{p2}). */
export function synthesizeValue(shape: Shape, ctx: SynthContext, keyName?: string): unknown {
  const rng = rngOf(ctx);

  if (keyName !== undefined) {
    const matched = paramForKey(keyName, ctx.params);
    if (matched) return coerceToObservedType(matched.value, shape);
  }

  switch (shape.type) {
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const [key, { shape: valueShape, optional }] of Object.entries(shape.keys)) {
        if (optional && rng() < 0.15) continue; // occasionally omit, mirroring the capture
        result[key] = synthesizeValue(valueShape, ctx, key);
      }
      return result;
    }
    case 'array': {
      const span = shape.maxLength - shape.minLength;
      const length = shape.minLength + (span > 0 ? Math.floor(rng() * (span + 1)) : 0);
      const out: unknown[] = [];
      for (let i = 0; i < length; i++) out.push(synthesizeValue(shape.element, ctx));
      return out;
    }
    case 'string':
      return shape.pool.length > 0 ? pick(rng, shape.pool) : '';
    case 'number':
      return synthesizeNumber(rng, shape.pool);
    case 'boolean':
      return shape.pool.length > 0 ? pick(rng, shape.pool) : rng() < 0.5;
    case 'null':
      return null;
    case 'unknown':
    default:
      return null;
  }
}
