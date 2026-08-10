/**
 * src/infer/hardcoding.ts — hardcoding detection (SP-q50.1)
 *
 * This is the critical piece the whole phase exists to support: a good
 * grading harness is worthless if a memorized lookup table can pass it. Two
 * independent signals feed into a verdict; neither alone is trustworthy
 * (a small gap can hide a lookup table that happens to cover holdout too
 * if the split leaked, and a static match can be entirely legitimate reuse
 * of enum values or field names), so both are computed and reported.
 */

import type { ValidationResult } from './harness.js';

// ---------------------------------------------------------------------------
// (a) Held-out gap
// ---------------------------------------------------------------------------

export type GapVerdict = 'likely_hardcoded' | 'ok' | 'insufficient_holdout';

export interface GapResult {
  /** Combined (exact + structural) pass rate on train, 0..1. */
  trainRate: number;
  /** Combined (exact + structural) pass rate on holdout, 0..1, or null when
   * the holdout set was empty (nothing to compute a rate from). */
  holdoutRate: number | null;
  /** trainRate - holdoutRate, or null when holdoutRate is null. */
  gap: number | null;
  verdict: GapVerdict;
  /** The gap threshold used to produce `verdict`, for display purposes. */
  threshold: number;
}

/**
 * Threshold chosen judgmentally, not derived: a generalizing implementation
 * (a real routing + data model, even an imperfect one) should perform
 * similarly regardless of which specific ids/params it's asked about, so
 * its train/holdout gap should be small — a few percentage points of noise
 * at most on a small capture. A memorized request->response table, by
 * construction, scores ~100% on requests it was shown (train) and collapses
 * toward 0% on anything else (holdout) — a gap near 100 percentage points.
 * 0.25 sits well below "collapse" and well above "noise on a small sample",
 * so it catches partial memorization (an implementation that hardcodes some
 * routes and genuinely implements others) without flagging a healthy
 * implementation for one unlucky holdout pair on a 4-5-pair template.
 */
export const DEFAULT_GAP_THRESHOLD = 0.25;

function combinedRate(result: ValidationResult): number {
  if (result.total === 0) return 0;
  return (result.overall.exact + result.overall.structural) / result.total;
}

/** Compare an implementation's train-set performance against its holdout-set
 * performance. A large drop suggests the implementation memorized the
 * training pairs rather than generalizing a real routing/data model — see
 * DEFAULT_GAP_THRESHOLD for why 0.25 is the default cutoff. */
export function computeGap(
  trainResult: ValidationResult,
  holdoutResult: ValidationResult,
  threshold: number = DEFAULT_GAP_THRESHOLD
): GapResult {
  const trainRate = combinedRate(trainResult);

  if (holdoutResult.total === 0) {
    return { trainRate, holdoutRate: null, gap: null, verdict: 'insufficient_holdout', threshold };
  }

  const holdoutRate = combinedRate(holdoutResult);
  const gap = trainRate - holdoutRate;
  const verdict: GapVerdict = gap > threshold ? 'likely_hardcoded' : 'ok';
  return { trainRate, holdoutRate, gap, verdict, threshold };
}

// ---------------------------------------------------------------------------
// (b) Static scan
// ---------------------------------------------------------------------------

export interface HardcodingEvidence {
  value: string;
  /** Number of times this exact value appears verbatim in the source. */
  occurrences: number;
}

export interface ScanResult {
  /** How many distinctive literal values were extracted from the captured
   * responses in the first place. */
  totalDistinctiveValues: number;
  /** How many of those appear verbatim (as a literal substring) in the
   * source at least once. */
  matchedValues: number;
  /**
   * matchedValues / totalDistinctiveValues, 0 when there were no distinctive
   * values to check. NOT a verdict — see module doc: overlap can be
   * legitimate (an enum value, a field name, a genuinely-reproduced piece of
   * seed data that a correct implementation would also contain). Report the
   * evidence and let a human (or a later automated policy) weigh it
   * alongside computeGap()'s verdict, which is the harder signal.
   */
  ratio: number;
  /** Matched values only, sorted by occurrence count (most first) then by
   * value length (longest first) — the most suspicious evidence first. */
  evidence: HardcodingEvidence[];
}

const MIN_STRING_LEN = 6;
const MIN_NUMBER_DIGITS = 4;

/** Small stoplist of vocabulary common enough in JSON/HTTP APIs that its
 * presence in source proves nothing — field names, booleans-as-strings,
 * MIME types, common short English words that happen to clear
 * MIN_STRING_LEN. Deliberately conservative (better to under-flag than to
 * bury real evidence in noise). */
const STOPWORDS = new Set(
  [
    'true', 'false', 'null', 'undefined',
    'application', 'charset', 'utf-8', 'http', 'https', 'www',
    'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
    'status', 'error', 'errors', 'message', 'messages', 'result', 'results',
    'success', 'failed', 'failure', 'created', 'updated', 'deleted', 'unknown',
    'string', 'number', 'boolean', 'object', 'array',
  ].map((w) => w.toLowerCase())
);

function isDistinctiveString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_STRING_LEN) return false;
  if (STOPWORDS.has(trimmed.toLowerCase())) return false;
  return true;
}

function isDistinctiveNumber(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value) >= 10 ** (MIN_NUMBER_DIGITS - 1);
}

/** Recursively walk a parsed JSON value, collecting distinctive leaf
 * literals (long/unusual strings, large numbers) into `out`. */
function collectLiterals(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (isDistinctiveString(value)) out.add(value.trim());
    return;
  }
  if (typeof value === 'number') {
    if (isDistinctiveNumber(value)) out.add(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectLiterals(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectLiterals(v, out);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

/**
 * Extract distinctive literal values from a set of captured response bodies
 * (skipping ones too short/common to be meaningful — see MIN_STRING_LEN,
 * MIN_NUMBER_DIGITS, STOPWORDS) and check which of them appear verbatim in
 * `sourceCode` (an implementation's raw .mjs text). A high ratio of matches
 * is suggestive of a lookup table baked from the captured responses
 * themselves rather than a real data model; a low ratio is NOT proof of
 * innocence (a rewritten/obfuscated lookup table would also score low)
 * and a nonzero ratio is NOT proof of guilt (see ScanResult.ratio doc).
 * Bodies that aren't valid JSON (e.g. HTML pages) are skipped: raw-text
 * literal extraction from markup is too noisy to be useful signal here.
 */
export function scanForHardcoding(sourceCode: string, capturedResponses: string[]): ScanResult {
  const literals = new Set<string>();
  for (const body of capturedResponses) {
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    collectLiterals(parsed, literals);
  }

  const evidence: HardcodingEvidence[] = [];
  for (const value of literals) {
    const occurrences = countOccurrences(sourceCode, value);
    if (occurrences > 0) evidence.push({ value, occurrences });
  }
  evidence.sort((a, b) => b.occurrences - a.occurrences || b.value.length - a.value.length);

  const totalDistinctiveValues = literals.size;
  const matchedValues = evidence.length;
  const ratio = totalDistinctiveValues > 0 ? matchedValues / totalDistinctiveValues : 0;

  return { totalDistinctiveValues, matchedValues, ratio, evidence };
}
