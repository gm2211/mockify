/**
 * src/diff/engine.ts — deterministic response diffing (SP-7ow.2 / SP-7ow.3)
 *
 * specify has an agent-driven `replay`/`compare` pair: an LLM fires captured
 * requests at a target (or two targets) and eyeballs the differences. This
 * module is the deterministic replacement mockify uses instead — no agent,
 * no cost, same-process comparison — shared by both `mockify replay
 * --against` (fire captured traffic at one live target, diff against what
 * was recorded) and `mockify compare` (fire the same captured traffic at
 * two live targets, diff one against the other). Both callers reduce to the
 * same problem: given two HTTP responses that are supposed to represent
 * "the same answer", find where they actually disagree.
 *
 * -- What counts as a match -------------------------------------------------
 * Exact byte equality is too strict for real traffic: ids, timestamps, and
 * request-scoped tokens legitimately differ between a capture and a live
 * replay (or between two independently-running targets) without the
 * response being wrong. So this compares structurally — same status, same
 * JSON shape (keys/types, recursively) — while *also* surfacing every
 * concrete value mismatch it finds, filtered down to the ones a human would
 * actually want to see:
 *
 *   - Fields whose recorded/expected value is the redaction placeholder
 *     (src/format/redact.ts's REDACTED, "[REDACTED]") are excluded
 *     entirely — a redacted capture can never match a live value, by
 *     construction, so diffing it would only ever produce noise.
 *   - Fields that look volatile by name (id/uuid/token/timestamp/csrf/
 *     session/...) or by value shape (ISO-8601 timestamp, UUID, plausible
 *     unix-epoch integer) are excluded too, unless `strict: true` is
 *     passed. This is a heuristic, not a guarantee — see
 *     isVolatileFieldName/looksVolatileValue below for the exact rules.
 *
 * Both exclusions are recorded in DiffResult.ignoredFields so a caller (or
 * a human reading --json output) can see what was *not* compared, not just
 * what matched.
 */

import { REDACTED } from '../format/redact.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The half of an HTTP exchange this module cares about — enough to diff a
 * recorded CapturedTraffic entry against a live fetch() Response, or two
 * live fetch() Responses against each other. */
export interface HttpMessage {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

export type MismatchReason = 'type' | 'value' | 'missing' | 'extra' | 'array-length';

export interface FieldMismatch {
  /** jq-ish path into the body, e.g. `$.widgets[0].name`. */
  path: string;
  reason: MismatchReason;
  expected?: unknown;
  actual?: unknown;
}

export interface DiffResult {
  /** True iff status matched AND the body diff found no mismatches. */
  match: boolean;
  statusMatch: boolean;
  expectedStatus: number;
  actualStatus: number;
  /** True iff the body diff found no mismatches (independent of status). */
  structuralMatch: boolean;
  mismatches: FieldMismatch[];
  /** Paths excluded from comparison — redacted or volatile — see module doc. */
  ignoredFields: string[];
}

export interface DiffOptions {
  /** Extra field-name substrings (case-insensitive) treated as volatile, on
   * top of the built-in list — e.g. an app-specific field like
   * `traceparent` or `x-request-nonce` that shows up as a JSON body key. */
  extraVolatileFields?: string[];
  /** Disable redaction/volatile-field tolerance and compare every field
   * verbatim. Mainly for tests that want to assert the raw diff. */
  strict?: boolean;
}

// ---------------------------------------------------------------------------
// Volatility heuristics
// ---------------------------------------------------------------------------

/** Split a camelCase/PascalCase/snake_case/kebab-case field name into its
 * lowercased word tokens — `"createdAt"` and `"created_at"` both become
 * `["created", "at"]`, `"userId"` becomes `["user", "id"]`. Volatility is
 * then judged per-token (see VOLATILE_TOKENS) rather than by substring
 * match against the whole key: a naive `key.includes("id")` would
 * misfire on ordinary fields like `"valid"` or `"width"`, which contain
 * "id" as a substring but aren't identifiers at all. */
function tokenize(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .split('_')
    .filter(Boolean);
}

/** Whole-token matches treated as volatile by default: identifiers,
 * timestamps, and security/session tokens — the categories specify's own
 * agent-driven replay/compare prompts call out as "ignore" (see
 * src/agent/prompts.ts's getReplayPrompt: "Ignore timestamps, session IDs,
 * CSRF tokens"). `"at"` catches the createdAt/updatedAt/deletedAt family
 * once tokenized ("created_at" -> ["created", "at"]). */
const VOLATILE_TOKENS = new Set([
  'id', 'ids', 'uuid', 'guid',
  'timestamp', 'ts', 'at', 'date',
  'expires', 'expiry', 'nonce', 'csrf', 'token', 'session', 'bearer',
  'requestid', 'correlationid', 'traceid', 'etag',
]);

function isVolatileFieldName(key: string, extra: string[]): boolean {
  const tokens = tokenize(key);
  if (tokens.some((t) => VOLATILE_TOKENS.has(t))) return true;
  const joined = tokens.join('');
  return extra.some((e) => {
    const normalizedExtra = e.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalizedExtra.length > 0 && joined.includes(normalizedExtra);
  });
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Value-shape heuristic for volatility, used only when the field name
 * itself didn't already flag it — catches fields with generic names (e.g.
 * `value`, `key`) that nonetheless hold an id/timestamp-shaped value. */
function looksVolatileValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return ISO_DATE_PATTERN.test(value) || UUID_PATTERN.test(value);
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    // A plausible unix epoch, seconds (10 digits) or milliseconds (13
    // digits) — roughly year 2001 through year 2286 in ms, so this only
    // catches numbers that actually look like a modern timestamp rather
    // than any old integer.
    return value > 1_000_000_000 && value < 10_000_000_000_000;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Body parsing + shape comparison
// ---------------------------------------------------------------------------

function parseJsonMaybe(value: string | null): unknown {
  if (value === null || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return `${base}.${key}`;
}

interface ResolvedOptions {
  extraVolatileFields: string[];
  strict: boolean;
}

/** Recursively diff `expected` vs `actual`, pushing findings into
 * `mismatches`/`ignored`. Returns true iff no mismatch was recorded
 * anywhere in this subtree (ignored fields don't count against it). */
function diffValue(
  expected: unknown,
  actual: unknown,
  path: string,
  keyName: string,
  opts: ResolvedOptions,
  mismatches: FieldMismatch[],
  ignored: string[],
): boolean {
  if (expected === REDACTED) {
    ignored.push(path);
    return true;
  }

  if (!opts.strict && (isVolatileFieldName(keyName, opts.extraVolatileFields) || looksVolatileValue(expected))) {
    ignored.push(path);
    return true;
  }

  const et = jsType(expected);
  const at = jsType(actual);

  if (et !== at) {
    mismatches.push({ path, reason: 'type', expected, actual });
    return false;
  }

  if (et === 'array') {
    const eArr = expected as unknown[];
    const aArr = actual as unknown[];
    let ok = true;
    if (eArr.length !== aArr.length) {
      mismatches.push({ path, reason: 'array-length', expected: eArr.length, actual: aArr.length });
      ok = false;
    }
    const n = Math.min(eArr.length, aArr.length);
    for (let i = 0; i < n; i++) {
      if (!diffValue(eArr[i], aArr[i], joinPath(path, i), String(i), opts, mismatches, ignored)) ok = false;
    }
    return ok;
  }

  if (et === 'object') {
    const eObj = expected as Record<string, unknown>;
    const aObj = actual as Record<string, unknown>;
    let ok = true;
    const keys = new Set([...Object.keys(eObj), ...Object.keys(aObj)]);
    for (const key of keys) {
      const childPath = joinPath(path, key);
      const hasExpected = Object.prototype.hasOwnProperty.call(eObj, key);
      const hasActual = Object.prototype.hasOwnProperty.call(aObj, key);

      if (!hasExpected) {
        if (!opts.strict && isVolatileFieldName(key, opts.extraVolatileFields)) {
          ignored.push(childPath);
          continue;
        }
        mismatches.push({ path: childPath, reason: 'extra', actual: aObj[key] });
        ok = false;
        continue;
      }
      if (!hasActual) {
        if (eObj[key] === REDACTED) {
          ignored.push(childPath);
          continue;
        }
        if (!opts.strict && isVolatileFieldName(key, opts.extraVolatileFields)) {
          ignored.push(childPath);
          continue;
        }
        mismatches.push({ path: childPath, reason: 'missing', expected: eObj[key] });
        ok = false;
        continue;
      }
      if (!diffValue(eObj[key], aObj[key], childPath, key, opts, mismatches, ignored)) ok = false;
    }
    return ok;
  }

  // Primitive (string/number/boolean/null) already type-matched above.
  if (expected !== actual) {
    mismatches.push({ path, reason: 'value', expected, actual });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Diff two HTTP responses: status equality plus a recursive body diff with
 * redacted-field exclusion and volatile-field tolerance (see module doc).
 * `expected` is the baseline being compared against — a recorded
 * CapturedTraffic entry for `mockify replay --against`, or the remote
 * target's live response for `mockify compare`. */
export function diffHttpMessages(expected: HttpMessage, actual: HttpMessage, options: DiffOptions = {}): DiffResult {
  const opts: ResolvedOptions = {
    extraVolatileFields: options.extraVolatileFields ?? [],
    strict: options.strict ?? false,
  };

  const statusMatch = expected.status === actual.status;

  const mismatches: FieldMismatch[] = [];
  const ignoredFields: string[] = [];
  const expectedBody = parseJsonMaybe(expected.body);
  const actualBody = parseJsonMaybe(actual.body);
  const structuralMatch = diffValue(expectedBody, actualBody, '$', '', opts, mismatches, ignoredFields);

  return {
    match: statusMatch && structuralMatch,
    statusMatch,
    expectedStatus: expected.status,
    actualStatus: actual.status,
    structuralMatch,
    mismatches,
    ignoredFields,
  };
}

export { isVolatileFieldName, looksVolatileValue };
