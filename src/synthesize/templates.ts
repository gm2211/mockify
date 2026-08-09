/**
 * src/synthesize/templates.ts - endpoint templating
 *
 * Turns a flat list of captured request/response pairs into a small set of
 * *endpoint templates*: `GET /api/room/1`, `GET /api/room/2`, and
 * `GET /api/room/3` collapse into one template, `GET /api/room/{p2}`, so
 * that a request for `/api/room/7` (never recorded) can still be matched
 * and answered.
 *
 * -- The conservative-variable rule --------------------------------------
 * Entries are first grouped by `method` + path segment count. Within a
 * group, each segment *position* is inspected across all entries via
 * positionBucketKey() (below): values that are all-numeric collapse to one
 * bucket, values that are all-UUID collapse to another, values sharing the
 * same simple shape *and* containing a digit run (e.g. "AB12"/"CD34")
 * collapse to a third — and everything else (a plain word like "room" or
 * "count") gets its own singleton bucket, keyed by the literal value
 * itself.
 *
 * A position only becomes a template variable (`{p0}`, `{p1}`, ...) when it
 * has 2+ distinct raw values that ALL collapse to the same bucket. A bare
 * single observed value (`/api/message/10` alone) never reaches 2+ distinct
 * values in the first place, so it stays fully literal — conservative by
 * design, so we don't over-generalize from a single sample.
 *
 * When a position's values span more than one bucket, that means the
 * coarse method+segCount grouping accidentally lumped together requests
 * that don't belong in the same template — either two different endpoint
 * *families* (e.g. `/api/room/*` and `/api/message/*`, both 3 segments,
 * where "room" and "message" are both literal words but different ones),
 * or one real id family sharing a segment count with a sibling literal
 * action route (e.g. `/api/widgets/1..3` alongside `/api/widgets/count`,
 * where "count" doesn't belong in the numeric id bucket).
 * splitByConflicts() partitions the group by bucket key at the first such
 * position and recurses, so the numeric/UUID/shape family stays together
 * as one group (able to become a variable) while each literal outlier
 * peels off into its own group.
 */

import type { CapturedTraffic } from '../format/types.js';

export interface EndpointTemplate {
  method: string;
  /** Human-readable template, e.g. "/api/room/{p2}". */
  pathTemplate: string;
  /** Anchored regex source with one capture group per variable, in path order. */
  regex: string;
  /** Variable names in capture-group order, e.g. ["p2"]. */
  paramNames: string[];
  /** Raw string values observed at each variable position, e.g. { p2: ["1","2","3"] }. */
  observedValues: Record<string, string[]>;
  /** Modal (most common) status among the template's entries. */
  status: number;
  /** Modal (most common) content-type among the template's entries. */
  contentType: string;
  /** How many captured entries contributed to this template. */
  entryCount: number;
}

/** A template plus the raw entries that produced it - used internally by
 * generate.ts for response-shape inference. Not written to disk as-is. */
export interface TemplateGroup {
  template: EndpointTemplate;
  entries: CapturedTraffic[];
}

function safeSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NUMERIC_RE = /^[0-9]+$/;
const NUM_BUCKET = '#NUM';
const UUID_BUCKET = '#UUID';
const SHAPE_BUCKET_PREFIX = '#SHAPE:';

/** Collapse a string to a coarse "shape signature": digit runs -> "9",
 * lowercase runs -> "a", uppercase runs -> "A", everything else kept as-is. */
function shapeSignature(value: string): string {
  return value.replace(/[0-9]+/g, '9').replace(/[a-z]+/g, 'a').replace(/[A-Z]+/g, 'A');
}

/**
 * Classify a single path segment value into the bucket it would join if
 * this position became a template variable. Numeric and UUID values always
 * group together regardless of what else shares the position (so a sibling
 * literal action route like "/api/widgets/count" can't shatter the numeric
 * id family "/api/widgets/1..3" into singletons). A shape containing a
 * digit run (e.g. "AB12") groups with other values sharing that exact
 * shape. Anything else — a plain word with no digits, e.g. "room" or
 * "count" — is its own bucket, keyed by the literal value: two different
 * plain words are never assumed to be the same variable.
 */
function positionBucketKey(value: string): string {
  if (NUMERIC_RE.test(value)) return NUM_BUCKET;
  if (UUID_RE.test(value)) return UUID_BUCKET;
  const sig = shapeSignature(value);
  if (sig.includes('9')) return SHAPE_BUCKET_PREFIX + sig;
  return value;
}

function buildCoarseGroups(entries: CapturedTraffic[]): Map<string, CapturedTraffic[]> {
  const groups = new Map<string, CapturedTraffic[]>();
  for (const entry of entries) {
    const segs = safeSegments(entry.url);
    if (!segs) continue;
    const key = `${entry.method.toUpperCase()} ${segs.length}`;
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

interface WithSegs {
  entry: CapturedTraffic;
  segs: string[];
}

function toWithSegs(entries: CapturedTraffic[]): WithSegs[] {
  return entries
    .map((e) => ({ entry: e, segs: safeSegments(e.url) }))
    .filter((w): w is WithSegs => w.segs !== null);
}

/** Find the lowest-index position (if any) whose values span more than one
 * bucket — i.e. a position that isn't yet a clean literal or a clean
 * variable candidate. */
function findConflictPosition(withSegs: WithSegs[], segCount: number): number | null {
  for (let pos = 0; pos < segCount; pos++) {
    const vals = [...new Set(withSegs.map((w) => w.segs[pos]))];
    if (vals.length <= 1) continue;
    const buckets = new Set(vals.map(positionBucketKey));
    if (buckets.size > 1) return pos;
  }
  return null;
}

/** Recursively split a coarse (method + segCount) group along the first
 * position whose values span more than one bucket, until every remaining
 * position is either uniform or a single clean bucket (a legitimate
 * variable candidate). */
function splitByConflicts(entries: CapturedTraffic[]): CapturedTraffic[][] {
  if (entries.length === 0) return [];
  const withSegs = toWithSegs(entries);
  if (withSegs.length === 0) return [];

  const segCount = withSegs[0].segs.length;
  const splitPos = findConflictPosition(withSegs, segCount);
  if (splitPos === null) return [withSegs.map((w) => w.entry)];

  // Split on ONE conflicting position per level, then recurse with a fresh
  // scan — splitting on every conflicting position at once would
  // over-fragment positions whose conflict only exists because of the
  // family-mixing at THIS position (see module doc comment).
  const buckets = new Map<string, CapturedTraffic[]>();
  for (const w of withSegs) {
    const key = positionBucketKey(w.segs[splitPos]);
    const existing = buckets.get(key);
    if (existing) existing.push(w.entry);
    else buckets.set(key, [w.entry]);
  }

  const result: CapturedTraffic[][] = [];
  for (const bucket of buckets.values()) {
    // Safety valve: a bucket identical in size to the input means splitting
    // made no progress (shouldn't happen since findConflictPosition only
    // fires when 2+ buckets exist, but guards against infinite recursion
    // regardless).
    if (bucket.length === entries.length) {
      result.push(bucket);
      continue;
    }
    result.push(...splitByConflicts(bucket));
  }
  return result;
}

function modal<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function buildTemplate(group: CapturedTraffic[]): TemplateGroup | null {
  if (group.length === 0) return null;

  const withSegs = toWithSegs(group);
  if (withSegs.length === 0) return null;

  const method = withSegs[0].entry.method.toUpperCase();
  const segCount = withSegs[0].segs.length;

  // By construction (splitByConflicts already resolved every conflict),
  // any position left with 2+ distinct values here is a single clean
  // bucket — a legitimate variable.
  const paramPositions: number[] = [];
  for (let pos = 0; pos < segCount; pos++) {
    const vals = [...new Set(withSegs.map((w) => w.segs[pos]))];
    if (vals.length >= 2) paramPositions.push(pos);
  }

  const firstSegs = withSegs[0].segs;
  const templateSegs = firstSegs.map((seg, pos) => (paramPositions.includes(pos) ? `{p${pos}}` : seg));
  const regexSegs = firstSegs.map((seg, pos) =>
    paramPositions.includes(pos) ? '([^/]+)' : escapeRegExp(seg)
  );

  const pathTemplate = '/' + templateSegs.join('/');
  const regex = '^/' + regexSegs.join('/') + '$';
  const paramNames = paramPositions.map((p) => `p${p}`);

  const observedValues: Record<string, string[]> = {};
  for (const pos of paramPositions) {
    observedValues[`p${pos}`] = [...new Set(withSegs.map((w) => w.segs[pos]))];
  }

  const statuses = withSegs.map((w) => w.entry.status);
  const allNon2xx = statuses.every((s) => s < 200 || s >= 300);
  if (allNon2xx) return null;

  const status = modal(statuses);
  const contentType = modal(withSegs.map((w) => w.entry.contentType || ''));

  const template: EndpointTemplate = {
    method,
    pathTemplate,
    regex,
    paramNames,
    observedValues,
    status,
    contentType,
    entryCount: group.length,
  };

  return { template, entries: withSegs.map((w) => w.entry) };
}

/** Internal: templates plus the raw entries behind them, for shape inference. */
export function inferTemplateGroups(entries: CapturedTraffic[]): TemplateGroup[] {
  const coarse = buildCoarseGroups(entries);
  const result: TemplateGroup[] = [];
  for (const groupEntries of coarse.values()) {
    for (const subgroup of splitByConflicts(groupEntries)) {
      const built = buildTemplate(subgroup);
      if (built) result.push(built);
    }
  }
  return result;
}

/** Public API: infer endpoint templates from a flat list of captured traffic. */
export function inferTemplates(entries: CapturedTraffic[]): EndpointTemplate[] {
  return inferTemplateGroups(entries).map((g) => g.template);
}
