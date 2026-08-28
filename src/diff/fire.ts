/**
 * src/diff/fire.ts — replay a single captured request against a live HTTP
 * target (SP-7ow.2 / SP-7ow.3)
 *
 * Turns one CapturedTraffic entry back into a real outgoing HTTP request,
 * pointed at a different origin (a live target instead of the host it was
 * originally captured from), and returns the response in the shape
 * src/diff/engine.ts's diffHttpMessages() compares against.
 *
 * -- Which recorded headers get forwarded ------------------------------------
 * Not all of them:
 *   - Hop-by-hop / connection-framing headers (Host, Content-Length, ...)
 *     and browser-identity headers that have nothing to do with which
 *     response comes back (User-Agent, Accept-Language, Sec-Fetch-*, ...)
 *     are dropped — reusing src/format/headers.ts's
 *     isVolatileRequestHeaderName, the same list mock-server.ts already
 *     treats as insignificant for matching a replayed request.
 *   - A header whose recorded value is the redaction placeholder
 *     ([REDACTED] — src/format/redact.ts) is dropped rather than forwarded
 *     literally: sending the literal string "[REDACTED]" as an Authorization
 *     header would just produce a misleading 401 instead of a meaningful
 *     diff. Callers that need real auth against the target pass it via
 *     `extraHeaders` instead (see --header on `replay --against`, and
 *     --remote-auth/--local-auth on `compare`).
 */

import type { CapturedTraffic } from '../format/types.js';
import { REDACTED } from '../format/redact.js';
import { isVolatileRequestHeaderName } from '../format/headers.js';
import type { HttpMessage } from './engine.js';

export interface FireOptions {
  /** Applied after the filtered recorded headers, so these always win —
   * e.g. a real Authorization header supplied on the command line. */
  extraHeaders?: Record<string, string>;
  /** Abort the request after this many milliseconds. Default 15000. */
  timeoutMs?: number;
}

/** Rebuild `entryUrl`'s path + query string against `baseUrl`'s origin.
 * `entryUrl` is expected to be the absolute URL a capture recorded
 * (CapturedTraffic.url); if for some reason it isn't a parseable absolute
 * URL, it's treated as a path relative to `baseUrl` instead of failing
 * outright. */
export function resolveTargetUrl(entryUrl: string, baseUrl: string): string {
  const target = new URL(baseUrl);
  try {
    const source = new URL(entryUrl);
    target.pathname = source.pathname;
    target.search = source.search;
    return target.toString();
  } catch {
    const asPath = entryUrl.startsWith('/') ? entryUrl : `/${entryUrl}`;
    return new URL(asPath, target).toString();
  }
}

/** Build the header set to send when firing `entry` at a live target — see
 * module doc for what's excluded and why. */
export function buildOutgoingHeaders(
  entry: Pick<CapturedTraffic, 'requestHeaders'>,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.requestHeaders ?? {})) {
    const lower = key.toLowerCase();
    if (isVolatileRequestHeaderName(lower)) continue;
    if (value === REDACTED) continue;
    out[lower] = value;
  }
  for (const [key, value] of Object.entries(extraHeaders)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** Fire one captured request at `baseUrl` and return the live response.
 * Throws (propagated to the caller) on network failure, non-2xx-only DNS
 * errors, or timeout — callers are expected to catch this per-entry so one
 * unreachable route doesn't abort an entire replay/compare run. */
export async function fireCapturedRequest(
  entry: CapturedTraffic,
  baseUrl: string,
  opts: FireOptions = {},
): Promise<HttpMessage> {
  const url = resolveTargetUrl(entry.url, baseUrl);
  const headers = buildOutgoingHeaders(entry, opts.extraHeaders);
  const method = entry.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && entry.postData != null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: hasBody ? entry.postData! : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    const bodyText = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    return { status: res.status, body: bodyText.length > 0 ? bodyText : null, headers: responseHeaders };
  } finally {
    clearTimeout(timer);
  }
}
