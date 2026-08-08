/**
 * src/agent/observation.ts — Runner-recorded per-step trace for web targets
 *
 * ObservationRecorder is a per-action trace recorded by the runner itself:
 * one StepObservation per browser action, driven from the single choke
 * point every browser MCP tool passes through (executeCommand in
 * src/agent/executor.ts).
 *
 * Design notes:
 * - Traffic/console attribution uses INDEX SLICES into CaptureCollector's
 *   arrays, not timestamp windows. The traffic route handler awaits
 *   response.text() asynchronously, so entries can land after the action's
 *   own promise has already resolved. We snapshot getTraffic().length /
 *   getConsoleLogs().length when a step begins, and only close out the
 *   slice's end index lazily — at the *next* step's begin, or at save() for
 *   the final step — to give in-flight async pushes a chance to land.
 * - AX snapshots use `page.locator('body').ariaSnapshot()` (YAML, role +
 *   accessible name). `page.accessibility.snapshot()` no longer exists in
 *   the installed Playwright. ariaSnapshot() can throw mid-navigation; we
 *   swallow that the same way capture.ts's screenshot() swallows failures,
 *   recording `{ error }` instead of throwing.
 * - No snapshot diffing: we either write a full snapshot (digest changed)
 *   or dedup by digest (`{ unchanged: true, digest }`).
 * - Args are recorded for selector/url ONLY — never fill values or any
 *   other user-supplied payload that might carry credentials.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import type { CaptureCollector } from './capture.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AxObservation =
  | { file: string; digest: string }
  | { unchanged: true; digest: string }
  | { error: string };

export interface StepObservation {
  /** Step index, 0-based. Step 0 is always the initial goto. */
  step: number;
  action: string;
  /** Recordable args only: selector / url. Never fill values or credentials. */
  args?: Record<string, unknown>;
  success: boolean;
  error?: string;
  urlBefore: string;
  urlAfter: string;
  title?: string;
  tsStart: number;
  tsEnd: number;
  ax: AxObservation;
  screenshot?: string;
  /** [start, end) index slice into CaptureCollector.getTraffic(). */
  trafficRange: [number, number];
  /** [start, end) index slice into CaptureCollector.getConsoleLogs(). */
  consoleRange: [number, number];
}

export interface ObservationRecorderOptions {
  /** Capture output directory (observations.json + observations/ax/ live here). */
  outputDir: string;
  page: Page;
  collector: Pick<CaptureCollector, 'getTraffic' | 'getConsoleLogs'>;
}

// Keys we will ever copy out of a command's args. Deliberately excludes
// `value` (fill), `text` (type), and anything else that could carry a
// credential or other sensitive payload.
const RECORDABLE_ARG_KEYS = ['selector', 'url'] as const;

/** Pick only the safe-to-record keys (selector/url) out of an arbitrary args object. */
export function extractRecordableArgs(args: Record<string, unknown> | undefined | null): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of RECORDABLE_ARG_KEYS) {
    if (key in args && typeof args[key] === 'string') {
      out[key] = args[key];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

interface PendingStep {
  step: number;
  action: string;
  args?: Record<string, unknown>;
  urlBefore: string;
  tsStart: number;
  trafficStart: number;
  consoleStart: number;
}

// ---------------------------------------------------------------------------
// ObservationRecorder
// ---------------------------------------------------------------------------

export class ObservationRecorder {
  private outputDir: string;
  private axDir: string;
  private page: Page;
  private collector: Pick<CaptureCollector, 'getTraffic' | 'getConsoleLogs'>;

  private steps: StepObservation[] = [];
  private stepCounter = 0;
  private pending: PendingStep | null = null;
  /** Index into `steps` whose trafficRange/consoleRange end is not yet closed. */
  private openRangeIndex: number | null = null;
  private lastAxDigest: string | undefined;

  constructor(options: ObservationRecorderOptions) {
    this.outputDir = path.resolve(options.outputDir);
    this.axDir = path.join(this.outputDir, 'observations', 'ax');
    this.page = options.page;
    this.collector = options.collector;
  }

  /**
   * Begin recording a step. Call this before the action executes so
   * urlBefore/tsStart/trafficStart/consoleStart reflect pre-action state.
   * Lazily closes the previous step's traffic/console range.
   */
  async beginStep(action: string, args?: Record<string, unknown>): Promise<void> {
    this.closeOpenRange();

    this.pending = {
      step: this.stepCounter++,
      action,
      args: extractRecordableArgs(args),
      urlBefore: this.safeUrl(),
      tsStart: Date.now(),
      trafficStart: this.collector.getTraffic().length,
      consoleStart: this.collector.getConsoleLogs().length,
    };
  }

  /**
   * Finish recording the current step: captures urlAfter/title/ax/tsEnd and
   * pushes the completed StepObservation. The traffic/console range's end
   * index is left open until the next beginStep() or save() call.
   */
  async endStep(result: {
    success: boolean;
    error?: string;
    screenshot?: string;
  }): Promise<void> {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;

    const urlAfter = this.safeUrl();
    let title: string | undefined;
    try {
      title = await this.page.title();
    } catch {
      // Page may be mid-navigation or closed; title is best-effort.
    }

    const ax = await this.captureAx(pending.step);

    const observation: StepObservation = {
      step: pending.step,
      action: pending.action,
      ...(pending.args ? { args: pending.args } : {}),
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      urlBefore: pending.urlBefore,
      urlAfter,
      ...(title !== undefined ? { title } : {}),
      tsStart: pending.tsStart,
      tsEnd: Date.now(),
      ax,
      ...(result.screenshot ? { screenshot: result.screenshot } : {}),
      trafficRange: [pending.trafficStart, pending.trafficStart],
      consoleRange: [pending.consoleStart, pending.consoleStart],
    };

    this.steps.push(observation);
    this.openRangeIndex = this.steps.length - 1;
  }

  /** Write observations.json (and any pending AX yaml files) to outputDir. */
  save(): { observationsFile: string; steps: number } {
    this.closeOpenRange();

    fs.mkdirSync(this.outputDir, { recursive: true });
    const observationsPath = path.join(this.outputDir, 'observations.json');
    fs.writeFileSync(observationsPath, JSON.stringify(this.steps, null, 2), 'utf-8');

    return { observationsFile: 'observations.json', steps: this.steps.length };
  }

  getSteps(): readonly StepObservation[] {
    return this.steps;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private closeOpenRange(): void {
    if (this.openRangeIndex === null) return;
    const step = this.steps[this.openRangeIndex];
    step.trafficRange[1] = this.collector.getTraffic().length;
    step.consoleRange[1] = this.collector.getConsoleLogs().length;
    this.openRangeIndex = null;
  }

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return '';
    }
  }

  private async captureAx(step: number): Promise<AxObservation> {
    let snapshot: string;
    try {
      snapshot = await this.page.locator('body').ariaSnapshot({ timeout: 2000 });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    const digest = sha256(snapshot);
    if (digest === this.lastAxDigest) {
      return { unchanged: true, digest };
    }
    this.lastAxDigest = digest;

    const filename = `${String(step).padStart(3, '0')}.yaml`;
    try {
      fs.mkdirSync(this.axDir, { recursive: true });
      fs.writeFileSync(path.join(this.axDir, filename), snapshot, 'utf-8');
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    return { file: path.join('observations', 'ax', filename), digest };
  }
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}
