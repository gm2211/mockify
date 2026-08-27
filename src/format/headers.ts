/**
 * src/format/headers.ts — header-aware capture/replay support (SP-lsc.8)
 *
 * Two independent jobs live here, both about the requestHeaders/
 * responseHeaders fields CapturedTraffic gained in format version 2 (see
 * src/format/types.ts):
 *
 *   1. Packing a possibly-repeated header (in practice this only ever
 *      matters for Set-Cookie) into the single string CapturedTraffic's
 *      Record<string, string> shape allows, and unpacking it again for
 *      replay — packMultiValueHeader/unpackMultiValueHeader/
 *      packHeadersArray.
 *   2. Deciding which recorded request headers should participate in
 *      matching an incoming replay request (headersSubsetMatch), and which
 *      captured response headers should actually be sent back
 *      (buildReplayResponseHeaders).
 *
 * Credential-bearing header VALUES are redacted separately, at capture time
 * — see src/format/redact.ts's redactHeaders(). This module never sees a
 * real secret; it only ever decides whether a header (secret or not)
 * participates in matching, or gets forwarded on replay.
 */

import { isSecretHeaderName } from './redact.js';
import { MULTI_VALUE_HEADER_SEPARATOR } from './types.js';

// Re-exported so callers of this module don't also need to know the
// separator technically lives in types.ts (see that file's doc comment on
// MULTI_VALUE_HEADER_SEPARATOR for why: redact.ts needs it too, and putting
// it here would create an import cycle since this module already depends on
// redact.ts for isSecretHeaderName).
export { MULTI_VALUE_HEADER_SEPARATOR };

// ---------------------------------------------------------------------------
// Multi-value header packing
// ---------------------------------------------------------------------------

/** Pack multiple values of the same header name into one stored string. */
export function packMultiValueHeader(values: string[]): string {
  return values.join(MULTI_VALUE_HEADER_SEPARATOR);
}

/** Unpack a stored header value back into one-or-more real values — a
 * single-value header round-trips to a one-element array. */
export function unpackMultiValueHeader(value: string): string[] {
  return value.split(MULTI_VALUE_HEADER_SEPARATOR);
}

/**
 * Group a Playwright APIResponse#headersArray()-shaped list (or any
 * equivalent name/value pair list) into the Record<string, string> shape
 * CapturedTraffic.responseHeaders stores, folding repeated header names
 * (Set-Cookie, in practice) with packMultiValueHeader. Header names are
 * lower-cased for consistent lookup, mirroring Playwright's own
 * Request#allHeaders()/headers(), which are lower-cased for the same
 * reason.
 */
export function packHeadersArray(entries: Array<{ name: string; value: string }>): Record<string, string> {
  const grouped = new Map<string, string[]>();
  for (const { name, value } of entries) {
    const key = name.toLowerCase();
    const existing = grouped.get(key);
    if (existing) existing.push(value);
    else grouped.set(key, [value]);
  }
  const out: Record<string, string> = {};
  for (const [key, values] of grouped) {
    out[key] = packMultiValueHeader(values);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request-header matching (replay: which recorded entry answers this request)
// ---------------------------------------------------------------------------

/**
 * Header names whose values are expected to differ between capture time and
 * replay time for reasons that have nothing to do with which recorded
 * variant a request should match: the transport host changes (captured
 * against the real target, replayed from localhost), timestamps and
 * per-request identifiers vary, content negotiation and client-identity
 * headers depend on whatever tool is doing the replaying rather than the
 * original browser, and connection-framing headers are managed by the
 * replay server itself (see HOP_BY_HOP_RESPONSE_HEADERS below for the
 * response-side equivalent). These are excluded from header-based request
 * matching (headersSubsetMatch) entirely, whether or not they were actually
 * recorded — a recorded User-Agent, for instance, should never be a reason
 * a replay request "doesn't match".
 */
const VOLATILE_REQUEST_HEADER_NAMES = new Set([
  'host',
  'user-agent',
  'date',
  'connection',
  'content-length',
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'pragma',
  'referer',
  'origin',
  'access-control-request-method',
  'access-control-request-headers',
  'if-none-match',
  'if-modified-since',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'x-request-id',
  'x-correlation-id',
  'te',
  'trailer',
  'upgrade',
]);

export function isVolatileRequestHeaderName(name: string): boolean {
  return VOLATILE_REQUEST_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * SUBSET semantics: `recorded` matches `incoming` when every one of
 * `recorded`'s *significant* headers — excluding volatile headers (see
 * isVolatileRequestHeaderName) and credential-bearing ones (redaction has
 * already replaced those with a stable placeholder — see
 * src/format/redact.ts's isSecretHeaderName — which could never equal a
 * live incoming value, so treating them as significant would make every
 * redacted capture with an Authorization/Cookie header permanently
 * unmatchable) — is present in `incoming` with the exact same value.
 * `recorded` headers outside that significant set are ignored entirely, and
 * `incoming` may carry any number of headers `recorded` never mentions:
 * this is a subset check, not equality.
 *
 * `undefined`/empty `recorded` — the common case for any entry from before
 * SP-lsc.8, or one where every recorded header happened to be volatile or
 * secret — always matches. That's what keeps matching permissive by
 * default: a pre-existing capture with no header data at all replays
 * exactly as it did before this module existed.
 */
export function headersSubsetMatch(
  recorded: Record<string, string> | undefined,
  incoming: Record<string, string>,
): boolean {
  if (!recorded) return true;

  const incomingByLowerName = new Map<string, string>();
  for (const [key, value] of Object.entries(incoming)) {
    incomingByLowerName.set(key.toLowerCase(), value);
  }

  for (const [key, value] of Object.entries(recorded)) {
    const lower = key.toLowerCase();
    if (isVolatileRequestHeaderName(lower) || isSecretHeaderName(lower)) continue;
    if (incomingByLowerName.get(lower) !== value) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Response-header replay
// ---------------------------------------------------------------------------

/**
 * Headers that describe this hop of the connection (transport framing,
 * connection lifecycle) rather than the resource itself. Replaying them
 * verbatim from a captured response would fight with what Node's http
 * server manages on the actual replay connection (chunked vs
 * Content-Length framing, keep-alive behavior) — and for Content-Length
 * specifically, forwarding the captured value would often be outright
 * wrong, since the replayed body isn't guaranteed to be the same byte
 * length as what was originally captured. These are always stripped;
 * Node re-derives correct values for the values that matter.
 */
export const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

/**
 * Build the header set for replaying a recorded response: every captured
 * response header (CapturedTraffic.responseHeaders) except hop-by-hop ones
 * (stripped — see HOP_BY_HOP_RESPONSE_HEADERS) and Content-Type (always set
 * explicitly from `entry.contentType`, the field every capture format
 * version has had, rather than whatever casing/value happened to land in
 * responseHeaders — which is optional and may be absent on a pre-SP-lsc.8
 * capture). Set-Cookie — the one header that can legitimately repeat — is
 * unpacked back into a real string array (packHeadersArray packed it at
 * capture time) so Node's http server emits one Set-Cookie line per value
 * instead of folding them into one, which would corrupt each cookie's own
 * Expires= comma.
 *
 * `extra` is applied last and wins over anything captured — used for
 * X-Mockify-Tier, mockify's own diagnostic header, which is never part of a
 * captured response. Every output key is lower-cased (HTTP header names are
 * case-insensitive, and Node's http server is fine writing lower-cased
 * names to the wire) so a captured header can never end up alongside an
 * `extra` entry for the "same" header under different casing as two
 * distinct object keys — which is exactly the kind of thing that would
 * silently emit a duplicate header line instead of the intended override.
 */
export function buildReplayResponseHeaders(
  entry: { contentType?: string; responseHeaders?: Record<string, string> },
  extra: Record<string, string> = {},
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};

  if (entry.responseHeaders) {
    for (const [key, value] of Object.entries(entry.responseHeaders)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower) || lower === 'content-type') continue;
      out[lower] = lower === 'set-cookie' ? unpackMultiValueHeader(value) : value;
    }
  }

  out['content-type'] = entry.contentType || 'application/octet-stream';

  for (const [key, value] of Object.entries(extra)) {
    out[key.toLowerCase()] = value;
  }

  return out;
}
