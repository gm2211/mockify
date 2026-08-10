import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGenerationPrompt,
  buildFailureFeedback,
  selectBestAttempt,
  buildReport,
  trainScore,
  inferImplementation,
  extractCodeFromResponse,
  type InferAttempt,
} from './generate.js';
import { splitPairs } from './split.js';
import { validateImplementation } from './harness.js';
import { computeGap, scanForHardcoding } from './hardcoding.js';
import type { CapturedTraffic } from '../format/types.js';
import type { Implementation } from './contract.js';
import type { ValidationResult } from './harness.js';
import type { StepObservation } from '../agent/observation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_TRAFFIC = path.join(REPO_ROOT, 'test', 'fixtures', 'infer-capture', 'traffic.json');
const GOOD_IMPL = path.join(REPO_ROOT, 'test', 'fixtures', 'impl', 'good.mjs');

function loadFixtureEntries(): CapturedTraffic[] {
  return JSON.parse(fs.readFileSync(FIXTURE_TRAFFIC, 'utf8')) as CapturedTraffic[];
}

// ---------------------------------------------------------------------------
// buildGenerationPrompt — holdout exclusion (the critical test)
// ---------------------------------------------------------------------------

/**
 * Content that appears ONLY in holdout entries — not, say, a full item
 * record that's also legitimately visible via a different TRAIN endpoint
 * (e.g. this fixture's holdout `GET /api/items/4` returns the same "Widget
 * Delta" record that TRAIN's `GET /api/items` collection response already
 * lists — that's expected: the model should learn item 4 exists from the
 * collection response, and the holdout detail-route request is what tests
 * whether it generalized that into real routing, not a leak). What must
 * never appear is content that has NO legitimate train source at all.
 */
function holdoutExclusiveNeedles(train: CapturedTraffic[], holdout: CapturedTraffic[]): string[] {
  const trainText = train.map((e) => `${e.postData ?? ''}\n${e.responseBody ?? ''}`).join('\n');
  const needles: string[] = [];
  for (const h of holdout) {
    for (const v of [h.postData, h.responseBody]) {
      if (v && !trainText.includes(v)) needles.push(v);
    }
  }
  return needles;
}

test('buildGenerationPrompt: never includes content that exists ONLY in a holdout pair', () => {
  const entries = loadFixtureEntries();
  const { train, holdout } = splitPairs(entries);
  assert.ok(holdout.length > 0, 'test setup: fixture must produce a holdout set');

  const needles = holdoutExclusiveNeedles(train, holdout);
  assert.ok(needles.length > 0, 'test setup: expected at least one holdout-exclusive value (e.g. the "Widget Eta" pair)');

  const built = buildGenerationPrompt({
    train,
    fullEntries: entries,
    observations: null,
    contractSource: 'CONTRACT_PLACEHOLDER_TEXT',
  });

  for (const needle of needles) {
    assert.ok(!built.prompt.includes(needle), `prompt must not contain holdout-exclusive content: ${needle.slice(0, 60)}`);
  }
});

test('buildGenerationPrompt: contains train content (sanity check that the exclusion test isn\'t vacuous)', () => {
  const entries = loadFixtureEntries();
  const { train } = splitPairs(entries);
  const built = buildGenerationPrompt({ train, fullEntries: entries, observations: null, contractSource: 'x' });
  const trainWithBody = train.find((e) => e.responseBody);
  assert.ok(trainWithBody);
  assert.ok(built.prompt.includes(trainWithBody!.responseBody!.slice(0, 40)));
});

// ---------------------------------------------------------------------------
// buildGenerationPrompt — size bound + sampling report
// ---------------------------------------------------------------------------

test('buildGenerationPrompt: a generous size bound uses the least-aggressive sampling', () => {
  const entries = loadFixtureEntries();
  const { train } = splitPairs(entries);
  const built = buildGenerationPrompt({ train, fullEntries: entries, observations: null, contractSource: 'contract text' });
  assert.equal(built.examplesPerTemplateUsed, 3);
  assert.equal(built.bodyCharCapUsed, 1500);
  assert.ok(built.exampleSampling.length > 0);
});

test('buildGenerationPrompt: a tight size bound forces more aggressive sampling and stays reported', () => {
  const entries = loadFixtureEntries();
  const { train } = splitPairs(entries);
  const built = buildGenerationPrompt({
    train,
    fullEntries: entries,
    observations: null,
    contractSource: 'x'.repeat(500),
    maxChars: 900, // deliberately tiny — smaller than even the most aggressive step will produce
  });
  // Can't always hit the bound exactly (the last step is a floor, not a hard cap), but it must have
  // tried the most aggressive step available.
  assert.equal(built.examplesPerTemplateUsed, 1);
  assert.equal(built.bodyCharCapUsed, 300);
  assert.ok(built.promptChars > 0);
});

// ---------------------------------------------------------------------------
// buildGenerationPrompt — journey hints stay train-only
// ---------------------------------------------------------------------------

test('buildGenerationPrompt: journey hints only ever reference train requests, never holdout-only ones', () => {
  const entries = loadFixtureEntries();
  const { train, holdout } = splitPairs(entries);
  const trainIndex = entries.indexOf(train[0]);
  const holdoutIndex = entries.indexOf(holdout[0]);
  assert.ok(trainIndex >= 0 && holdoutIndex >= 0);

  const observations: StepObservation[] = [
    {
      step: 0,
      action: 'click',
      args: { selector: '#trainAction' },
      success: true,
      urlBefore: '',
      urlAfter: '',
      tsStart: 0,
      tsEnd: 1,
      ax: { unchanged: true, digest: 'a' },
      trafficRange: [trainIndex, trainIndex + 1],
      consoleRange: [0, 0],
    },
    {
      step: 1,
      action: 'click',
      args: { selector: '#holdoutOnlyAction' },
      success: true,
      urlBefore: '',
      urlAfter: '',
      tsStart: 1,
      tsEnd: 2,
      ax: { unchanged: true, digest: 'b' },
      trafficRange: [holdoutIndex, holdoutIndex + 1],
      consoleRange: [0, 0],
    },
  ];

  const built = buildGenerationPrompt({ train, fullEntries: entries, observations, contractSource: 'c' });
  assert.ok(built.journeyHintsIncluded);
  assert.ok(built.prompt.includes('trainAction'));
  assert.ok(!built.prompt.includes('holdoutOnlyAction'), 'a step whose traffic is entirely holdout must be omitted entirely');
});

test('buildGenerationPrompt: no observations.json means no journey section, not an error', () => {
  const entries = loadFixtureEntries();
  const { train } = splitPairs(entries);
  const built = buildGenerationPrompt({ train, fullEntries: entries, observations: null, contractSource: 'c' });
  assert.equal(built.journeyHintsIncluded, false);
});

// ---------------------------------------------------------------------------
// buildFailureFeedback
// ---------------------------------------------------------------------------

test('buildFailureFeedback: reports only failing cases, not passing ones', async () => {
  const pairs: CapturedTraffic[] = [
    { url: 'https://x.test/api/a', method: 'GET', postData: null, status: 200, contentType: 'application/json', ts: 0, responseBody: '{"ok":true}' },
    { url: 'https://x.test/api/b', method: 'GET', postData: null, status: 200, contentType: 'application/json', ts: 0, responseBody: '{"ok":true}' },
  ];
  const impl: Implementation = {
    reset() {},
    handle: ({ path: p }) => (p === '/api/a' ? { status: 200, contentType: 'application/json', body: { ok: true } } : null),
  };
  const trainResult = await validateImplementation(impl, pairs);
  const feedback = buildFailureFeedback(trainResult);
  assert.ok(!feedback.includes('/api/a'), 'the passing case must not appear');
  assert.ok(feedback.includes('/api/b'), 'the failing case must appear');
  assert.match(feedback, /declined/);
});

test('buildFailureFeedback: empty when nothing failed', async () => {
  const pairs: CapturedTraffic[] = [
    { url: 'https://x.test/api/a', method: 'GET', postData: null, status: 200, contentType: 'application/json', ts: 0, responseBody: '{"ok":true}' },
  ];
  const impl: Implementation = { reset() {}, handle: () => ({ status: 200, contentType: 'application/json', body: { ok: true } }) };
  const trainResult = await validateImplementation(impl, pairs);
  assert.equal(buildFailureFeedback(trainResult), '');
});

test('buildFailureFeedback: caps the number of cases shown and notes the remainder', async () => {
  const pairs: CapturedTraffic[] = Array.from({ length: 20 }, (_, i) => ({
    url: `https://x.test/api/thing/${i}`,
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: i,
    responseBody: `{"id":${i}}`,
  }));
  const impl: Implementation = { reset() {}, handle: () => null };
  const trainResult = await validateImplementation(impl, pairs);
  const feedback = buildFailureFeedback(trainResult, 5);
  const bulletCount = (feedback.match(/^- GET/gm) ?? []).length;
  assert.equal(bulletCount, 5);
  assert.match(feedback, /15 more failing TRAIN case\(s\) not shown/);
});

// ---------------------------------------------------------------------------
// selectBestAttempt
// ---------------------------------------------------------------------------

function fakeValidationResult(overall: Record<'exact' | 'structural' | 'status_only' | 'fail', number>): ValidationResult {
  const total = overall.exact + overall.structural + overall.status_only + overall.fail;
  return { total, overall, perTemplate: [], results: [] };
}

test('selectBestAttempt: picks the higher-scoring round, not merely the last', () => {
  const worse = fakeValidationResult({ exact: 1, structural: 0, status_only: 0, fail: 3 });
  const better = fakeValidationResult({ exact: 3, structural: 1, status_only: 0, fail: 0 });
  const attempts: InferAttempt[] = [
    { round: 1, source: 'a', trainResult: worse },
    { round: 2, source: 'b', trainResult: better },
    { round: 3, source: 'c', trainResult: worse }, // regressed on the last round
  ];
  const best = selectBestAttempt(attempts);
  assert.equal(best?.round, 2);
});

test('selectBestAttempt: ignores attempts with no scoreable trainResult', () => {
  const good = fakeValidationResult({ exact: 2, structural: 0, status_only: 0, fail: 0 });
  const attempts: InferAttempt[] = [
    { round: 1, source: null, generationError: 'boom', trainResult: null },
    { round: 2, source: 'ok', trainResult: good },
  ];
  assert.equal(selectBestAttempt(attempts)?.round, 2);
});

test('selectBestAttempt: returns null when no attempt is scoreable', () => {
  const attempts: InferAttempt[] = [{ round: 1, source: null, generationError: 'boom', trainResult: null }];
  assert.equal(selectBestAttempt(attempts), null);
});

test('trainScore: combined exact+structural rate, 0 for an empty result', () => {
  assert.equal(trainScore(fakeValidationResult({ exact: 0, structural: 0, status_only: 0, fail: 0 })), 0);
  assert.equal(trainScore(fakeValidationResult({ exact: 3, structural: 1, status_only: 1, fail: 1 })), 4 / 6);
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

test('buildReport: shape includes rounds, grade breakdowns, gap, hardcoding, model, and the passed-in timestamp', () => {
  const train = fakeValidationResult({ exact: 2, structural: 0, status_only: 0, fail: 0 });
  const holdout = fakeValidationResult({ exact: 1, structural: 0, status_only: 0, fail: 0 });
  const gap = computeGap(train, holdout);
  const hardcoding = scanForHardcoding('const x = 1;', []);
  const attempts: InferAttempt[] = [{ round: 1, source: 'x', trainResult: train }];
  const now = '2026-01-01T00:00:00.000Z';

  const report = buildReport(
    {
      captureDir: '/tmp/cap',
      implPath: '/tmp/cap/impl/handlers.mjs',
      reportPath: '/tmp/cap/impl/report.json',
      model: 'claude-opus-4-6',
      roundsMax: 3,
      bestRound: 1,
      train,
      holdout,
      gap,
      hardcoding,
      attempts,
    },
    now
  );

  assert.equal(report.generatedAt, now);
  assert.equal(report.model, 'claude-opus-4-6');
  assert.equal(report.roundsUsed, 1);
  assert.equal(report.roundsMax, 3);
  assert.equal(report.bestRound, 1);
  assert.deepEqual(report.train.overall, train.overall);
  assert.deepEqual(report.holdout.overall, holdout.overall);
  assert.equal(report.gap.verdict, gap.verdict);
  assert.equal(report.hardcoding.ratio, hardcoding.ratio);
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].trainRate, 1);
});

// ---------------------------------------------------------------------------
// extractCodeFromResponse
// ---------------------------------------------------------------------------

test('extractCodeFromResponse: pulls the largest fenced code block out of a response', () => {
  const raw = 'Here you go:\n\n```javascript\nexport default { reset(){}, handle(){return null;} };\n```\n\nDone.';
  const code = extractCodeFromResponse(raw);
  assert.match(code, /export default/);
  assert.ok(!code.includes('Here you go'));
});

test('extractCodeFromResponse: falls back to the raw trimmed text when nothing is fenced', () => {
  const raw = '  export default { reset(){}, handle(){return null;} };  ';
  assert.equal(extractCodeFromResponse(raw), 'export default { reset(){}, handle(){return null;} };\n');
});

// ---------------------------------------------------------------------------
// inferImplementation — end to end, stubbed generator, no network
// ---------------------------------------------------------------------------

function withTempCapture(run: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-infer-test-'));
  return run(tmpDir).finally(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
}

test('inferImplementation: stops early once a round scores perfectly on train, and never leaks holdout into the prompts it generates from', async () => {
  await withTempCapture(async (tmpDir) => {
    fs.copyFileSync(FIXTURE_TRAFFIC, path.join(tmpDir, 'traffic.json'));
    const badSource = 'export default { reset() {}, handle() { return null; } };\n';
    const goodSource = fs.readFileSync(GOOD_IMPL, 'utf8'); // hand-written for this exact fixture (see good.mjs's own doc comment)
    const rounds = [badSource, goodSource];

    const entries = loadFixtureEntries();
    const { train, holdout } = splitPairs(entries);
    const holdoutNeedles = holdoutExclusiveNeedles(train, holdout);
    assert.ok(holdoutNeedles.length > 0, 'test setup: expected at least one holdout-exclusive value');

    const seenPrompts: string[] = [];
    let calls = 0;
    const generateFn = async (prompt: string, round: number): Promise<string> => {
      calls++;
      seenPrompts.push(prompt);
      return rounds[round - 1] ?? rounds[rounds.length - 1];
    };

    const summary = await inferImplementation({ captureDir: tmpDir, rounds: 3, generateFn });

    assert.equal(calls, 2, 'should stop iterating once a round scores perfectly on train');
    assert.equal(summary.roundsUsed, 2);
    assert.equal(summary.bestRound, 2);
    assert.equal(summary.train.overall.fail, 0);
    assert.ok(fs.existsSync(summary.implPath));
    assert.ok(fs.existsSync(summary.reportPath));

    for (const prompt of seenPrompts) {
      for (const needle of holdoutNeedles) {
        assert.ok(!prompt.includes(needle), `a generation prompt leaked holdout content: ${needle.slice(0, 60)}`);
      }
    }

    const written = JSON.parse(fs.readFileSync(summary.reportPath, 'utf8'));
    assert.equal(written.bestRound, 2);
    assert.equal(written.model, summary.model);
  });
});

test('inferImplementation: recovers from a round whose output fails to load', async () => {
  await withTempCapture(async (tmpDir) => {
    fs.copyFileSync(FIXTURE_TRAFFIC, path.join(tmpDir, 'traffic.json'));
    const broken = 'this is not valid javascript {{{';
    const good = fs.readFileSync(GOOD_IMPL, 'utf8');
    const rounds = [broken, good];
    const generateFn = async (_prompt: string, round: number): Promise<string> => rounds[round - 1] ?? rounds[rounds.length - 1];

    const events: string[] = [];
    const summary = await inferImplementation({
      captureDir: tmpDir,
      rounds: 3,
      generateFn,
      onProgress: (e) => events.push(e.type),
    });

    assert.ok(events.includes('round_load_error'));
    assert.equal(summary.bestRound, 2);
    assert.equal(summary.train.overall.fail, 0);
  });
});

test('inferImplementation: throws a clear error when every round fails to produce a loadable implementation', async () => {
  await withTempCapture(async (tmpDir) => {
    fs.copyFileSync(FIXTURE_TRAFFIC, path.join(tmpDir, 'traffic.json'));
    const generateFn = async (): Promise<string> => 'this is not valid javascript {{{';

    await assert.rejects(
      inferImplementation({ captureDir: tmpDir, rounds: 2, generateFn }),
      /no generation attempt produced a loadable implementation/
    );
  });
});

test('inferImplementation: writes report.json with a per-template breakdown for both train and holdout', async () => {
  await withTempCapture(async (tmpDir) => {
    fs.copyFileSync(FIXTURE_TRAFFIC, path.join(tmpDir, 'traffic.json'));
    const good = fs.readFileSync(GOOD_IMPL, 'utf8');
    const generateFn = async (): Promise<string> => good;

    const summary = await inferImplementation({ captureDir: tmpDir, rounds: 1, generateFn });
    assert.ok(summary.train.perTemplate.length > 0);
    assert.ok(summary.holdout.perTemplate.length > 0);
    assert.ok(summary.hardcoding.ratio < 1);
  });
});
