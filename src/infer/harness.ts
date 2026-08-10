/**
 * src/infer/harness.ts — the validation harness (SP-q50.1)
 *
 * Runs a loaded implementation (src/infer/contract.ts) against a set of
 * recorded request/response pairs and grades each one. This is the
 * measuring instrument the epic (SP-qd4) is built around: nothing here
 * generates a response — it only judges whether a *given* implementation's
 * answers plausibly match what was recorded.
 *
 * -- Grading, not pass/fail ---------------------------------------------------
 * Exact body equality is too strict: real captures legitimately vary
 * (autoincrement ids, timestamps, request-scoped tokens), so an
 * implementation that reconstructs the right *kind* of answer would
 * otherwise be graded identically to one that's simply broken. Shape-only
 * comparison is too weak: an implementation that always returns
 * `{ id: 0, name: '' }` would pass every check. Four grades, from strongest
 * to weakest evidence of a working implementation:
 *
 *   exact       — status matches AND the body deep-equals the recorded body
 *                 (after JSON-parsing both sides where possible).
 *   structural  — status matches AND the body has the same shape as
 *                 recorded: same object keys (recursively, order-
 *                 independent), same JS types per key, and for arrays: not
 *                 empty when the recorded array wasn't empty either.
 *   status_only — status matches but the body shape differs.
 *   fail        — status differs, handle() threw, or handle() returned null
 *                 (an explicit decline — treated the same as a failure,
 *                 since the implementation didn't even attempt the route).
 */

import * as util from 'node:util';
import type { CapturedTraffic } from '../format/types.js';
import { inferTemplateGroups } from '../synthesize/templates.js';
import type { HandleRequest, HandleResponse, Implementation } from './contract.js';

export type Grade = 'exact' | 'structural' | 'status_only' | 'fail';

const GRADE_ORDER: Grade[] = ['exact', 'structural', 'status_only', 'fail'];

function emptyGradeCounts(): Record<Grade, number> {
  return { exact: 0, structural: 0, status_only: 0, fail: 0 };
}

export interface PairResult {
  entry: CapturedTraffic;
  grade: Grade;
  /** Set for status_only/fail grades — a short human-readable reason. */
  detail?: string;
}

export interface TemplateBreakdown {
  method: string;
  pathTemplate: string;
  pairs: number;
  grades: Record<Grade, number>;
}

export interface ValidationResult {
  total: number;
  overall: Record<Grade, number>;
  perTemplate: TemplateBreakdown[];
  results: PairResult[];
}

/** Label used in perTemplate for pairs that don't belong to any inferred
 * endpoint template (see split.ts UNGROUPED_TEMPLATE — same idea here). */
const UNGROUPED_TEMPLATE = '(ungrouped)';

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

/** Translate a recorded CapturedTraffic entry into the HandleRequest shape
 * handle() receives. CapturedTraffic doesn't retain per-request headers
 * (see src/format/types.ts), so `headers` is always {} here — see the
 * contract's doc comment for why that's an accepted limitation today. */
function toHandleRequest(entry: CapturedTraffic): HandleRequest {
  let pathname = entry.url;
  const query: Record<string, string> = {};
  try {
    const u = new URL(entry.url);
    pathname = u.pathname;
    for (const [k, v] of u.searchParams) query[k] = v;
  } catch {
    // Leave pathname as the raw url string — the implementation will fail
    // to match it, which is correct: an unparseable URL was never a valid
    // route to begin with.
  }
  return {
    method: entry.method.toUpperCase(),
    path: pathname,
    query,
    headers: {},
    body: entry.postData ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Body comparison
// ---------------------------------------------------------------------------

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Same object keys (recursively), same types, arrays non-empty where the
 * recorded array was non-empty. See module doc for why this grade exists. */
function sameShape(recorded: unknown, actual: unknown): boolean {
  const rt = jsType(recorded);
  const at = jsType(actual);
  if (rt !== at) return false;

  if (rt === 'array') {
    const rArr = recorded as unknown[];
    const aArr = actual as unknown[];
    if (rArr.length > 0 && aArr.length === 0) return false;
    if (rArr.length === 0 || aArr.length === 0) return true;
    // Heterogeneous arrays are rare in captured JSON APIs; comparing the
    // first element's shape is a good-enough proxy without requiring every
    // element to line up combinatorially.
    return sameShape(rArr[0], aArr[0]);
  }

  if (rt === 'object') {
    const rObj = recorded as Record<string, unknown>;
    const aObj = actual as Record<string, unknown>;
    const rKeys = Object.keys(rObj).sort();
    const aKeys = Object.keys(aObj).sort();
    if (rKeys.length !== aKeys.length) return false;
    for (let i = 0; i < rKeys.length; i++) {
      if (rKeys[i] !== aKeys[i]) return false;
    }
    return rKeys.every((k) => sameShape(rObj[k], aObj[k]));
  }

  return true; // primitive types already matched above
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

async function gradeOne(impl: Implementation, entry: CapturedTraffic): Promise<PairResult> {
  const req = toHandleRequest(entry);

  let response: HandleResponse | null;
  try {
    response = await impl.handle(req);
  } catch (err) {
    return {
      entry,
      grade: 'fail',
      detail: `handler threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response === null || response === undefined) {
    return { entry, grade: 'fail', detail: 'handler declined (returned null)' };
  }

  if (response.status !== entry.status) {
    return {
      entry,
      grade: 'fail',
      detail: `status mismatch: expected ${entry.status}, got ${response.status}`,
    };
  }

  const recordedBody = parseJsonMaybe(entry.responseBody ?? '');
  const actualBody = parseJsonMaybe(response.body);

  if (util.isDeepStrictEqual(recordedBody, actualBody)) {
    return { entry, grade: 'exact' };
  }
  if (sameShape(recordedBody, actualBody)) {
    return { entry, grade: 'structural' };
  }
  return { entry, grade: 'status_only', detail: 'status matched but body shape differs' };
}

/** Run `impl` against every pair in `pairs`, grading each one. Calls
 * `impl.reset()` exactly once, before the first pair — this is "one full
 * run": callers doing a train/holdout comparison call this twice (once per
 * set), each call getting its own reset() so state from one run never
 * leaks into the other. Within a single call, state DOES persist across
 * pairs in order — that's what makes cross-request statefulness (e.g. POST
 * an item, then GET it back) observable at all. */
export async function validateImplementation(
  impl: Implementation,
  pairs: CapturedTraffic[]
): Promise<ValidationResult> {
  await impl.reset();

  const results: PairResult[] = [];
  for (const entry of pairs) {
    results.push(await gradeOne(impl, entry));
  }

  const overall = emptyGradeCounts();
  for (const r of results) overall[r.grade]++;

  const gradeByEntry = new Map<CapturedTraffic, Grade>();
  for (const r of results) gradeByEntry.set(r.entry, r.grade);

  const groups = inferTemplateGroups(pairs);
  const perTemplate: TemplateBreakdown[] = [];
  const grouped = new Set<CapturedTraffic>();

  for (const { template, entries: groupEntries } of groups) {
    const grades = emptyGradeCounts();
    for (const entry of groupEntries) {
      grouped.add(entry);
      const grade = gradeByEntry.get(entry);
      if (grade) grades[grade]++;
    }
    perTemplate.push({
      method: template.method,
      pathTemplate: template.pathTemplate,
      pairs: groupEntries.length,
      grades,
    });
  }

  const ungrouped = pairs.filter((entry) => !grouped.has(entry));
  if (ungrouped.length > 0) {
    const grades = emptyGradeCounts();
    for (const entry of ungrouped) {
      const grade = gradeByEntry.get(entry);
      if (grade) grades[grade]++;
    }
    perTemplate.push({ method: '*', pathTemplate: UNGROUPED_TEMPLATE, pairs: ungrouped.length, grades });
  }

  return { total: pairs.length, overall, perTemplate, results };
}

export { GRADE_ORDER };
