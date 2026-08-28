/**
 * src/latency.ts — replay captured per-endpoint latency
 *
 * CapturedTraffic entries (src/format/types.ts) carry `tsStart`/`tsEnd` —
 * the wall-clock moments the real request went out and the real response
 * came back. mock-server.ts used to discard both once matching was done and
 * answer instantly. Replaying the observed duration instead makes the mock
 * behave like the real dependency it was captured from: timeouts, loading
 * spinners, and race conditions become reproducible against the mock the
 * same way they happen against the real thing.
 *
 * This module is pure computation — no I/O, no timers wired to `setTimeout`
 * except `delayFor` itself — so every piece of the math (duration
 * extraction, speed scaling, per-template median, missing-timestamp
 * fallback) is unit-testable without spinning up a server. mock-server.ts
 * wires the result into the recorded (tier 2) and synthetic (tier 3) response
 * paths; see its module doc's "Four-tier response pipeline" section.
 */

import type { CapturedTraffic } from './format/types.js';

/**
 * Hard ceiling on any single replayed delay, regardless of what was
 * observed or how `speed` scales it. Protects the mock from a pathological
 * captured outlier (a request that really did hang for minutes) turning
 * every replay of that route into an equally long hang — 30s is already far
 * longer than any sane test/dev-loop timeout, so hitting the cap still reads
 * as "slow", not "instant", without actually blocking the caller for
 * minutes.
 */
export const MAX_DELAY_MS = 30_000;

/**
 * Controls whether/how captured latency is replayed. `speed` is a
 * multiplier on wall-clock delay, not an additive offset: `2` replays at
 * twice real speed (half the observed delay), `0.5` replays at half real
 * speed (twice the observed delay — slower than the original capture),
 * `1` (the default) replays the delay as originally observed. Only
 * meaningful when `enabled` is true; `speed` is ignored entirely when it
 * isn't (this is what `--no-latency` maps to — "infinite speed", i.e. zero
 * delay, rather than some very large `speed` value that would still have to
 * survive floating-point division).
 */
export interface LatencyOptions {
  enabled: boolean;
  /** Must be > 0 when `enabled` is true; a non-finite or non-positive value
   * is treated as "no delay" by scaleDelayMs rather than throwing, so a
   * malformed value degrades to today's instant-response behavior instead
   * of crashing request handling. */
  speed: number;
}

/** Latency replay is opt-in — see the mockify.spec.yaml / README rationale
 * captured in the SP-lsc.10 PR: enabling real-time replay by default would
 * have made the existing "instant response" assumption behind every
 * mock-server test (and, more importantly, every downstream consumer that
 * has never had to think about response timing) silently slower. Passing
 * `--latency` or `--speed <n>` to `mockify serve`/`replay` opts in; the
 * default keeps zero-delay behavior unchanged. */
export const DEFAULT_LATENCY_OPTIONS: LatencyOptions = { enabled: false, speed: 1 };

/**
 * Raw observed duration (ms) between a captured entry's request being sent
 * and its response completing. Returns null — not 0 — for anything that
 * isn't a clean, non-negative, finite pair: a missing field (captures taken
 * before tsStart/tsEnd existed), a non-number, NaN/Infinity, or tsEnd before
 * tsStart (clock skew in a captured environment, or hand-edited fixture
 * data). Callers treat null as "no delay data" and fall back accordingly —
 * returning 0 here would indistinguishably collapse "observed to be
 * instant" and "no observation at all".
 */
export function computeRawDurationMs(entry: Pick<CapturedTraffic, 'tsStart' | 'tsEnd'>): number | null {
  const { tsStart, tsEnd } = entry;
  if (typeof tsStart !== 'number' || typeof tsEnd !== 'number') return null;
  if (!Number.isFinite(tsStart) || !Number.isFinite(tsEnd)) return null;
  const duration = tsEnd - tsStart;
  if (!Number.isFinite(duration) || duration < 0) return null;
  return duration;
}

/** Scale an observed duration by `speed` (see LatencyOptions doc for
 * direction) and cap at MAX_DELAY_MS. A non-finite or non-positive `speed`
 * — which shouldn't happen through the CLI's own validation, but this stays
 * defensive for direct/programmatic callers — degrades to 0 rather than
 * producing Infinity/NaN or a negative delay. */
export function scaleDelayMs(durationMs: number, speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  const scaled = durationMs / speed;
  if (!Number.isFinite(scaled) || scaled <= 0) return 0;
  return Math.min(scaled, MAX_DELAY_MS);
}

/** Resolve a final delay (ms) from an already-known duration (or null when
 * there isn't one) plus the active LatencyOptions. Disabled options, or a
 * null duration, both resolve to 0 — the two "no delay" cases share one
 * exit so every call site (recorded-entry delay, synthetic per-template
 * delay) gets identical missing-data behavior for free. */
export function resolveDelayMs(durationMs: number | null, opts: LatencyOptions): number {
  if (!opts.enabled || durationMs === null) return 0;
  return scaleDelayMs(durationMs, opts.speed);
}

/** Delay (ms) to replay before answering with a specific matched recorded
 * entry (mock-server.ts tier 2) — the entry's own observed tsStart/tsEnd
 * duration, scaled by `opts.speed`. 0 when timestamps are missing/invalid
 * or latency replay is disabled. */
export function computeEntryDelayMs(entry: Pick<CapturedTraffic, 'tsStart' | 'tsEnd'>, opts: LatencyOptions): number {
  return resolveDelayMs(computeRawDurationMs(entry), opts);
}

/** Median of `values`, or null for an empty array. Used instead of mean so
 * one outlier capture (a single very slow or very fast request against an
 * endpoint) doesn't skew every synthetic reply to that endpoint template. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The minimal shape of a synthetic template this module needs to key and
 * match latency stats — a structural subset of
 * SyntheticTemplateRecord (src/synthesize/generate.ts) so this module
 * doesn't have to import synthesize/generate.ts's full type (which would
 * otherwise be the only reason latency.ts depended on synthesize/ at all). */
export interface LatencyTemplateLike {
  method: string;
  pathTemplate: string;
  regex: string;
}

function templateKey(t: Pick<LatencyTemplateLike, 'method' | 'pathTemplate'>): string {
  return `${t.method} ${t.pathTemplate}`;
}

/** Per-template + overall median observed durations, built once at server
 * startup from every captured entry (not just the ones a template's own
 * shape inference used) — see buildTemplateLatencyIndex. */
export interface TemplateLatencyIndex {
  /** Median duration (ms) among entries whose method+path matched a given
   * template, keyed by `${method} ${pathTemplate}`. Absent for a template
   * with no entries carrying valid tsStart/tsEnd. */
  perTemplateMedianMs: Map<string, number>;
  /** Median duration (ms) across every entry in the capture with a valid
   * tsStart/tsEnd pair, regardless of template — the fallback used when a
   * specific template has no timing data of its own. Null when the capture
   * has no valid timestamps at all. */
  overallMedianMs: number | null;
}

/**
 * Build the per-template latency index the synthetic tier (mock-server.ts
 * tier 3) consults for an endpoint that was never actually recorded — there
 * is no single "the matched entry" to read tsStart/tsEnd off of, so instead
 * every captured entry matching a template's method + path regex
 * contributes its observed duration, and the template replays the median of
 * those. A template with zero timed entries (e.g. every contributing
 * capture predates tsStart/tsEnd) falls back to `overallMedianMs` at
 * resolve time (resolveSyntheticDelayMs), and a capture with no timing data
 * anywhere resolves to a 0 delay (see resolveDelayMs).
 *
 * O(entries × templates) — templates are typically a handful per capture
 * and this only runs once at server startup (and only when latency replay
 * is enabled — see startMockServer), so the naive scan is fine.
 */
export function buildTemplateLatencyIndex(
  entries: readonly CapturedTraffic[],
  templates: readonly LatencyTemplateLike[]
): TemplateLatencyIndex {
  const allDurations: number[] = [];
  const perTemplateDurations = new Map<string, number[]>();
  for (const t of templates) perTemplateDurations.set(templateKey(t), []);

  for (const entry of entries) {
    const duration = computeRawDurationMs(entry);
    if (duration === null) continue;
    allDurations.push(duration);

    let pathname: string;
    try {
      pathname = new URL(entry.url).pathname;
    } catch {
      continue;
    }
    const method = entry.method.toUpperCase();
    for (const t of templates) {
      if (t.method !== method) continue;
      let matches: boolean;
      try {
        matches = new RegExp(t.regex).test(pathname);
      } catch {
        continue;
      }
      if (!matches) continue;
      // First matching template wins, mirroring matchSyntheticTemplate
      // (src/synthesize/generate.ts) — an entry contributes its duration to
      // at most one template's stats.
      perTemplateDurations.get(templateKey(t))!.push(duration);
      break;
    }
  }

  const perTemplateMedianMs = new Map<string, number>();
  for (const [key, durations] of perTemplateDurations) {
    const m = median(durations);
    if (m !== null) perTemplateMedianMs.set(key, m);
  }

  return { perTemplateMedianMs, overallMedianMs: median(allDurations) };
}

/** Delay (ms) to replay before answering a synthetic-tier response for
 * `template` — that template's own median observed duration, falling back
 * to the capture's overall median, then to 0 (via resolveDelayMs) when
 * neither exists or latency replay is disabled. */
export function resolveSyntheticDelayMs(
  template: Pick<LatencyTemplateLike, 'method' | 'pathTemplate'>,
  index: TemplateLatencyIndex,
  opts: LatencyOptions
): number {
  const duration = index.perTemplateMedianMs.get(templateKey(template)) ?? index.overallMedianMs ?? null;
  return resolveDelayMs(duration, opts);
}

/** Actually wait `ms` milliseconds (no-op for `ms <= 0`). The one function
 * in this module with a real side effect — everything else is pure math so
 * it can be unit-tested without a clock. */
export function delayFor(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
