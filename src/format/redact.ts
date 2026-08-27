/**
 * src/format/redact.ts — credential redaction for captured traffic (SP-lsc.7)
 *
 * Captures record raw traffic to disk under captures/<name>/traffic.json,
 * and mockify can start authenticated sessions (src/agent/storage-state.ts,
 * `--storage-state`, including a macOS Keychain item). That means a capture
 * directory can end up holding live bearer tokens, session cookies, and API
 * keys — and capture directories get committed to git often enough that this
 * needs to be the default, not an opt-in.
 *
 * This module is the shared redaction logic applied at every capture write
 * path (src/agent/capture.ts's CaptureCollector, src/recorders/cdp-capture.ts,
 * and — ported to plain JS, since it has no build step — src/recorders/
 * browse-and-capture.mjs). It does two things:
 *
 *   1. Replaces credential-bearing header VALUES (Authorization, Cookie,
 *      Set-Cookie, X-Api-Key, ...) with a stable placeholder.
 *   2. Walks request/response body JSON (including nested objects) and
 *      replaces the VALUE of any key that looks secret (token, password,
 *      apiKey/api_key, secret, authorization, session, bearer — matched
 *      case-insensitively, ignoring separators) with the same placeholder.
 *      A best-effort pass also covers form-urlencoded bodies (classic HTML
 *      login forms), since request bodies aren't always JSON.
 *
 * The placeholder is stable ("[REDACTED]") rather than random or omitted, so
 * replay shape is preserved: a mock server replaying a captured response
 * still returns a same-shaped JSON object with the same keys, just without
 * the real secret value.
 *
 * Headers are captured by both the agent/MCP/manual capture path
 * (CaptureCollector, src/agent/capture.ts — SP-lsc.8) and the legacy
 * cdp-capture.ts recorder; both redact them through redactHeaders() before
 * anything reaches disk, via redactTrafficEntry() below in the former case.
 * What makes a captured header significant for *matching* an incoming
 * replay request, and which captured response headers actually get
 * replayed, live in src/format/headers.ts, not here — this module only
 * ever decides what a header's VALUE should look like once it's known to
 * be secret.
 */

import { MULTI_VALUE_HEADER_SEPARATOR } from './types.js';

export const REDACTED = '[REDACTED]';

/** Header names (lowercase) whose values are always credential-bearing. */
const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Substrings (matched against a normalized key) that mark a body field as
 * credential-bearing. Normalization lowercases the key and strips anything
 * that isn't a letter or digit, so "api_key", "apiKey", and "API-KEY" all
 * normalize to "apikey" and match the single "apikey" entry here. */
const SECRET_BODY_KEY_SUBSTRINGS = [
  'token',
  'password',
  'apikey',
  'secret',
  'authorization',
  'session',
  'bearer',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether a JSON/form body key looks like it holds a credential. */
export function isSecretBodyKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_BODY_KEY_SUBSTRINGS.some((s) => normalized.includes(s));
}

/** Whether an HTTP header name is credential-bearing. */
export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_NAMES.has(name.toLowerCase());
}

/** Redact credential-bearing header values in place (returns a new object;
 * `headers` itself is left untouched). Non-secret headers pass through
 * unchanged. Accepts undefined/null so callers don't need to guard.
 *
 * Set-Cookie gets one deliberate exception to the flat "whole value becomes
 * REDACTED" rule: a captured response can carry *multiple* Set-Cookie
 * lines, packed at capture time (src/format/headers.ts's
 * packMultiValueHeader) into one MULTI_VALUE_HEADER_SEPARATOR-joined
 * string. Replacing that entire packed string with a single REDACTED would
 * silently collapse N cookies down to one on replay — still safe (no real
 * value leaks), but a real loss of shape for no security benefit. Each
 * packed value is redacted independently instead, so the *count* of
 * Set-Cookie lines a redacted capture replays still matches what was
 * actually observed. A single (unpacked) Set-Cookie value has nothing to
 * split on and redacts to plain REDACTED, same as before. */
export function redactHeaders<T extends Record<string, string> | undefined | null>(headers: T): T {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isSecretHeaderName(key)) {
      out[key] = value;
      continue;
    }
    out[key] = key.toLowerCase() === 'set-cookie'
      ? value.split(MULTI_VALUE_HEADER_SEPARATOR).map(() => REDACTED).join(MULTI_VALUE_HEADER_SEPARATOR)
      : REDACTED;
  }
  return out as T;
}

/** Recursively redact secret-looking keys in a parsed JSON value. Arrays are
 * walked element-by-element; objects have each key checked against
 * isSecretBodyKey before recursing into non-matching values. */
function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretBodyKey(key) ? REDACTED : redactJsonValue(val);
    }
    return out;
  }
  return value;
}

/** A conservative check for `key=value&key2=value2` bodies (classic HTML
 * form submissions) — deliberately stricter than "contains an =", so we
 * don't misfire on arbitrary opaque strings that happen to contain one. */
function looksFormEncoded(body: string): boolean {
  if (!body.includes('=')) return false;
  return body.split('&').every((segment) => {
    const eq = segment.indexOf('=');
    if (eq <= 0) return false;
    return /^[A-Za-z0-9_.\-%]+$/.test(segment.slice(0, eq));
  });
}

function redactFormEncoded(body: string): string {
  try {
    const params = new URLSearchParams(body);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (isSecretBodyKey(key)) {
        params.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? params.toString() : body;
  } catch {
    return body;
  }
}

/**
 * Redact secret-looking fields from a captured request/response body string.
 * Tries JSON first (the common case for API traffic); falls back to a
 * best-effort form-urlencoded pass for login-form-style bodies. Anything
 * else (plain text, opaque binary-as-string, unparseable) is returned
 * unchanged rather than risk corrupting it — this is a defensive best-effort
 * pass, not a guarantee that no secret can ever survive in free text.
 */
export function redactBodyString<T extends string | null | undefined>(body: T): T {
  if (body === null || body === undefined || body === '') return body;

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(redactJsonValue(parsed)) as T;
    }
    // A bare JSON scalar ("42", "\"ok\"", "true") has no keys to redact.
    return body;
  } catch {
    // Not JSON — fall through to the form-encoded check below.
  }

  if (looksFormEncoded(body)) {
    return redactFormEncoded(body) as T;
  }

  return body;
}

/** Shape shared by CapturedTraffic (src/format/types.ts) — anything with a
 * request/response body pair and/or header maps that redaction can walk. */
export interface RedactableBody {
  postData?: string | null;
  responseBody?: string | null;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/** Redact the request/response body AND headers of a single captured
 * traffic entry, preserving every other field. Safe to call on entries
 * that lack any of these fields (they stay undefined) — in particular,
 * every entry predating SP-lsc.8 has no header fields at all, and this is a
 * no-op for them beyond the body redaction it already did. */
export function redactTrafficEntry<T extends RedactableBody>(entry: T): T {
  const next: T = { ...entry };
  if ('postData' in entry) {
    next.postData = redactBodyString(entry.postData);
  }
  if ('responseBody' in entry) {
    next.responseBody = redactBodyString(entry.responseBody);
  }
  if ('requestHeaders' in entry) {
    next.requestHeaders = redactHeaders(entry.requestHeaders);
  }
  if ('responseHeaders' in entry) {
    next.responseHeaders = redactHeaders(entry.responseHeaders);
  }
  return next;
}

/** True when MOCKIFY_NO_REDACT is set to a truthy value ("1" or "true",
 * case-insensitive) — the env-var escape hatch used by capture paths that
 * can't otherwise thread a `--no-redact` CLI flag through to where the
 * capture collector is constructed (the agent-driven capture path builds
 * its CaptureCollector inside src/agent/runner.ts, in the same process as
 * the CLI, so setting this env var before launching the run has the same
 * effect as passing an explicit option). */
export function envDisablesRedaction(): boolean {
  const raw = process.env.MOCKIFY_NO_REDACT;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}
