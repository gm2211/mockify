/**
 * src/replay/against.ts — fire a capture's traffic at a live target and
 * diff each response against what was recorded (SP-7ow.2)
 *
 * specify's `specify replay --capture <dir> --url <url>` is agent-driven: an
 * LLM replays captured requests against a target and eyeballs the diff.
 * This is the deterministic port `mockify replay <name> --against <url>`
 * runs instead — every captured request is fired programmatically
 * (src/diff/fire.ts) at the target and graded against the recorded response
 * with src/diff/engine.ts's diffHttpMessages (redacted/volatile fields
 * excluded — see that module's doc for the full rationale). No agent, no
 * cost, fully deterministic given a fixed target.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CapturedTraffic } from '../format/types.js';
import { diffHttpMessages, type DiffResult } from '../diff/engine.js';
import { fireCapturedRequest, type FireOptions } from '../diff/fire.js';

export interface ReplayAgainstEntryResult {
  method: string;
  url: string;
  diff: DiffResult;
  /** Set instead of `diff` succeeding when firing the request itself
   * failed (network error, timeout, DNS) — the entry never got a response
   * to grade. */
  error?: string;
}

export interface ReplayAgainstSummary {
  target: string;
  total: number;
  matched: number;
  mismatched: number;
  errored: number;
  results: ReplayAgainstEntryResult[];
}

export interface ReplayAgainstOptions extends FireOptions {}

/** Read a capture directory's traffic.json — the same file every other
 * mockify command (validate, infer, openapi) reads for its ground truth. */
export function readCaptureTraffic(captureDir: string): CapturedTraffic[] {
  const trafficPath = path.join(captureDir, 'traffic.json');
  return JSON.parse(fs.readFileSync(trafficPath, 'utf8')) as CapturedTraffic[];
}

/** Fire every entry in `entries` at `targetUrl`, sequentially (so a
 * stateful flow — e.g. POST an item then GET it back — replays in the same
 * order it was recorded), and diff each live response against what was
 * recorded. An entry whose request itself fails to fire (network error,
 * timeout) is reported as `errored`, not `mismatched` — it never produced a
 * response to grade. */
export async function replayAgainst(
  entries: CapturedTraffic[],
  targetUrl: string,
  opts: ReplayAgainstOptions = {},
): Promise<ReplayAgainstSummary> {
  const results: ReplayAgainstEntryResult[] = [];

  for (const entry of entries) {
    try {
      const actual = await fireCapturedRequest(entry, targetUrl, opts);
      const expected = { status: entry.status, body: entry.responseBody, headers: entry.responseHeaders };
      const diff = diffHttpMessages(expected, actual);
      results.push({ method: entry.method, url: entry.url, diff });
    } catch (err) {
      results.push({
        method: entry.method,
        url: entry.url,
        diff: {
          match: false,
          statusMatch: false,
          expectedStatus: entry.status,
          actualStatus: 0,
          structuralMatch: false,
          mismatches: [],
          ignoredFields: [],
        },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const errored = results.filter((r) => r.error).length;
  const matched = results.filter((r) => !r.error && r.diff.match).length;

  return {
    target: targetUrl,
    total: results.length,
    matched,
    mismatched: results.length - matched - errored,
    errored,
    results,
  };
}
