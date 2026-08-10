/**
 * src/infer/split.ts — deterministic, stratified train/holdout split
 * (SP-q50.1)
 *
 * A generated implementation must be graded on requests it never saw during
 * generation, or a memorized lookup table would score perfectly — the whole
 * point of this phase. splitPairs() partitions a capture's traffic into a
 * `train` set (what a later generation phase would be shown) and a
 * `holdout` set (what the harness grades against to detect memorization),
 * without ever touching Math.random so the split is reproducible across
 * runs, machines, and CI.
 *
 * -- Stratified by endpoint template -----------------------------------------
 * A flat random split would starve low-traffic endpoints: a template with 3
 * recorded calls has a good chance of landing entirely in train under a
 * global 80/20 split, leaving no holdout coverage for it at all — exactly
 * the endpoint most likely to be under-generalized and worth checking.
 * Instead, each endpoint template (src/synthesize/templates.ts
 * inferTemplateGroups — the same grouping generate.ts uses for response
 * synthesis) is split independently: ~20% of ITS pairs go to holdout. A
 * template with only 1 recorded pair has nothing to hold out and goes
 * entirely to train.
 *
 * -- Determinism --------------------------------------------------------------
 * Each entry is assigned a hash of `method + url + index` (index = its
 * position in the input array, so two structurally-identical entries at
 * different positions still hash differently) via hashSeed()
 * (src/synthesize/schema.ts, already used for synthetic-response
 * determinism). Within each template group, entries are sorted by that
 * hash and the lowest-hash slice becomes holdout — deterministic, and
 * insensitive to the order inferTemplateGroups happens to enumerate
 * entries in.
 */

import type { CapturedTraffic } from '../format/types.js';
import { inferTemplateGroups } from '../synthesize/templates.js';
import { hashSeed } from '../synthesize/schema.js';

export interface SplitOptions {
  /** Fraction of each template's pairs to hold out, default 0.2 (20%). */
  holdoutRatio?: number;
}

/** Per-template pair counts, so callers can report coverage (e.g. "endpoint
 * X only got 1 holdout pair out of 5"). */
export interface TemplateSplitCount {
  method: string;
  pathTemplate: string;
  total: number;
  train: number;
  holdout: number;
}

export interface SplitResult {
  train: CapturedTraffic[];
  holdout: CapturedTraffic[];
  /** One entry per endpoint template, plus a final "(ungrouped)" entry
   * (pathTemplate === UNGROUPED_TEMPLATE) for any entries inferTemplateGroups
   * didn't place in a template — e.g. requests whose URL failed to parse, or
   * whose recorded status was entirely non-2xx (see templates.ts
   * buildTemplate). Those always go to train: with no peers to stratify
   * against, there's nothing principled to hold out. */
  counts: TemplateSplitCount[];
}

/** Label used for the leftover-entries bucket in `counts` — see SplitResult. */
export const UNGROUPED_TEMPLATE = '(ungrouped)';

/** How many of a template's `n` pairs should go to holdout. n < 2 holds out
 * nothing (nothing to hold out from a single sample). n >= 2 holds out
 * round(n * holdoutRatio), floored to at least 1 (so a low-traffic template
 * still gets holdout coverage — see module doc) and capped at n - 1 (so
 * train never goes empty). */
function holdoutCountFor(n: number, holdoutRatio: number): number {
  if (n < 2) return 0;
  const raw = Math.max(1, Math.round(n * holdoutRatio));
  return Math.min(raw, n - 1);
}

/** Split a flat list of captured request/response pairs into a deterministic,
 * per-template-stratified { train, holdout }. See module doc for the
 * rationale behind stratification and determinism. */
export function splitPairs(entries: CapturedTraffic[], opts: SplitOptions = {}): SplitResult {
  const holdoutRatio = opts.holdoutRatio ?? 0.2;

  const indexOf = new Map<CapturedTraffic, number>();
  entries.forEach((entry, i) => indexOf.set(entry, i));

  const groups = inferTemplateGroups(entries);
  const train: CapturedTraffic[] = [];
  const holdout: CapturedTraffic[] = [];
  const counts: TemplateSplitCount[] = [];
  const assigned = new Set<CapturedTraffic>();

  for (const { template, entries: groupEntries } of groups) {
    const n = groupEntries.length;
    const holdoutCount = holdoutCountFor(n, holdoutRatio);

    const withHash = groupEntries.map((entry) => ({
      entry,
      hash: hashSeed(`${entry.method} ${entry.url} ${indexOf.get(entry) ?? 0}`),
    }));
    // Deterministic order: sort by hash, tie-break by original index (hash
    // collisions are possible on a 32-bit hash over a small capture).
    withHash.sort((a, b) => a.hash - b.hash || (indexOf.get(a.entry) ?? 0) - (indexOf.get(b.entry) ?? 0));

    const groupHoldout = withHash.slice(0, holdoutCount).map((w) => w.entry);
    const groupTrain = withHash.slice(holdoutCount).map((w) => w.entry);

    for (const entry of groupHoldout) {
      holdout.push(entry);
      assigned.add(entry);
    }
    for (const entry of groupTrain) {
      train.push(entry);
      assigned.add(entry);
    }

    counts.push({
      method: template.method,
      pathTemplate: template.pathTemplate,
      total: n,
      train: groupTrain.length,
      holdout: groupHoldout.length,
    });
  }

  // Entries inferTemplateGroups dropped entirely (unparseable URL, or an
  // all-non-2xx group — see templates.ts) have no template to stratify
  // against. They still need to end up SOMEWHERE so the split is a true
  // partition of the input; train is the conservative choice since holding
  // out an ungrouped entry would grade it against an implementation that had
  // no comparable peer to learn the shape from.
  let ungroupedCount = 0;
  for (const entry of entries) {
    if (assigned.has(entry)) continue;
    train.push(entry);
    ungroupedCount++;
  }
  if (ungroupedCount > 0) {
    counts.push({
      method: '*',
      pathTemplate: UNGROUPED_TEMPLATE,
      total: ungroupedCount,
      train: ungroupedCount,
      holdout: 0,
    });
  }

  return { train, holdout, counts };
}
