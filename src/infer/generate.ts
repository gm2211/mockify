/**
 * src/infer/generate.ts — generate a real mock implementation from a
 * capture (SP-qd4 phase 2)
 *
 * Phase 1 (src/infer/contract.ts, split.ts, harness.ts, hardcoding.ts)
 * built the measuring instrument: a fixed implementation shape, a
 * deterministic train/holdout split, a grading harness, and a hardcoding
 * detector. This phase is the thing being measured: inferImplementation()
 * drives the Claude Agent SDK to write a real `handlers.mjs` from a
 * capture's TRAIN traffic, iterating against the harness until it converges
 * (or runs out of rounds), then scores the winner on HOLDOUT exactly once.
 *
 * -- Holdout integrity ------------------------------------------------------
 * The LLM must NEVER see holdout pairs — not the requests, not the
 * responses. That's the entire point of the split: a generation loop that
 * could see what it's later graded on would trivially "pass" by memorizing
 * it, and the hardcoding/gap machinery from phase 1 would have nothing left
 * to catch. This is enforced structurally, not just by convention:
 *   - buildGenerationPrompt() takes only `train` (never `holdout` or the
 *     full entry list) as its source of request/response content.
 *   - The endpoint inventory + response shapes shown to the model are
 *     recomputed from TRAIN ONLY here (buildTrainOnlyTemplates), rather than
 *     reusing the persisted <captureDir>/synthetic/index.json — that file is
 *     built from the FULL capture (see synthesize/generate.ts,
 *     agent/runner.ts), so its per-key value pools can contain literal
 *     strings/numbers that were only ever observed in a HOLDOUT response.
 *     Showing that file to the model would leak holdout content through the
 *     shape's example pool. Recomputing costs almost nothing (same O(n)
 *     helpers, just called with a smaller array) and keeps the leak surface
 *     at zero.
 *   - Journey/causality hints pulled from observations.json are filtered to
 *     only mention requests that are themselves in `train` (buildJourneyHints).
 *   - The TRAIN/HOLDOUT split itself is computed once, here, from the raw
 *     capture — holdout never leaves this function except as an opaque
 *     ValidationResult produced by the harness at the very end.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CapturedTraffic } from '../format/types.js';
import type { StepObservation } from '../agent/observation.js';
import { inferTemplateGroups, type TemplateGroup } from '../synthesize/templates.js';
import { inferShape, type Shape } from '../synthesize/schema.js';
import { generateSynthetic } from '../synthesize/generate.js';
import { splitPairs } from './split.js';
import { loadImplementation, ImplementationLoadError } from './contract.js';
import { validateImplementation, type Grade, type ValidationResult } from './harness.js';
import { computeGap, scanForHardcoding, type GapResult, type ScanResult } from './hardcoding.js';

// ---------------------------------------------------------------------------
// The contract, verbatim
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/infer/generate.js and src/infer/generate.ts sit at the same depth
// under the repo root (dist/ mirrors src/ 1:1 — see tsconfig.json rootDir
// /outDir), so this resolves correctly whether running compiled or via tsx.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT_SOURCE_PATH = path.join(REPO_ROOT, 'src', 'infer', 'contract.ts');

let cachedContractSource: string | undefined;

/** Read src/infer/contract.ts's source text, verbatim, for embedding in the
 * generation prompt. Cached after the first read (the file doesn't change
 * during a process's lifetime). */
function loadContractSource(): string {
  if (cachedContractSource === undefined) {
    cachedContractSource = fs.readFileSync(CONTRACT_SOURCE_PATH, 'utf8');
  }
  return cachedContractSource;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferOptions {
  /** Capture directory containing traffic.json (as produced by `mockify capture`). */
  captureDir: string;
  /** Max generation rounds. Default 3. Iteration stops early once a round
   * scores no fail/status_only grades on train. */
  rounds?: number;
  /** Fraction of each endpoint template's pairs held out from the model. Default 0.2. */
  holdoutRatio?: number;
  onProgress?: (event: InferProgressEvent) => void;
  /** Model id override. Falls back to MOCKIFY_INFER_MODEL, then 'claude-opus-4-6'. */
  model?: string;
  /** Wall-clock timeout per generation call, ms. Falls back to
   * MOCKIFY_INFER_TIMEOUT_MS, then 480_000 (8 minutes). */
  timeoutMs?: number;
  /**
   * Testing-only escape hatch: replaces the real Agent SDK call. Given the
   * full prompt text for this round, must resolve to the model's raw
   * response text (a ```javascript fenced block, or bare source — both are
   * accepted by extractCodeFromResponse). Nothing in this module talks to
   * the network unless this is omitted.
   */
  generateFn?: (prompt: string, round: number) => Promise<string>;
}

export type InferProgressEvent =
  | {
      type: 'sampling';
      templateCount: number;
      trainCount: number;
      holdoutCount: number;
      promptChars: number;
      examplesPerTemplate: number;
      bodyCharCap: number;
    }
  | { type: 'round_start'; round: number; rounds: number }
  | { type: 'round_generated'; round: number; sourceChars: number }
  | { type: 'round_scored'; round: number; trainRate: number; overall: Record<Grade, number> }
  | { type: 'round_load_error'; round: number; error: string }
  | { type: 'round_generation_error'; round: number; error: string }
  | { type: 'best_selected'; round: number; trainRate: number }
  | { type: 'final_scoring_start' }
  | { type: 'done'; summary: InferSummary };

/** One generation round's outcome. `trainResult` is null when the round
 * either failed to generate at all or produced a file that failed to load —
 * see `generationError` / `loadError`. */
export interface InferAttempt {
  round: number;
  source: string | null;
  generationError?: string;
  loadError?: string;
  trainResult: ValidationResult | null;
}

export interface InferSummary {
  captureDir: string;
  implPath: string;
  reportPath: string;
  model: string;
  /** ISO timestamp the run completed — passed in by the caller, never
   * computed inside a pure function (see buildReport). */
  generatedAt: string;
  roundsUsed: number;
  roundsMax: number;
  bestRound: number;
  train: ValidationResult;
  holdout: ValidationResult;
  gap: GapResult;
  hardcoding: ScanResult;
  attempts: Array<{
    round: number;
    trainRate: number | null;
    overall: Record<Grade, number> | null;
    generationError?: string;
    loadError?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Endpoint inventory (TRAIN ONLY — see module doc)
// ---------------------------------------------------------------------------

interface TrainTemplateRecord {
  method: string;
  pathTemplate: string;
  paramNames: string[];
  status: number;
  contentType: string;
  entryCount: number;
  shape: Shape;
}

/** Mirrors synthesize/generate.ts's generateSynthetic() record-building loop,
 * but computed from `train` only and never written to disk — see module doc
 * for why the persisted synthetic/index.json can't be reused here. */
function buildTrainOnlyTemplates(groups: TemplateGroup[]): TrainTemplateRecord[] {
  return groups.map(({ template, entries }) => {
    const modalBodies = entries.filter((e) => e.status === template.status).map((e) => e.responseBody ?? '');
    const bodies = modalBodies.length > 0 ? modalBodies : entries.map((e) => e.responseBody ?? '');
    return {
      method: template.method,
      pathTemplate: template.pathTemplate,
      paramNames: template.paramNames,
      status: template.status,
      contentType: template.contentType,
      entryCount: template.entryCount,
      shape: inferShape(bodies),
    };
  });
}

const MAX_SHAPE_EXAMPLE_CHARS = 80;

/** Compact, human-readable rendering of a Shape — a TypeScript-ish type
 * description with a couple of example values per primitive, so the model
 * can see both the structure and a sense of real content without the full
 * (and much larger) response bodies. */
function describeShape(shape: Shape, depth = 0): string {
  const indent = '  '.repeat(depth + 1);
  const closeIndent = '  '.repeat(depth);
  switch (shape.type) {
    case 'object': {
      const entries = Object.entries(shape.keys);
      if (entries.length === 0) return '{}';
      const lines = entries.map(([key, { shape: valueShape, optional }]) => {
        return `${indent}${key}${optional ? '?' : ''}: ${describeShape(valueShape, depth + 1)}`;
      });
      return `{\n${lines.join(',\n')}\n${closeIndent}}`;
    }
    case 'array':
      return `Array<${describeShape(shape.element, depth)}>`;
    case 'string':
    case 'number':
    case 'boolean': {
      const examples = shape.pool
        .slice(0, 3)
        .map((v) => {
          const text = JSON.stringify(v);
          return text.length > MAX_SHAPE_EXAMPLE_CHARS ? `${text.slice(0, MAX_SHAPE_EXAMPLE_CHARS)}..."` : text;
        })
        .join(', ');
      return examples ? `${shape.type} (e.g. ${examples})` : shape.type;
    }
    case 'null':
      return 'null';
    default:
      return 'unknown';
  }
}

function formatEndpointInventory(templates: TrainTemplateRecord[]): string {
  if (templates.length === 0) return '(no endpoint templates could be inferred from the training traffic)';
  return templates
    .map((t) => {
      const params = t.paramNames.length > 0 ? ` (path params: ${t.paramNames.join(', ')})` : '';
      const shapeText = describeShape(t.shape).replace(/\n/g, '\n  ');
      return (
        `${t.method} ${t.pathTemplate}${params} — status ${t.status}, content-type "${t.contentType}", ` +
        `${t.entryCount} sample(s) in train\n  response shape: ${shapeText}`
      );
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Representative request/response examples (TRAIN ONLY)
// ---------------------------------------------------------------------------

export interface ExampleSampling {
  method: string;
  pathTemplate: string;
  total: number;
  shown: number;
}

function truncateBody(body: string | null | undefined, cap: number): string {
  if (body === null || body === undefined || body === '') return '(empty)';
  if (body.length <= cap) return body;
  return `${body.slice(0, cap)}... [truncated, ${body.length} chars total]`;
}

function safePathAndQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Pick up to `cap` entries from a template group, favoring diversity of
 * observed status code (e.g. a 400 validation error AND a 201 success for
 * the same POST route) over just taking the first N — round-robins across
 * status buckets in the group's (deterministic) order. */
function pickRepresentative(entries: CapturedTraffic[], cap: number): CapturedTraffic[] {
  if (entries.length <= cap) return entries;

  const byStatus = new Map<number, CapturedTraffic[]>();
  for (const e of entries) {
    const bucket = byStatus.get(e.status);
    if (bucket) bucket.push(e);
    else byStatus.set(e.status, [e]);
  }
  const buckets = [...byStatus.values()];

  const out: CapturedTraffic[] = [];
  for (let round = 0; out.length < cap; round++) {
    let addedThisRound = false;
    for (const bucket of buckets) {
      if (out.length >= cap) break;
      if (round < bucket.length) {
        out.push(bucket[round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break; // exhausted every bucket
  }
  return out;
}

function formatExamples(
  groups: TemplateGroup[],
  examplesPerTemplate: number,
  bodyCap: number
): { text: string; sampling: ExampleSampling[] } {
  const blocks: string[] = [];
  const sampling: ExampleSampling[] = [];

  for (const { template, entries } of groups) {
    const picked = pickRepresentative(entries, examplesPerTemplate);
    sampling.push({ method: template.method, pathTemplate: template.pathTemplate, total: entries.length, shown: picked.length });

    for (const e of picked) {
      const reqBody = e.postData ? `\n  request body: ${truncateBody(e.postData, bodyCap)}` : '';
      blocks.push(
        `${e.method.toUpperCase()} ${safePathAndQuery(e.url)}${reqBody}\n` +
          `  → status ${e.status} (${e.contentType})\n` +
          `  response body: ${truncateBody(e.responseBody, bodyCap)}`
      );
    }
  }

  return { text: blocks.length > 0 ? blocks.join('\n\n') : '(no examples available)', sampling };
}

// ---------------------------------------------------------------------------
// Journey/causality hints (TRAIN ONLY — see module doc)
// ---------------------------------------------------------------------------

const MAX_JOURNEY_LINES = 40;

/**
 * Turn the runner-recorded per-step trace (observations.json) into short
 * causality hints ("click #doReservation precedes POST /api/booking"). Only
 * steps whose associated traffic includes at least one TRAIN entry are
 * emitted, and only train entries are ever named — a step whose traffic
 * range is entirely holdout is skipped outright rather than partially
 * redacted, so nothing about a holdout-only step (not even that it
 * happened) reaches the prompt.
 */
function buildJourneyHints(
  observations: StepObservation[] | null,
  fullEntries: CapturedTraffic[],
  trainSet: Set<CapturedTraffic>
): string {
  if (!observations || observations.length === 0) return '';

  const lines: string[] = [];
  for (const step of observations) {
    const [start, end] = step.trafficRange;
    const stepEntries = fullEntries.slice(start, end).filter((e) => trainSet.has(e));
    if (stepEntries.length === 0) continue;

    const requests = [...new Set(stepEntries.map((e) => `${e.method.toUpperCase()} ${safePathAndQuery(e.url)}`))];
    const argsText = step.args
      ? Object.entries(step.args)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')
      : '';
    lines.push(`- ${step.action}${argsText ? ` (${argsText})` : ''} → ${requests.join(', ')}`);
    if (lines.length >= MAX_JOURNEY_LINES) break;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const GENERATION_INSTRUCTIONS = `
Instructions:
1. Write ONE ESM file, \`handlers.mjs\`, default-exporting \`{ reset(), handle(req) }\` exactly per
   the contract above. It must run under plain Node with no build step and no dependencies.
2. Implement BEHAVIOR, do not memorize responses. Maintain an in-memory data store seeded with
   data consistent with what you observed above; route requests against it; compute responses from
   the store. A lookup table keyed by request (method+path, or method+path+body) is an explicit
   failure — it will be scored as hardcoded.
3. Be STATEFUL where the traffic implies it: a POST that creates a resource must be visible to a
   later GET for that resource; \`reset()\` must restore the seed so a fresh run starts clean.
4. Implement validation rules visible in observed error responses (e.g. field length bounds,
   "must not be empty" style messages) as REAL validation against the request body, returning the
   same error shape you observed.
5. Be deterministic: no Math.random(), no Date.now() in response bodies — UNLESS an observed field
   is genuinely a timestamp, in which case derive it from a fixed seed/base value so repeated runs
   produce the same answer.
6. Return null from handle() for anything you don't recognize — the server falls back to a
   recorded/synthetic tier for those, so declining is safe; guessing wrong is not.
7. Preserve the exact status codes and content types you observed for each route.

Respond with ONLY the complete handlers.mjs file content, inside a single \`\`\`javascript code
block. No explanation before or after the code block.
`.trim();

function assemblePrompt(parts: { inventory: string; examples: string; journey: string; contractSource: string }): string {
  const sections = [
    'You are generating a mock server implementation for a web API, inferred from a browser capture.',
    'You are shown ONLY a training subset of the captured traffic — a held-out portion is withheld on',
    'purpose to grade whether your implementation genuinely models the API rather than memorizing the',
    'examples below. Assume every request you receive at runtime, including ones you never saw here,',
    'needs a real, computed answer.',
    '',
    '## Endpoint inventory (inferred from training traffic only)',
    '',
    parts.inventory,
    '',
    '## Representative request/response examples (training traffic only)',
    '',
    parts.examples,
  ];
  if (parts.journey) {
    sections.push('', '## User-flow hints (ordered browser actions, training requests only)', '', parts.journey);
  }
  sections.push(
    '',
    '## The implementation contract (verbatim, src/infer/contract.ts)',
    '',
    '```typescript',
    parts.contractSource,
    '```',
    '',
    GENERATION_INSTRUCTIONS
  );
  return sections.join('\n');
}

export interface PromptBuildResult {
  prompt: string;
  promptChars: number;
  templateCount: number;
  exampleSampling: ExampleSampling[];
  examplesPerTemplateUsed: number;
  bodyCharCapUsed: number;
  journeyHintsIncluded: boolean;
}

const DEFAULT_MAX_PROMPT_CHARS = 120_000;

/** Ordered from least to most aggressive truncation — buildGenerationPrompt
 * tries each in turn until the assembled prompt fits maxChars, falling back
 * to the last (most aggressive) step if even that doesn't fit. */
const SIZE_STEPS: ReadonlyArray<{ examplesPerTemplate: number; bodyCap: number }> = [
  { examplesPerTemplate: 3, bodyCap: 1500 },
  { examplesPerTemplate: 2, bodyCap: 1500 },
  { examplesPerTemplate: 1, bodyCap: 1500 },
  { examplesPerTemplate: 1, bodyCap: 700 },
  { examplesPerTemplate: 1, bodyCap: 300 },
];

/**
 * Build the initial generation prompt from TRAIN traffic only (see module
 * doc for the holdout-integrity invariant this function exists to enforce).
 * Pure given its inputs — no network, no clock, no randomness — so it's
 * directly unit-testable, including the critical "holdout never appears"
 * property.
 */
export function buildGenerationPrompt(params: {
  train: CapturedTraffic[];
  fullEntries: CapturedTraffic[];
  observations: StepObservation[] | null;
  contractSource: string;
  maxChars?: number;
}): PromptBuildResult {
  const maxChars = params.maxChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const groups = inferTemplateGroups(params.train);
  const templates = buildTrainOnlyTemplates(groups);
  const inventory = formatEndpointInventory(templates);
  const trainSet = new Set(params.train);
  const journey = buildJourneyHints(params.observations, params.fullEntries, trainSet);

  let chosen: { prompt: string; examplesPerTemplate: number; bodyCap: number; sampling: ExampleSampling[] } | undefined;

  for (const step of SIZE_STEPS) {
    const { text, sampling } = formatExamples(groups, step.examplesPerTemplate, step.bodyCap);
    const prompt = assemblePrompt({ inventory, examples: text, journey, contractSource: params.contractSource });
    chosen = { prompt, examplesPerTemplate: step.examplesPerTemplate, bodyCap: step.bodyCap, sampling };
    if (prompt.length <= maxChars) break;
  }
  const final = chosen as NonNullable<typeof chosen>; // SIZE_STEPS is non-empty, so this always gets set

  return {
    prompt: final.prompt,
    promptChars: final.prompt.length,
    templateCount: templates.length,
    exampleSampling: final.sampling,
    examplesPerTemplateUsed: final.examplesPerTemplate,
    bodyCharCapUsed: final.bodyCap,
    journeyHintsIncluded: journey.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Feedback (TRAIN ONLY, by construction — see buildFailureFeedback doc)
// ---------------------------------------------------------------------------

const MAX_FEEDBACK_CASES = 15;

/**
 * Bounded, structured summary of a train run's failing cases (fail or
 * status_only grades), for feeding back to the model as a correction
 * request. Reads ONLY `trainResult`, which the caller must have computed by
 * running validateImplementation against `train` — there is no way to
 * accidentally pull in holdout content here since holdout is never passed
 * in. Uses PairResult.response (harness.ts) rather than re-invoking
 * handle() itself, since a second call would run against the
 * implementation's POST-run state, not the state that was actually graded.
 */
export function buildFailureFeedback(trainResult: ValidationResult, cap = MAX_FEEDBACK_CASES): string {
  const failing = trainResult.results.filter((r) => r.grade === 'fail' || r.grade === 'status_only');
  if (failing.length === 0) return '';

  const shown = failing.slice(0, cap);
  const lines = shown.map((r) => {
    const reqBody = r.entry.postData ? `\n    request body: ${truncateBody(r.entry.postData, 300)}` : '';
    const expected = `status=${r.entry.status} body=${truncateBody(r.entry.responseBody, 400)}`;

    let actual: string;
    if (r.grade === 'fail' && r.detail?.startsWith('handler threw')) {
      actual = r.detail;
    } else if (r.response === null || r.response === undefined) {
      actual = 'declined (handle() returned null)';
    } else {
      const bodyText = typeof r.response.body === 'string' ? r.response.body : JSON.stringify(r.response.body);
      actual = `status=${r.response.status} body=${truncateBody(bodyText, 400)}`;
    }

    return (
      `- ${r.entry.method.toUpperCase()} ${safePathAndQuery(r.entry.url)}${reqBody}\n` +
      `    grade: ${r.grade}${r.detail ? ` (${r.detail})` : ''}\n` +
      `    expected: ${expected}\n` +
      `    actual:   ${actual}`
    );
  });

  const more =
    failing.length > shown.length ? `\n\n... and ${failing.length - shown.length} more failing TRAIN case(s) not shown.` : '';
  return lines.join('\n\n') + more;
}

interface PreviousAttempt {
  source: string;
  loadError?: string;
  failureFeedback?: string;
}

function buildFeedbackPrompt(basePrompt: string, previous: PreviousAttempt): string {
  const problem = previous.loadError
    ? `Your previous attempt failed to load:\n\n${previous.loadError}\n\nFix the problem (syntax error, wrong export ` +
      'shape, etc.) — see the contract above.'
    : `Your previous attempt failed these TRAIN cases (you still cannot see holdout):\n\n${previous.failureFeedback}`;

  return (
    `${basePrompt}\n\n---\n\nYour previous attempt (handlers.mjs):\n\n\`\`\`javascript\n${previous.source}\n\`\`\`\n\n` +
    `${problem}\n\nReturn the FULL corrected file (not a diff, not just the changed function) in a single ` +
    '```javascript code block.'
  );
}

// ---------------------------------------------------------------------------
// Agent SDK call
// ---------------------------------------------------------------------------

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_MODEL = 'claude-opus-4-6';

function resolveModel(override?: string): string {
  return override || process.env.MOCKIFY_INFER_MODEL || DEFAULT_MODEL;
}

const GENERATION_SYSTEM_PROMPT =
  'You generate a single Node.js ESM mock-server implementation module from observed HTTP traffic. ' +
  'Respond with ONLY the complete file content inside one ```javascript code block — no prose before or after.';

/** Extract the largest fenced code block from a model response, or fall back
 * to the raw trimmed text when the model didn't fence its answer. */
export function extractCodeFromResponse(raw: string): string {
  const fences = [...raw.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (fences.length === 0) return `${raw.trim()}\n`;
  const best = fences.reduce((a, b) => (b.length > a.length ? b : a));
  return `${best.trim()}\n`;
}

/** Real generation call via the Claude Agent SDK — the production default
 * for InferOptions.generateFn. Guarded by a wall-clock timeout wired into
 * the SDK's own AbortController so an in-flight call is actually cancelled,
 * not just abandoned. No tools are exposed: this is a pure text-generation
 * call, not an agentic session. */
async function callAgentSdk(prompt: string, model: string, timeoutMs: number): Promise<string> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(new Error(`Generation timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    const options: Options = {
      model,
      systemPrompt: GENERATION_SYSTEM_PROMPT,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: process.cwd(),
      maxTurns: 4,
      maxBudgetUsd: envNumber('MOCKIFY_INFER_MAX_BUDGET_USD', 3),
      persistSession: false,
      abortController,
    };

    const q = query({ prompt, options });
    let finalResult = '';
    for await (const message of q) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          finalResult = message.result;
        } else {
          throw new Error(`Agent ended with ${message.subtype}`);
        }
      }
    }
    if (!finalResult.trim()) throw new Error('Agent returned an empty response');
    return finalResult;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Best-attempt selection + report
// ---------------------------------------------------------------------------

/** Combined (exact + structural) pass rate, 0..1 — the same metric
 * hardcoding.ts's computeGap uses, duplicated locally (harness.ts/
 * hardcoding.ts don't export it) since it's the natural ranking key for
 * "which round generalized best". */
export function trainScore(result: ValidationResult): number {
  if (result.total === 0) return 0;
  return (result.overall.exact + result.overall.structural) / result.total;
}

/** Pick the highest-scoring attempt by train pass rate — NOT simply the last
 * round, since a later round can regress (e.g. the model "fixes" one
 * failure by breaking a previously-working route). Ties prefer the later
 * round (the model's most recent, presumably-refined understanding). Skips
 * attempts with no scoreable trainResult (generation or load failures).
 * Returns null when no attempt is scoreable at all. */
export function selectBestAttempt(attempts: InferAttempt[]): InferAttempt | null {
  let best: InferAttempt | null = null;
  let bestScore = -1;
  for (const attempt of attempts) {
    if (!attempt.trainResult) continue;
    const score = trainScore(attempt.trainResult);
    if (score >= bestScore) {
      bestScore = score;
      best = attempt;
    }
  }
  return best;
}

export interface BuildReportParams {
  captureDir: string;
  implPath: string;
  reportPath: string;
  model: string;
  roundsMax: number;
  bestRound: number;
  train: ValidationResult;
  holdout: ValidationResult;
  gap: GapResult;
  hardcoding: ScanResult;
  attempts: InferAttempt[];
}

/** Pure: assembles the report object from already-computed results plus a
 * caller-supplied timestamp — no clock call inside, so it's deterministic
 * and directly testable (see generate.test.ts). */
export function buildReport(params: BuildReportParams, generatedAt: string): InferSummary {
  return {
    captureDir: params.captureDir,
    implPath: params.implPath,
    reportPath: params.reportPath,
    model: params.model,
    generatedAt,
    roundsUsed: params.attempts.length,
    roundsMax: params.roundsMax,
    bestRound: params.bestRound,
    train: params.train,
    holdout: params.holdout,
    gap: params.gap,
    hardcoding: params.hardcoding,
    attempts: params.attempts.map((a) => ({
      round: a.round,
      trainRate: a.trainResult ? trainScore(a.trainResult) : null,
      overall: a.trainResult ? a.trainResult.overall : null,
      generationError: a.generationError,
      loadError: a.loadError,
    })),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const DEFAULT_ROUNDS = 3;
const DEFAULT_TIMEOUT_MS = 480_000; // 8 minutes

/**
 * Generate a real mock implementation from `captureDir`'s traffic.json,
 * iterating against the validation harness (TRAIN only) up to `rounds`
 * times, then scoring the best attempt against HOLDOUT exactly once. Writes
 * `<captureDir>/impl/handlers.mjs` (the winning attempt) and
 * `<captureDir>/impl/report.json` (the full scoring breakdown). See module
 * doc for the holdout-integrity guarantees this function is built around.
 */
export async function inferImplementation(opts: InferOptions): Promise<InferSummary> {
  const rounds = opts.rounds ?? DEFAULT_ROUNDS;
  const holdoutRatio = opts.holdoutRatio ?? 0.2;
  const onProgress = opts.onProgress ?? ((): void => {});
  const model = resolveModel(opts.model);
  const timeoutMs = opts.timeoutMs ?? envNumber('MOCKIFY_INFER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const generate = opts.generateFn ?? ((prompt: string): Promise<string> => callAgentSdk(prompt, model, timeoutMs));

  const captureDir = path.resolve(opts.captureDir);
  const trafficPath = path.join(captureDir, 'traffic.json');
  const entries = JSON.parse(fs.readFileSync(trafficPath, 'utf8')) as CapturedTraffic[];

  // Best-effort: keep <captureDir>/synthetic/index.json around for the mock
  // server's own unrelated fallback tier if a capture predates it. This is
  // NOT the source used to build the prompt below — see module doc.
  const syntheticIndexPath = path.join(captureDir, 'synthetic', 'index.json');
  if (!fs.existsSync(syntheticIndexPath)) {
    try {
      generateSynthetic(entries, captureDir);
    } catch {
      // Synthesis is optional infrastructure for a different feature; never
      // block inference on it.
    }
  }

  const { train, holdout } = splitPairs(entries, { holdoutRatio });

  let observations: StepObservation[] | null = null;
  const observationsPath = path.join(captureDir, 'observations.json');
  if (fs.existsSync(observationsPath)) {
    try {
      observations = JSON.parse(fs.readFileSync(observationsPath, 'utf8')) as StepObservation[];
    } catch {
      observations = null;
    }
  }

  const built = buildGenerationPrompt({
    train,
    fullEntries: entries,
    observations,
    contractSource: loadContractSource(),
  });

  onProgress({
    type: 'sampling',
    templateCount: built.templateCount,
    trainCount: train.length,
    holdoutCount: holdout.length,
    promptChars: built.promptChars,
    examplesPerTemplate: built.examplesPerTemplateUsed,
    bodyCharCap: built.bodyCharCapUsed,
  });

  const implDir = path.join(captureDir, 'impl');
  fs.mkdirSync(implDir, { recursive: true });
  // Each round's candidate gets its own file path (rather than overwriting
  // one path and re-importing it) because Node's ESM loader caches modules
  // by resolved URL — re-importing the same path after rewriting its
  // content would silently return the STALE cached module, not the new one.
  const attemptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-infer-'));

  const attempts: InferAttempt[] = [];

  try {
    let previous: PreviousAttempt | undefined;

    for (let round = 1; round <= rounds; round++) {
      onProgress({ type: 'round_start', round, rounds });

      const prompt = previous ? buildFeedbackPrompt(built.prompt, previous) : built.prompt;

      let raw: string;
      try {
        raw = await generate(prompt, round);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress({ type: 'round_generation_error', round, error: message });
        attempts.push({ round, source: null, generationError: message, trainResult: null });
        if (!previous) {
          throw new Error(
            `mockify infer: round ${round} generation failed and no prior attempt exists to fall back to: ${message}`
          );
        }
        break; // best-effort with whatever we already have
      }

      const source = extractCodeFromResponse(raw);
      onProgress({ type: 'round_generated', round, sourceChars: source.length });

      const attemptPath = path.join(attemptsDir, `round-${round}.mjs`);
      fs.writeFileSync(attemptPath, source, 'utf8');

      let trainResult: ValidationResult | null = null;
      let loadError: string | undefined;
      try {
        const impl = await loadImplementation(attemptPath);
        trainResult = await validateImplementation(impl, train);
      } catch (err) {
        loadError = err instanceof ImplementationLoadError ? err.message : err instanceof Error ? err.message : String(err);
        onProgress({ type: 'round_load_error', round, error: loadError });
      }

      attempts.push({ round, source, loadError, trainResult });

      if (trainResult) {
        onProgress({ type: 'round_scored', round, trainRate: trainScore(trainResult), overall: trainResult.overall });
        const hasFailures = trainResult.results.some((r) => r.grade === 'fail' || r.grade === 'status_only');
        if (!hasFailures) break; // perfect on train — nothing left to correct
        previous = { source, failureFeedback: buildFailureFeedback(trainResult) };
      } else {
        previous = { source, loadError };
      }
    }

    const best = selectBestAttempt(attempts);
    if (!best || !best.trainResult || best.source === null) {
      const last = attempts[attempts.length - 1];
      const lastError = last?.loadError ?? last?.generationError ?? 'unknown error';
      throw new Error(
        `mockify infer: no generation attempt produced a loadable implementation (${attempts.length} round(s) ` +
          `tried). Last error: ${lastError}`
      );
    }

    const implPath = path.join(implDir, 'handlers.mjs');
    fs.writeFileSync(implPath, best.source, 'utf8');
    onProgress({ type: 'best_selected', round: best.round, trainRate: trainScore(best.trainResult) });

    onProgress({ type: 'final_scoring_start' });
    const finalImpl = await loadImplementation(implPath);
    const holdoutResult = await validateImplementation(finalImpl, holdout);
    const gap = computeGap(best.trainResult, holdoutResult);

    const sourceCode = fs.readFileSync(implPath, 'utf8');
    // Static scan runs against the FULL capture's responses (train +
    // holdout), same as `mockify validate` — unlike prompt construction,
    // this happens strictly AFTER generation is finalized, so there's
    // nothing to leak: it's read-only forensics on output the model already
    // produced, not input the model gets to see.
    const hardcoding = scanForHardcoding(sourceCode, entries.map((e) => e.responseBody ?? ''));

    const reportPath = path.join(implDir, 'report.json');
    const summary = buildReport(
      {
        captureDir,
        implPath,
        reportPath,
        model,
        roundsMax: rounds,
        bestRound: best.round,
        train: best.trainResult,
        holdout: holdoutResult,
        gap,
        hardcoding,
        attempts,
      },
      new Date().toISOString()
    );

    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), 'utf8');
    onProgress({ type: 'done', summary });

    return summary;
  } finally {
    fs.rmSync(attemptsDir, { recursive: true, force: true });
  }
}
