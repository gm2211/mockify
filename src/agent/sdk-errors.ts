/**
 * src/agent/sdk-errors.ts — shared error classification for Claude Agent SDK
 * generation calls (SP-qd4.1)
 *
 * -- The bug ------------------------------------------------------------
 * Both mockify entry points that drive the Agent SDK's `query()` — this
 * module's callers src/infer/generate.ts (callAgentSdk) and
 * src/agent/runner.ts (executeQuery) — pass their own `AbortController` in
 * `options.abortController`, used to enforce a wall-clock timeout. When the
 * SDK's own `maxBudgetUsd` is exceeded mid-generation, the CLI subprocess it
 * spawns gets hard-killed before it can write a clean `result` message, and
 * the SDK's transport layer reports this exactly the same way it reports a
 * caller-initiated abort:
 *
 *   if (this.abortController.signal.aborted)
 *     this.exitError = new SomeError("Claude Code process aborted by user");
 *
 * (see node_modules/@anthropic-ai/claude-agent-sdk/{sdk,assistant}.mjs) —
 * it checks only the boolean `signal.aborted`, never `signal.reason`, so it
 * can't tell "the caller asked for this" from "the SDK itself killed the
 * subprocess because the budget ran out". The result: a budget cutoff reads
 * exactly like the user hit Ctrl-C, which sent the SP-qd4.1 bug reporter
 * chasing stdin handling for an hour instead of raising a budget env var.
 *
 * -- The fix --------------------------------------------------------------
 * Each call site owns its AbortController exclusively — nothing else in
 * mockify is ever handed a reference to it — so the only two things that
 * can set `signal.aborted` are (a) that call site's own timeout callback,
 * whose exact `Error` instance we can compare by reference, and (b) the
 * SDK's internal budget-triggered kill. `reclassifyAbortError` below uses
 * that reference check to tell the two apart: when it *was* our own
 * timeout, we recover the timeout's real message (the SDK's generic
 * wording discarded it); when it wasn't, we attribute it to budget
 * exhaustion, since that's the only other known cause of a hard kill —
 * max-turns and similar limits stop cleanly with a `result` message
 * instead (see SDKResultError.subtype in sdk.d.ts) and are classified by
 * `classifyResultMessage` below, not this function.
 *
 * This is a heuristic tied to today's SDK behavior, not a certainty — a
 * future SDK version could add another internal hard-kill reason. It's
 * scoped tightly (only fires for the exact ambiguous wording, only when we
 * know we didn't request the abort ourselves) to limit the blast radius of
 * that assumption.
 */

/** Matches the Agent SDK's generic wording for "the subprocess exited while
 * our AbortController's signal was aborted" — genuinely ambiguous on its
 * own; see module doc. */
const AMBIGUOUS_ABORT_PATTERN = /claude code process aborted by user/i;

export function isAmbiguousAbortMessage(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return AMBIGUOUS_ABORT_PATTERN.test(message);
}

/** Caller-facing message for a budget-exhaustion stop. `spentUsd` is the
 * SDK-reported spend when known (a clean `error_max_budget_usd` result
 * message carries `total_cost_usd`); omitted when the abort happened before
 * any result message arrived, in which case only the configured ceiling is
 * known. */
export function budgetExceededMessage(budgetUsd: number, envVar: string, spentUsd?: number): string {
  const spent = spentUsd !== undefined && spentUsd > 0 ? ` (spent $${spentUsd.toFixed(2)} before it was cut off)` : '';
  return `generation stopped: exceeded budget of $${budgetUsd}${spent}. Raise ${envVar} to allow more spend and retry.`;
}

/** Minimal shape this module needs from an SDK `result` message — avoids a
 * hard dependency on the SDK's own message types so this stays trivially
 * unit-testable with fake shapes (see sdk-errors.test.ts). */
export interface SdkResultLike {
  type: 'result';
  subtype: string;
  total_cost_usd?: number;
}

/** Classify a non-success `result` message. Returns a friendly, correctly
 * attributed Error for the budget subtype; a generic "Agent ended with
 * <subtype>" Error for every other non-success subtype (max turns,
 * mid-execution error, structured-output retries exhausted, ...), matching
 * the wording callers already used before this fix so unrelated failure
 * modes aren't renamed. */
export function classifyResultMessage(message: SdkResultLike, budgetUsd: number, envVar: string): Error {
  if (message.subtype === 'error_max_budget_usd') {
    return new Error(budgetExceededMessage(budgetUsd, envVar, message.total_cost_usd));
  }
  return new Error(`Agent ended with ${message.subtype}`);
}

/**
 * Reclassify an error thrown directly out of an in-flight `query()`
 * iteration (as opposed to a clean non-success `result` message, handled by
 * classifyResultMessage above).
 *
 * @param err - the error thrown out of the async iterator.
 * @param opts.signal - the AbortSignal passed as `options.abortController`.
 * @param opts.ownAbortReason - the exact `Error` instance this call's own
 *   code passed to `abortController.abort(...)` (its wall-clock timeout).
 *   Compared by reference against `signal.reason`.
 * @param opts.budgetUsd - the configured budget ceiling, for the message.
 * @param opts.envVar - the env var name to point the caller at.
 */
export function reclassifyAbortError(
  err: unknown,
  opts: { signal: AbortSignal; ownAbortReason?: Error; budgetUsd: number; envVar: string }
): unknown {
  if (!opts.signal.aborted || !isAmbiguousAbortMessage(err)) return err;

  if (opts.ownAbortReason !== undefined && opts.signal.reason === opts.ownAbortReason) {
    // It really was our own timeout — the SDK's exitError discarded our
    // reason's message, so recover it here.
    return opts.ownAbortReason;
  }

  // Not an abort we requested. The SDK's own internal hard-kill on budget
  // exhaustion is the only known cause — see module doc.
  return new Error(budgetExceededMessage(opts.budgetUsd, opts.envVar));
}
