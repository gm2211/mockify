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
  /** Deduped, capped set of the whole raw objects observed at this position
   * in the document tree (SP-lsc.4). Synthesis draws one of these as a base
   * and copies its fields over wholesale — rather than sampling each field
   * independently from its own per-key pool — so correlated fields (e.g. a
   * start/end date pair, or an id that only ever appears alongside a
   * matching name) stay coherent in the synthesized output. */
  samples: Record<string, unknown>[];
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
    return { type: 'object', keys, samples: dedupCapped(objects) as Record<string, unknown>[] };
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
// Invariant-pair safety net (SP-lsc.4, direction b)
//
// Whole-object base sampling (below) is the primary fix for correlated
// fields, but a couple of paths still bypass it: the no-samples fallback,
// and a param substitution overwriting one half of a pair (e.g. the request
// touches an id that happens to share a name with one side of a min/max
// pair). fixInvariantPairs() is a cheap post-hoc check that catches the
// common case anyway — well-known field-pair names, both sides parseable as
// the same kind of comparable (date or number) — and swaps them back into
// order rather than leaving an inverted range in the response.
// ---------------------------------------------------------------------------

/** [lower-bound token, upper-bound token], matched as substrings of the
 * normalized (lowercased, separators stripped) key name. */
const INVARIANT_PAIR_TOKENS: Array<[string, string]> = [
  ['start', 'end'],
  ['from', 'to'],
  ['min', 'max'],
  ['createdat', 'updatedat'],
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find same-object key pairs whose names match a known lower/upper token
 * pair (e.g. "startDate"/"endDate", "start_time"/"end_time", "minPrice"/
 * "maxPrice", "createdAt"/"updatedAt") — case-insensitively, ignoring
 * separators. */
function findInvariantPairs(keys: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const key of keys) {
    const norm = normalizeKey(key);
    for (const [lo, hi] of INVARIANT_PAIR_TOKENS) {
      if (!norm.includes(lo)) continue;
      const counterpartNorm = norm.replace(lo, hi);
      const counterpart = keys.find((k) => k !== key && normalizeKey(k) === counterpartNorm);
      if (counterpart) pairs.push([key, counterpart]);
    }
  }
  return pairs;
}

/** A value is "comparable" for invariant-pair purposes if it's a finite
 * number, or a string that parses as a date — the two kinds of pool values
 * these field-name conventions actually hold. */
function comparablePairValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/** Post-fix a synthesized object so well-known lower/upper field pairs
 * (start/end, from/to, min/max, createdAt/updatedAt) never come out
 * inverted — swapping the two values back into order when both parse as the
 * same kind of comparable. Mutates and returns `obj` for convenience. */
export function fixInvariantPairs(obj: Record<string, unknown>): Record<string, unknown> {
  for (const [loKey, hiKey] of findInvariantPairs(Object.keys(obj))) {
    const loVal = comparablePairValue(obj[loKey]);
    const hiVal = comparablePairValue(obj[hiKey]);
    if (loVal === null || hiVal === null) continue;
    if (loVal > hiVal) {
      const tmp = obj[loKey];
      obj[loKey] = obj[hiKey];
      obj[hiKey] = tmp;
    }
  }
  return obj;
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

/** Copy `value` (a piece of one whole observed base object) into the
 * synthesized output, recursing into nested objects/arrays so the whole
 * subtree stays exactly as it was jointly observed, and applying param
 * substitution at every key along the way (a nested id can match a request
 * param just as a top-level one can). Primitives are returned verbatim —
 * no re-sampling from a pool, which is the whole point: every field in the
 * output traces back to one coherent observed object. */
function copyFromBase(value: unknown, shape: Shape, ctx: SynthContext): unknown {
  if (shape.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return synthesizeObjectFromBase(shape, value as Record<string, unknown>, ctx);
  }
  if (shape.type === 'array' && Array.isArray(value)) {
    return value.map((el) => copyFromBase(el, shape.element, ctx));
  }
  return value;
}

/** Build a synthesized object from one chosen whole observed `base`,
 * substituting request-param matches per key and otherwise copying the
 * base's own fields verbatim (via copyFromBase). A key present in the
 * shape's merged key set (pooled across *all* observed samples) but absent
 * from this particular base is either omitted (if optional — mirroring
 * this base's own shape) or falls back to independent per-field synthesis
 * (if required, which should be rare: a required key is present in every
 * sample by definition, this base included). */
function synthesizeObjectFromBase(
  shape: ObjectShape,
  base: Record<string, unknown>,
  ctx: SynthContext
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, { shape: valueShape, optional }] of Object.entries(shape.keys)) {
    const matched = paramForKey(key, ctx.params);
    if (matched) {
      result[key] = coerceToObservedType(matched.value, valueShape);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      result[key] = copyFromBase(base[key], valueShape, ctx);
      continue;
    }
    if (!optional) {
      result[key] = synthesizeValue(valueShape, ctx, key);
    }
    // else: optional and absent from this base — omit, mirroring the base.
  }
  return fixInvariantPairs(result);
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
      // Whole-object base sampling (SP-lsc.4): draw one whole observed
      // object and copy its fields over, substituting only keys that match
      // a request param/id. Sampling each field independently from its own
      // pool (the old behavior, still used as a fallback below) breaks
      // intra-object relationships — e.g. a synthesized {start, end} pair
      // could mix a "start" from one booking with an "end" from an earlier
      // one, producing end < start, which no real backend would emit.
      if (shape.samples && shape.samples.length > 0) {
        const base = pick(rng, shape.samples);
        return synthesizeObjectFromBase(shape, base, ctx);
      }
      // Fallback for a shape with no captured whole-object samples (should
      // not normally happen — every object-typed shape is built from at
      // least one observed sample — but kept for robustness, e.g. a
      // hand-built Shape or a pre-SP-lsc.4 index.json missing `samples`).
      const result: Record<string, unknown> = {};
      for (const [key, { shape: valueShape, optional }] of Object.entries(shape.keys)) {
        if (optional && rng() < 0.15) continue; // occasionally omit, mirroring the capture
        result[key] = synthesizeValue(valueShape, ctx, key);
      }
      return fixInvariantPairs(result);
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
