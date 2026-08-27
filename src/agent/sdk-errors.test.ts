import assert from 'node:assert/strict';
import test from 'node:test';
import {
  budgetExceededMessage,
  classifyResultMessage,
  isAmbiguousAbortMessage,
  reclassifyAbortError,
  type SdkResultLike,
} from './sdk-errors.js';

// ---------------------------------------------------------------------------
// isAmbiguousAbortMessage
// ---------------------------------------------------------------------------

test('isAmbiguousAbortMessage: matches the SDK\'s generic wording', () => {
  assert.equal(isAmbiguousAbortMessage(new Error('Claude Code process aborted by user')), true);
  // Case-insensitive, and matches regardless of surrounding text.
  assert.equal(isAmbiguousAbortMessage(new Error('claude code PROCESS ABORTED BY USER (pid 123)')), true);
});

test('isAmbiguousAbortMessage: does not match unrelated errors', () => {
  assert.equal(isAmbiguousAbortMessage(new Error('Generation timed out after 480000ms')), false);
  assert.equal(isAmbiguousAbortMessage(new Error('ECONNRESET')), false);
  assert.equal(isAmbiguousAbortMessage(new Error('Agent ended with error_max_turns')), false);
});

test('isAmbiguousAbortMessage: handles non-Error thrown values', () => {
  assert.equal(isAmbiguousAbortMessage('Claude Code process aborted by user'), true);
  assert.equal(isAmbiguousAbortMessage({ weird: 'object' }), false);
});

// ---------------------------------------------------------------------------
// budgetExceededMessage
// ---------------------------------------------------------------------------

test('budgetExceededMessage: names the configured budget and the env var to raise', () => {
  const msg = budgetExceededMessage(25, 'MOCKIFY_INFER_MAX_BUDGET_USD');
  assert.match(msg, /exceeded budget of \$25/);
  assert.match(msg, /MOCKIFY_INFER_MAX_BUDGET_USD/);
  assert.equal(msg.includes('spent'), false); // no spend figure when unknown
});

test('budgetExceededMessage: includes the spent amount when known', () => {
  const msg = budgetExceededMessage(25, 'MOCKIFY_INFER_MAX_BUDGET_USD', 25.13);
  assert.match(msg, /spent \$25\.13/);
});

test('budgetExceededMessage: omits the spent figure when it is zero', () => {
  const msg = budgetExceededMessage(25, 'MOCKIFY_INFER_MAX_BUDGET_USD', 0);
  assert.equal(msg.includes('spent'), false);
});

// ---------------------------------------------------------------------------
// classifyResultMessage — fake SDK `result` message shapes
// ---------------------------------------------------------------------------

test('classifyResultMessage: error_max_budget_usd produces the friendly budget message with SDK-reported spend', () => {
  const message: SdkResultLike = { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 25.07 };
  const err = classifyResultMessage(message, 25, 'MOCKIFY_INFER_MAX_BUDGET_USD');
  assert.match(err.message, /generation stopped: exceeded budget of \$25/);
  assert.match(err.message, /spent \$25\.07/);
  assert.match(err.message, /MOCKIFY_INFER_MAX_BUDGET_USD/);
  // Never the misleading SDK wording this whole module exists to avoid.
  assert.equal(isAmbiguousAbortMessage(err), false);
});

test('classifyResultMessage: other non-success subtypes keep the existing generic wording', () => {
  for (const subtype of ['error_max_turns', 'error_during_execution', 'error_max_structured_output_retries']) {
    const message: SdkResultLike = { type: 'result', subtype };
    const err = classifyResultMessage(message, 25, 'MOCKIFY_INFER_MAX_BUDGET_USD');
    assert.equal(err.message, `Agent ended with ${subtype}`);
  }
});

// ---------------------------------------------------------------------------
// reclassifyAbortError — the abrupt-kill case (no result message ever arrives)
// ---------------------------------------------------------------------------

test('reclassifyAbortError: an ambiguous abort NOT caused by our own timeout is attributed to budget exhaustion', () => {
  const controller = new AbortController();
  const ownTimeoutReason = new Error('Generation timed out after 480000ms');
  const someOtherReason = new Error('something else entirely');
  controller.abort(someOtherReason); // NOT ownTimeoutReason — simulates the SDK's own internal kill

  const thrown = new Error('Claude Code process aborted by user');
  const result = reclassifyAbortError(thrown, {
    signal: controller.signal,
    ownAbortReason: ownTimeoutReason,
    budgetUsd: 25,
    envVar: 'MOCKIFY_INFER_MAX_BUDGET_USD',
  });

  assert.ok(result instanceof Error);
  assert.match(result.message, /generation stopped: exceeded budget of \$25/);
  assert.match(result.message, /MOCKIFY_INFER_MAX_BUDGET_USD/);
  assert.equal(isAmbiguousAbortMessage(result), false);
});

test('reclassifyAbortError: an ambiguous abort caused by OUR OWN timeout recovers the real timeout message', () => {
  const controller = new AbortController();
  const ownTimeoutReason = new Error('Generation timed out after 480000ms');
  controller.abort(ownTimeoutReason); // exactly the reason we pass as ownAbortReason

  const thrown = new Error('Claude Code process aborted by user'); // the SDK's exitError discarded our reason
  const result = reclassifyAbortError(thrown, {
    signal: controller.signal,
    ownAbortReason: ownTimeoutReason,
    budgetUsd: 25,
    envVar: 'MOCKIFY_INFER_MAX_BUDGET_USD',
  });

  assert.equal(result, ownTimeoutReason); // recovered, not misattributed to budget
  assert.match((result as Error).message, /timed out after 480000ms/);
});

test('reclassifyAbortError: leaves non-ambiguous errors untouched', () => {
  const controller = new AbortController();
  controller.abort(new Error('some internal reason'));

  const thrown = new Error('ECONNRESET');
  const result = reclassifyAbortError(thrown, {
    signal: controller.signal,
    budgetUsd: 25,
    envVar: 'MOCKIFY_INFER_MAX_BUDGET_USD',
  });

  assert.equal(result, thrown); // untouched — not our pattern to reclassify
});

test('reclassifyAbortError: leaves the error untouched when the signal was never aborted', () => {
  const controller = new AbortController();
  const thrown = new Error('Claude Code process aborted by user'); // shouldn't happen, but be conservative
  const result = reclassifyAbortError(thrown, {
    signal: controller.signal,
    budgetUsd: 25,
    envVar: 'MOCKIFY_INFER_MAX_BUDGET_USD',
  });

  assert.equal(result, thrown);
});

test('reclassifyAbortError: no ownAbortReason provided still attributes an ambiguous abort to budget', () => {
  // Exercises the runner.ts call site's shape, where a timeout may not be
  // configured at all (opts.timeoutMs undefined => ownAbortReason undefined).
  const controller = new AbortController();
  controller.abort(new Error('internal'));

  const thrown = new Error('Claude Code process aborted by user');
  const result = reclassifyAbortError(thrown, {
    signal: controller.signal,
    budgetUsd: 15,
    envVar: 'MOCKIFY_MAX_BUDGET_USD',
  });

  assert.ok(result instanceof Error);
  assert.match((result as Error).message, /exceeded budget of \$15/);
});
