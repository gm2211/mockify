/**
 * src/compare/ab.ts — deterministic A/B comparison driven by a capture
 * (SP-7ow.3)
 *
 * specify's `specify compare --remote <url> --local <url>` is agent-driven:
 * an LLM drives two parallel browser sessions and eyeballs the difference.
 * This is the deterministic core mockify runs instead — no browser, no
 * agent: a capture's traffic supplies the request list (what to ask), and
 * the same request is fired at both targets and the two live responses are
 * diffed against each other with src/diff/engine.ts's diffHttpMessages —
 * the exact comparator SP-7ow.2 (`mockify replay --against`) built, reused
 * unchanged here. There's nothing "compare-specific" about the diff logic;
 * the only thing that differs from `replay --against` is which two
 * responses get compared (remote vs. recorded there, remote vs. local
 * here) and that both sides are live fetches rather than one being a
 * recorded body.
 *
 * `remote` is treated as the baseline (DiffResult's "expected" side) and
 * `local` as the candidate being checked against it — matching specify's
 * own `--remote`/`--local` naming, where remote is conventionally the
 * reference/production system and local the build under test.
 */

import type { CapturedTraffic } from '../format/types.js';
import { diffHttpMessages, type DiffResult } from '../diff/engine.js';
import { fireCapturedRequest, type FireOptions } from '../diff/fire.js';

export interface CompareEntryResult {
  method: string;
  url: string;
  diff: DiffResult;
  /** Set instead of `diff` when firing the request at the remote target
   * itself failed (network error, timeout, DNS) — no response to compare. */
  remoteError?: string;
  /** Same, for the local target. */
  localError?: string;
}

export interface CompareSummary {
  remote: string;
  local: string;
  total: number;
  matched: number;
  mismatched: number;
  errored: number;
  results: CompareEntryResult[];
}

export interface CompareOptions extends Pick<FireOptions, 'timeoutMs'> {
  /** `user:pass` — sent as a Basic Authorization header to the remote target. */
  remoteAuth?: string;
  /** Same, for the local target. */
  localAuth?: string;
}

function basicAuthHeader(userPass: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(userPass, 'utf8').toString('base64')}` };
}

const EMPTY_DIFF: DiffResult = {
  match: false,
  statusMatch: false,
  expectedStatus: 0,
  actualStatus: 0,
  structuralMatch: false,
  mismatches: [],
  ignoredFields: [],
};

/** Fire every entry in `entries` at both `remoteUrl` and `localUrl`
 * (sequentially, preserving recorded order for stateful flows — the same
 * reasoning as src/replay/against.ts's replayAgainst) and diff the two live
 * responses against each other. An entry where either side fails to fire is
 * reported as `errored`, not `mismatched` — there was nothing to compare. */
export async function compareAB(
  entries: CapturedTraffic[],
  remoteUrl: string,
  localUrl: string,
  opts: CompareOptions = {},
): Promise<CompareSummary> {
  const remoteExtraHeaders = opts.remoteAuth ? basicAuthHeader(opts.remoteAuth) : undefined;
  const localExtraHeaders = opts.localAuth ? basicAuthHeader(opts.localAuth) : undefined;

  const results: CompareEntryResult[] = [];

  for (const entry of entries) {
    let remoteError: string | undefined;
    let localError: string | undefined;
    let remoteMsg;
    let localMsg;

    try {
      remoteMsg = await fireCapturedRequest(entry, remoteUrl, { timeoutMs: opts.timeoutMs, extraHeaders: remoteExtraHeaders });
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err);
    }
    try {
      localMsg = await fireCapturedRequest(entry, localUrl, { timeoutMs: opts.timeoutMs, extraHeaders: localExtraHeaders });
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
    }

    if (remoteError || localError) {
      results.push({
        method: entry.method,
        url: entry.url,
        diff: { ...EMPTY_DIFF, expectedStatus: remoteMsg?.status ?? 0, actualStatus: localMsg?.status ?? 0 },
        remoteError,
        localError,
      });
      continue;
    }

    results.push({ method: entry.method, url: entry.url, diff: diffHttpMessages(remoteMsg!, localMsg!) });
  }

  const errored = results.filter((r) => r.remoteError || r.localError).length;
  const matched = results.filter((r) => !r.remoteError && !r.localError && r.diff.match).length;

  return {
    remote: remoteUrl,
    local: localUrl,
    total: results.length,
    matched,
    mismatched: results.length - matched - errored,
    errored,
    results,
  };
}
