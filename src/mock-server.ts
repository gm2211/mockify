/**
 * src/mock-server.ts — HTTP replay mock server
 *
 * What it does:
 *   - Replays captured traffic from browse-and-capture.mjs or cdp-capture.ts
 *   - Manages sessions with configurable cookie names
 *   - Supports fault injection (302, 500, timeout, empty, malformed responses)
 *   - Provides diagnostic endpoints (/_traffic, /_faults, /_sessions)
 *   - Matches requests by path, then query params / POST body for best match
 *
 * Usage:
 *   npm run mock                    — start with real responses
 *   npm run mock:chaos              — start with 10% fault injection
 *   npx tsx src/mock-server.ts
 *
 * Configuration (via .env or environment variables):
 *   PORT                       — server port (default: 3456)
 *   MOCK_DATA_PATH             — path to traffic.json or a capture directory (default: searches captures/)
 *   MOCK_SESSION_COOKIE_NAME   — primary session cookie name (default: session)
 *   MOCK_SESSION_COOKIE_2_NAME — optional secondary cookie name (default: empty)
 *   MOCK_SESSION_TTL_MS        — session TTL in ms (default: 600000 = 10 min)
 *   MOCK_FAULT_RATE            — fault injection rate 0.0–1.0 (default: 0 = off)
 *   MOCK_FAULT_TYPES           — comma-separated fault types: 302,500,timeout,empty,malformed
 *   MOCK_AUTH                  — set to 1 to enable the synthetic login gate (default: off)
 *   MOCK_LOGIN_PATH            — login page path (default: /login)
 *   MOCK_POST_LOGIN_REDIRECT   — where to redirect after successful login (default: /)
 *   MOCK_REFRESH_PATH          — cookie refresh endpoint path (default: /auth/refresh)
 *   MOCK_SYNTHETIC             — set to 0 to disable synthetic (generalized) replay (default: on)
 *   MOCK_VERBOSE               — set to 1 to log every request (default: banner + config only)
 *   MOCKIFY_IMPL_TIMEOUT_MS    — wall-clock budget for a generated implementation's handle() call
 *                                 before it's treated as hung and skipped (default: 2000)
 *
 * Diagnostic endpoints (no auth required):
 *   GET /           → route index
 *   GET /_traffic   → raw traffic data
 *   GET /_faults    → fault injection state
 *   GET /_sessions  → active sessions
 *   GET /_synthetic → loaded synthetic templates + hit stats
 *   GET /_impl      → loaded implementation info + report.json summary
 *
 * -- Four-tier response pipeline --------------------------------------------
 * Every response is labeled with `X-Mockify-Tier: recorded|implementation|
 * synthetic`, first match wins:
 *
 *   1. implementation — `<captureDir>/impl/handlers.mjs` (see src/infer/),
 *                        a generated implementation with real routing + an
 *                        in-memory store. Tried first when loaded: it's the
 *                        only tier that can stay self-consistent across a
 *                        POST-then-GET sequence, so a state change has to
 *                        reach it before anything else gets a chance to
 *                        answer. Wrapped in try/catch and a wall-clock
 *                        timeout (MOCKIFY_IMPL_TIMEOUT_MS); a throw,
 *                        timeout, or explicit decline (returning null)
 *                        falls through to the next tier rather than ever
 *                        500ing.
 *   2. recorded       — an exact recorded request/response match, scored
 *                        against query params / POST body. Backs up
 *                        whatever the implementation tier declined (or
 *                        answers everything when no implementation is
 *                        loaded).
 *   3. synthetic       — shape-based synthesis from OTHER recorded requests
 *                        that match the same endpoint template (see
 *                        src/synthesize/), e.g. `/api/room/7` succeeding
 *                        even though only rooms 1-3 were ever captured.
 *   4. (none)          — 404 with hints about similar known routes.
 *
 * `mockify replay --mode <auto|record|impl|synthetic>` (src/cli.ts) narrows
 * which of tiers 1/3 are consulted; recorded (tier 2) and the 404 fallback
 * are always present. `--mode record` skips both the implementation and
 * synthetic tiers entirely, giving byte-exact recorded replay when
 * determinism matters more than coherence. Set MOCK_SYNTHETIC=0 to disable
 * tier 3 outright regardless of mode.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import type { CapturedTraffic } from './format/types.js';
import {
  loadSyntheticIndex,
  matchSyntheticTemplate,
  synthesizeResponseBody,
  type SyntheticIndex,
} from './synthesize/generate.js';
import {
  loadImplementation,
  ImplementationLoadError,
  type HandleRequest,
  type HandleResponse,
  type Implementation,
} from './infer/contract.js';

// Capture discovery is relative to the current working directory (the
// directory `mockify serve` is run from), not this module's own location —
// resolving from __dirname breaks once this file is compiled into dist/,
// since __dirname then points inside dist/ instead of the project root.
// MOCK_DATA_PATH still overrides this entirely (see loadTraffic below).
const PROJECT_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_PORT = parseInt(process.env.PORT ?? '3456', 10);
const SESSION_COOKIE_NAME = process.env.MOCK_SESSION_COOKIE_NAME ?? 'session';
const SESSION_COOKIE_2_NAME = process.env.MOCK_SESSION_COOKIE_2_NAME ?? '';
const SESSION_TTL_MS = parseInt(process.env.MOCK_SESSION_TTL_MS ?? String(10 * 60 * 1000), 10);
const LOGIN_PATH = (process.env.MOCK_LOGIN_PATH ?? '/login').toLowerCase();
const POST_LOGIN_REDIRECT = process.env.MOCK_POST_LOGIN_REDIRECT ?? '/';
const REFRESH_PATH = process.env.MOCK_REFRESH_PATH ?? '/auth/refresh';
const SYNTHETIC_ENABLED = process.env.MOCK_SYNTHETIC !== '0';
const IMPL_TIMEOUT_MS = parseInt(process.env.MOCKIFY_IMPL_TIMEOUT_MS ?? '2000', 10);

/** Which tiers `mockify replay --mode` allows the request handler to consult
 * beyond the always-on recorded tier and the always-on 404 fallback. See the
 * module doc's "Four-tier response pipeline" section. */
export type ReplayMode = 'auto' | 'record' | 'impl' | 'synthetic';

function modeAllowsImpl(mode: ReplayMode): boolean {
  return mode === 'auto' || mode === 'impl';
}

function modeAllowsSynthetic(mode: ReplayMode): boolean {
  return mode === 'auto' || mode === 'synthetic';
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------
interface Session {
  primaryCookie: string;
  secondaryCookie?: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function createSession(): Session {
  const session: Session = {
    primaryCookie: generateToken(),
    secondaryCookie: SESSION_COOKIE_2_NAME ? generateToken() : undefined,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.primaryCookie, session);
  return session;
}

function parseCookies(req: http.IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  const header = req.headers.cookie ?? '';
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return cookies;
}

function findValidSession(req: http.IncomingMessage): Session | null {
  const cookies = parseCookies(req);
  const primaryValue = cookies.get(SESSION_COOKIE_NAME);
  if (!primaryValue) return null;

  const session = sessions.get(primaryValue);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(primaryValue);
    return null;
  }

  // If a secondary cookie is configured, validate it too
  if (SESSION_COOKIE_2_NAME && session.secondaryCookie) {
    const secondaryValue = cookies.get(SESSION_COOKIE_2_NAME);
    if (secondaryValue && secondaryValue !== session.secondaryCookie) return null;
  }

  return session;
}

function setSessionCookies(res: http.ServerResponse, session: Session): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${session.primaryCookie}; Path=/; HttpOnly; Max-Age=${maxAge}`,
  ];
  if (SESSION_COOKIE_2_NAME && session.secondaryCookie) {
    cookieParts.push(
      `${SESSION_COOKIE_2_NAME}=${session.secondaryCookie}; Path=/; HttpOnly; Max-Age=${maxAge}`
    );
  }
  res.setHeader('Set-Cookie', cookieParts);
}

function redirectToLogin(res: http.ServerResponse): void {
  res.writeHead(302, { Location: LOGIN_PATH });
  res.end();
}

// ---------------------------------------------------------------------------
// Login HTML form
// ---------------------------------------------------------------------------
function buildLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Login</title>
<style>
  body { font-family: sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; }
  input { width: 100%; padding: 8px; margin: 6px 0 16px; box-sizing: border-box; }
  button { padding: 10px 24px; background: #2563eb; color: white; border: none; cursor: pointer; border-radius: 4px; }
  button:hover { background: #1d4ed8; }
</style>
</head>
<body>
  <h1>Login</h1>
  <form method="POST" action="${LOGIN_PATH}">
    <div>
      <label for="username">Username / Email</label><br>
      <input type="text" id="username" name="username" required autofocus>
    </div>
    <div>
      <label for="password">Password</label><br>
      <input type="password" id="password" name="password" required>
    </div>
    <button type="submit">Log In</button>
  </form>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Auth-exempt paths
// ---------------------------------------------------------------------------
const AUTH_EXEMPT_PATHS = new Set(['/', '/_traffic', '/_faults', '/_sessions', '/_synthetic', '/_impl']);
// Synthetic login gate is opt-in: most captures replay cleanly without it.
const AUTH_ENABLED = process.env.MOCK_AUTH === '1';

// Per-request logging is opt-in. A replay server that narrates every request
// buries its own startup banner, making `grep` the only way to read it; the
// banner and config lines always print, request traffic only with MOCK_VERBOSE=1.
const VERBOSE = process.env.MOCK_VERBOSE === '1';

function rlog(message: string): void {
  if (VERBOSE) console.error(message);
}

// ---------------------------------------------------------------------------
// Traffic entry shape
// ---------------------------------------------------------------------------
// TrafficEntry used to be a standalone interface here, structurally
// duplicating CapturedTraffic (src/format/types.ts) minus `injectedFault`.
// It's now a straight alias onto the shared contract — CapturedTraffic is a
// superset (it adds the optional `injectedFault` field), so this alias keeps
// runtime behavior identical while removing the duplicate definition.
type TrafficEntry = CapturedTraffic;

// ---------------------------------------------------------------------------
// Route index
// ---------------------------------------------------------------------------
type RouteIndex = Map<string, TrafficEntry[]>;

function buildIndex(entries: TrafficEntry[]): RouteIndex {
  const index: RouteIndex = new Map();
  for (const entry of entries) {
    let parsedPath: string;
    try {
      parsedPath = new URL(entry.url).pathname;
    } catch {
      continue;
    }
    const key = `${entry.method.toUpperCase()} ${parsedPath}`;
    const existing = index.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      index.set(key, [entry]);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Query param matching
// ---------------------------------------------------------------------------
function scoreQueryMatch(capturedUrl: string, incomingParams: URLSearchParams): number {
  let captured: URLSearchParams;
  try {
    captured = new URL(capturedUrl).searchParams;
  } catch {
    return 0;
  }
  let score = 0;
  for (const [k, v] of incomingParams) {
    if (captured.get(k) === v) score += 2;
    else if (captured.has(k)) score += 1;
  }
  return score;
}

function bestGetMatch(entries: TrafficEntry[], incomingParams: URLSearchParams): TrafficEntry {
  if (entries.length === 1) return entries[0];
  let best = entries[0];
  let bestScore = scoreQueryMatch(entries[0].url, incomingParams);
  for (let i = 1; i < entries.length; i++) {
    const score = scoreQueryMatch(entries[i].url, incomingParams);
    if (score > bestScore) {
      bestScore = score;
      best = entries[i];
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// POST body field matching
// ---------------------------------------------------------------------------

/** True JSON equality for scoring purposes — good enough for the flat
 * request-body shapes recorded captures actually contain (strings, numbers,
 * booleans, nested objects/arrays compare by serialized form). */
function jsonBodyValueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Score two parsed JSON bodies by semantic similarity: a key present on
 * both sides with an equal value scores highest, a key present on both
 * sides with a differing value scores lower, and a key present on only one
 * side contributes nothing (lowest tier). Returns null — rather than a low
 * number — when every key the two bodies have in common disagrees: a
 * candidate that shares shape with the incoming request but contradicts it
 * on every field (e.g. an empty-form submission recorded against a real
 * one) should never be picked as "the" match. Returning nothing is better
 * than returning a wrong recorded response. */
function scoreJsonBodyMatch(captured: unknown, incoming: unknown): number | null {
  if (
    typeof captured !== 'object' || captured === null || Array.isArray(captured) ||
    typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)
  ) {
    return null;
  }
  const capturedObj = captured as Record<string, unknown>;
  const incomingObj = incoming as Record<string, unknown>;
  const sharedKeys = Object.keys(incomingObj).filter((k) => k in capturedObj);

  let score = 0;
  let agreements = 0;
  for (const k of sharedKeys) {
    if (jsonBodyValueEqual(capturedObj[k], incomingObj[k])) {
      score += 3;
      agreements++;
    } else {
      score += 1;
    }
  }

  if (sharedKeys.length > 0 && agreements === 0) return null;
  return score;
}

/** Returns null for "not a match at all" (see scoreJsonBodyMatch) — distinct
 * from a merely low score, which still wins if it's the least-bad option. */
function scorePostMatch(capturedPostData: string | null, incomingBody: string): number | null {
  if (!capturedPostData) return 0;

  // When both sides parse as JSON objects, compare them semantically rather
  // than falling through to form-encoded scoring below, which would treat
  // an entire JSON body as one opaque token and can't tell two different
  // JSON submissions apart (every JSON POST to the same path would score
  // identically).
  let incomingJson: unknown;
  let capturedJson: unknown;
  try {
    incomingJson = JSON.parse(incomingBody);
  } catch {
    incomingJson = undefined;
  }
  try {
    capturedJson = JSON.parse(capturedPostData);
  } catch {
    capturedJson = undefined;
  }
  if (incomingJson !== undefined && capturedJson !== undefined) {
    return scoreJsonBodyMatch(capturedJson, incomingJson);
  }

  try {
    const captured = new URLSearchParams(capturedPostData);
    const incoming = new URLSearchParams(incomingBody);
    let score = 0;
    for (const [k, v] of incoming) {
      if (captured.get(k) === v) score += 2;
      else if (captured.has(k)) score += 1;
    }
    return score;
  } catch {
    return 0;
  }
}

/** Best-scoring recorded entry for a POST, or null when every candidate was
 * rejected outright (see scorePostMatch) — a caller seeing null should fall
 * through to the next tier rather than serve a contradicting response. */
function bestPostMatch(entries: TrafficEntry[], incomingBody: string): TrafficEntry | null {
  let best: TrafficEntry | null = null;
  let bestScore = -Infinity;
  for (const entry of entries) {
    const score = scorePostMatch(entry.postData, incomingBody);
    if (score === null) continue;
    if (best === null || score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Load traffic
// ---------------------------------------------------------------------------
function loadTraffic(explicitDataPath?: string, quiet = false): { entries: TrafficEntry[]; index: RouteIndex; captureDir: string } {
  const candidates = [
    explicitDataPath,
    process.env.MOCK_DATA_PATH,
    path.join(PROJECT_ROOT, 'captures', 'mock-traffic.json'),
    path.join(PROJECT_ROOT, 'captures', 'traffic.json'),
    // Also search in timestamped subdirs
  ].filter(Boolean) as string[];

  // Also look for the most recent traffic.json in captures/*/traffic.json
  const capturesDir = path.join(PROJECT_ROOT, 'captures');
  if (fs.existsSync(capturesDir)) {
    try {
      const subdirs = fs
        .readdirSync(capturesDir)
        .filter((d) => {
          try {
            return fs.statSync(path.join(capturesDir, d)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
        .reverse(); // most recent first (ISO timestamp sort)
      for (const subdir of subdirs) {
        candidates.push(path.join(capturesDir, subdir, 'traffic.json'));
      }
    } catch { /* ignore */ }
  }

  let trafficPath: string | undefined;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    let resolved = candidate;
    try {
      if (fs.statSync(candidate).isDirectory()) {
        // A candidate that's a directory (e.g. --data pointing straight at a
        // capture directory rather than its traffic.json) is only accepted
        // if traffic.json actually exists inside it — otherwise keep
        // searching the remaining candidates instead of failing here.
        const withinDir = path.join(candidate, 'traffic.json');
        if (!fs.existsSync(withinDir)) continue;
        resolved = withinDir;
      }
    } catch {
      continue;
    }

    trafficPath = resolved;
    break;
  }

  if (!trafficPath) {
    console.error('[mock] ERROR: No traffic data found. Searched:');
    for (const c of candidates.slice(0, 5)) {
      console.error(`[mock]   - ${c}`);
    }
    console.error(
      '[mock] Run "npm run browse" or "npm run capture" to generate traffic data,\n' +
      '[mock] or set MOCK_DATA_PATH to the path of your traffic.json file.'
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(trafficPath, 'utf8');
  const entries: TrafficEntry[] = JSON.parse(raw);
  const index = buildIndex(entries);

  if (!quiet) console.error(
    `[mock] Loaded ${entries.length} traffic entries from ${path.basename(trafficPath)} → ${index.size} unique routes`
  );
  return { entries, index, captureDir: path.dirname(trafficPath) };
}

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------
type FaultType = '302' | '500' | 'timeout' | 'empty' | 'malformed';

const ALL_FAULT_TYPES: FaultType[] = ['302', '500', 'timeout', 'empty', 'malformed'];

// Weighted distribution: 302=35%, 500=25%, empty=20%, malformed=15%, timeout=5%
const FAULT_WEIGHTS: [FaultType, number][] = [
  ['302', 0.35],
  ['500', 0.60],
  ['empty', 0.80],
  ['malformed', 0.95],
  ['timeout', 1.00],
];

interface FaultStats {
  totalRequests: number;
  faultsInjected: number;
  faultsByType: Record<FaultType, number>;
}

const faultStats: FaultStats = {
  totalRequests: 0,
  faultsInjected: 0,
  faultsByType: { '302': 0, '500': 0, timeout: 0, empty: 0, malformed: 0 },
};

function parseFaultConfig(): { faultRate: number; enabledTypes: FaultType[] } {
  const faultRate = parseFloat(process.env.MOCK_FAULT_RATE ?? '0');
  let enabledTypes: FaultType[] = ALL_FAULT_TYPES;

  if (process.env.MOCK_FAULT_TYPES) {
    const requested = process.env.MOCK_FAULT_TYPES.split(',').map((s) => s.trim());
    const filtered = requested.filter((t): t is FaultType =>
      ALL_FAULT_TYPES.includes(t as FaultType)
    );
    if (filtered.length > 0) {
      enabledTypes = filtered;
    } else {
      console.error(
        `[mock] WARNING: MOCK_FAULT_TYPES="${process.env.MOCK_FAULT_TYPES}" has no valid types. Using all.`
      );
    }
  }

  return { faultRate, enabledTypes };
}

function pickRandomFault(enabledTypes: FaultType[]): FaultType {
  if (enabledTypes.length === 1) return enabledTypes[0];

  const segments: { type: FaultType; weight: number }[] = [];
  for (let i = 0; i < FAULT_WEIGHTS.length; i++) {
    const [type, cumulative] = FAULT_WEIGHTS[i];
    if (!enabledTypes.includes(type)) continue;
    const prev = i > 0 ? FAULT_WEIGHTS[i - 1][1] : 0;
    segments.push({ type, weight: cumulative - prev });
  }

  const totalWeight = segments.reduce((sum, s) => sum + s.weight, 0);
  const r = Math.random() * totalWeight;
  let cumulative = 0;
  for (const { type, weight } of segments) {
    cumulative += weight;
    if (r <= cumulative) return type;
  }
  return segments[segments.length - 1].type;
}

async function injectFault(
  faultType: FaultType,
  entry: TrafficEntry,
  res: http.ServerResponse,
  method: string,
  pathname: string
): Promise<void> {
  return new Promise((resolve) => {
    faultStats.faultsInjected++;
    faultStats.faultsByType[faultType]++;
    console.error(`[mock] FAULT: ${faultType} on ${method} ${pathname}`);

    switch (faultType) {
      case '500': {
        const body = JSON.stringify({ error: true, message: 'Internal server error (fault injection)' });
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'X-Mockify-Tier': 'recorded' });
        res.end(body);
        resolve();
        break;
      }
      case '302': {
        res.writeHead(302, { Location: LOGIN_PATH, 'Content-Length': '0', 'X-Mockify-Tier': 'recorded' });
        res.end();
        resolve();
        break;
      }
      case 'timeout': {
        const delayMs = 5000 + Math.floor(Math.random() * 5000);
        console.error(`[mock]   (timeout: delaying ${delayMs}ms)`);
        setTimeout(() => {
          res.writeHead(entry.status, {
            'Content-Type': entry.contentType || 'application/octet-stream',
            'X-Mockify-Tier': 'recorded',
          });
          res.end(entry.responseBody ?? '');
          resolve();
        }, delayMs);
        break;
      }
      case 'empty': {
        res.writeHead(200, { 'Content-Type': entry.contentType || 'application/octet-stream', 'X-Mockify-Tier': 'recorded' });
        res.end('');
        resolve();
        break;
      }
      case 'malformed': {
        const raw = entry.responseBody ?? '{}';
        const cutPoint = Math.max(1, Math.floor(raw.length / 2));
        res.writeHead(200, { 'Content-Type': entry.contentType || 'application/octet-stream', 'X-Mockify-Tier': 'recorded' });
        res.end(raw.slice(0, cutPoint));
        resolve();
        break;
      }
      default: {
        resolve();
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Implementation tier (src/infer/contract.ts) — loading, timeout, headers
// ---------------------------------------------------------------------------

/** Minimal shape this module reads out of `<implDir>/report.json` (written
 * by `mockify infer`, src/infer/generate.ts's buildReport/InferSummary) for
 * the `/_impl` diagnostic endpoint and the `mockify replay` banner. Declared
 * locally — and loosely, with every field optional — rather than imported
 * from src/infer/generate.ts, so the replay hot path never pulls in that
 * module's Agent SDK dependency just to describe a JSON file that may not
 * even exist yet. */
export interface ImplReportSummary {
  model?: string;
  generatedAt?: string;
  roundsUsed?: number;
  roundsMax?: number;
  train?: { overall?: Record<string, number>; total?: number };
  holdout?: { overall?: Record<string, number>; total?: number };
  gap?: {
    trainRate?: number;
    holdoutRate?: number | null;
    gap?: number | null;
    verdict?: 'likely_hardcoded' | 'ok' | 'insufficient_holdout';
    threshold?: number;
  };
}

export interface LoadedImplementation {
  /** Resolved path handlers.mjs was loaded from (or would be loaded from). */
  implPath: string;
  /** The loaded module, or null if nothing is loaded (not found, or failed
   * to load/validate — see `loadError` for the latter case). */
  impl: Implementation | null;
  /** Set when a file exists at implPath but failed to load or didn't satisfy
   * the contract. Left unset for the ordinary "nothing generated yet" case
   * (ImplementationLoadError code 'not_found') — that's expected, not an
   * error worth surfacing. */
  loadError: string | null;
  /** Parsed `<dirname(implPath)>/report.json`, if present and parseable. */
  report: ImplReportSummary | null;
}

function loadReportSummary(implPath: string): ImplReportSummary | null {
  const reportPath = path.join(path.dirname(implPath), 'report.json');
  if (!fs.existsSync(reportPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as ImplReportSummary;
  } catch {
    return null;
  }
}

/** Resolve + load the implementation module (default `<captureDir>/impl/
 * handlers.mjs`, or `implPathOverride` — `mockify replay --impl <path>`).
 * Always attempts the load regardless of `--mode`, so `/_impl` and the
 * replay banner can report accurate diagnostics even in a mode that doesn't
 * consult the implementation tier at request time; the mode only gates
 * whether the request handler ever calls `impl.handle()`. Never throws —
 * "nothing generated yet" and "found something broken" both resolve to a
 * `LoadedImplementation` a caller can branch on. */
async function loadImplementationForServer(
  captureDir: string,
  implPathOverride: string | undefined
): Promise<LoadedImplementation> {
  const implPath = implPathOverride
    ? path.resolve(implPathOverride)
    : path.join(captureDir, 'impl', 'handlers.mjs');

  try {
    const impl = await loadImplementation(implPath);
    return { implPath, impl, loadError: null, report: loadReportSummary(implPath) };
  } catch (err) {
    if (err instanceof ImplementationLoadError && err.code === 'not_found') {
      return { implPath, impl: null, loadError: null, report: null };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { implPath, impl: null, loadError: message, report: loadReportSummary(implPath) };
  }
}

/** Flatten Node's `IncomingHttpHeaders` (string | string[] | undefined per
 * key) into the flat string map the Implementation contract expects.
 * Multi-value headers join with ", " (the same convention HTTP itself uses
 * for repeated headers folded into one line). */
function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flat;
}

type ImplCallOutcome =
  | { outcome: 'answered'; response: HandleResponse }
  | { outcome: 'declined' }
  | { outcome: 'threw'; error: string }
  | { outcome: 'timed_out' };

/** Call `impl.handle(req)` under a wall-clock budget, converting every way
 * it can fail to answer (throw, timeout, explicit `null` decline) into a
 * plain outcome the request handler can fall through on — a generated
 * implementation must never be able to hang or crash the replay server. The
 * timed-out call is abandoned, not cancelled (there's no way to cancel a
 * plain Promise); its `.catch` here exists solely to keep a late
 * rejection from surfacing as an unhandled rejection after the response
 * has already moved on to the next tier. */
async function callImplementation(impl: Implementation, req: HandleRequest, timeoutMs: number): Promise<ImplCallOutcome> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<ImplCallOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timed_out' }), timeoutMs);
  });

  const run: Promise<ImplCallOutcome> = (async () => {
    try {
      const response = await impl.handle(req);
      return response === null || response === undefined ? { outcome: 'declined' } : { outcome: 'answered', response };
    } catch (err) {
      return { outcome: 'threw', error: err instanceof Error ? err.message : String(err) };
    }
  })();
  run.catch(() => {
    // Never reached in practice — the try/catch above already converts every
    // rejection into a resolved outcome — but this keeps that guarantee from
    // becoming an unhandled-rejection footgun if it's ever loosened.
  });

  const result = await Promise.race([run, timeout]);
  clearTimeout(timer!);
  return result;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const { faultRate, enabledTypes } = parseFaultConfig();

interface SyntheticStats {
  templatesLoaded: number;
  hits: number;
}

interface ImplStats {
  hits: number;
  declines: number;
  throws: number;
  timeouts: number;
}

function createServer(
  entries: TrafficEntry[],
  index: RouteIndex,
  synthetic: SyntheticIndex | null,
  mode: ReplayMode,
  loadedImpl: LoadedImplementation
): http.Server {
  const loginHtml = buildLoginHtml();
  const syntheticStats: SyntheticStats = {
    templatesLoaded: synthetic?.templates.length ?? 0,
    hits: 0,
  };
  const implStats: ImplStats = { hits: 0, declines: 0, throws: 0, timeouts: 0 };
  // "log once per path" (see the module doc's implementation-tier section):
  // a generated implementation that throws or hangs on one route shouldn't
  // spam the log on every subsequent request to that same route.
  const implWarnedPaths = new Set<string>();

  return http.createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl, 'http://localhost');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request URL');
      return;
    }

    const pathname = parsedUrl.pathname;

    // ── Login routes ──────────────────────────────────────────────────────
    if (pathname.toLowerCase() === LOGIN_PATH) {
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginHtml);
        rlog(`[mock] GET ${LOGIN_PATH} → login form`);
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const username = params.get('username') ?? params.get('Username') ?? '';
        const password = params.get('password') ?? params.get('Password') ?? '';

        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('username and password are required');
          rlog(`[mock] POST ${LOGIN_PATH} → 400 (missing credentials)`);
          return;
        }

        const session = createSession();
        setSessionCookies(res, session);
        res.writeHead(302, { Location: POST_LOGIN_REDIRECT });
        res.end();
        console.error(
          `[mock] POST ${LOGIN_PATH} → 302 (session created, ${SESSION_COOKIE_NAME}=${session.primaryCookie.slice(0, 8)}...)`
        );
        return;
      }
    }

    // ── Cookie refresh ────────────────────────────────────────────────────
    if (REFRESH_PATH && method === 'GET' && pathname.toLowerCase() === REFRESH_PATH.toLowerCase()) {
      const session = findValidSession(req);
      if (session) {
        session.expiresAt = Date.now() + SESSION_TTL_MS;
        setSessionCookies(res, session);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        rlog(`[mock] GET ${REFRESH_PATH} → 200 (session extended)`);
      } else {
        redirectToLogin(res);
        rlog(`[mock] GET ${REFRESH_PATH} → 302 (invalid session)`);
      }
      return;
    }

    // ── Diagnostic routes ─────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/') {
      const routes = Array.from(index.keys())
        .sort()
        .map((k) => `${k} (${(index.get(k) ?? []).length} capture(s))`);
      const body = [
        'Specify Mock Server',
        `Traffic entries: ${entries.length}`,
        `Available routes (${index.size}):`,
        '',
        ...routes,
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
      rlog(`[mock] GET / → index (${index.size} routes)`);
      return;
    }

    if (method === 'GET' && pathname === '/_traffic') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(entries, null, 2));
      rlog(`[mock] GET /_traffic → raw traffic data`);
      return;
    }

    if (method === 'GET' && pathname === '/_faults') {
      const body = JSON.stringify(
        {
          enabled: faultRate > 0,
          faultRate,
          enabledTypes,
          stats: faultStats,
        },
        null,
        2
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      rlog(`[mock] GET /_faults → fault injection state`);
      return;
    }

    if (method === 'GET' && pathname === '/_sessions') {
      const sessionList = Array.from(sessions.entries()).map(([key, s]) => ({
        [SESSION_COOKIE_NAME]: key.slice(0, 8) + '...',
        expiresAt: new Date(s.expiresAt).toISOString(),
        ttlRemainingMs: Math.max(0, s.expiresAt - Date.now()),
      }));
      const body = JSON.stringify(
        { activeSessions: sessionList.length, sessionTtlMs: SESSION_TTL_MS, sessions: sessionList },
        null,
        2
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      rlog(`[mock] GET /_sessions → ${sessionList.length} active session(s)`);
      return;
    }

    if (method === 'GET' && pathname === '/_synthetic') {
      const body = JSON.stringify(
        {
          enabled: SYNTHETIC_ENABLED,
          templatesLoaded: syntheticStats.templatesLoaded,
          hits: syntheticStats.hits,
          templates: (synthetic?.templates ?? []).map((t) => ({
            method: t.method,
            pathTemplate: t.pathTemplate,
            paramNames: t.paramNames,
            status: t.status,
            contentType: t.contentType,
            entryCount: t.entryCount,
          })),
        },
        null,
        2
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      rlog(`[mock] GET /_synthetic → ${syntheticStats.templatesLoaded} loaded template(s)`);
      return;
    }

    if (method === 'GET' && pathname === '/_impl') {
      const body = JSON.stringify(
        {
          enabled: modeAllowsImpl(mode),
          loaded: loadedImpl.impl !== null,
          path: loadedImpl.implPath,
          loadError: loadedImpl.loadError,
          report: loadedImpl.report,
          stats: implStats,
        },
        null,
        2
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      rlog(`[mock] GET /_impl → loaded=${loadedImpl.impl !== null} path=${loadedImpl.implPath}`);
      return;
    }

    // ── Auth enforcement (opt-in via MOCK_AUTH=1) ─────────────────────────
    if (AUTH_ENABLED && !AUTH_EXEMPT_PATHS.has(pathname)) {
      const session = findValidSession(req);
      if (!session) {
        redirectToLogin(res);
        rlog(`[mock] AUTH: 302 → ${LOGIN_PATH} (no valid session for ${method} ${pathname})`);
        return;
      }
    }

    const routeKey = `${method} ${pathname}`;

    // Read the request body at most once — the implementation tier, recorded
    // POST matching, and fault injection can all end up wanting it, and the
    // underlying stream can only be drained a single time.
    let bodyText: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      bodyText = await readBody(req);
    }

    // ── Tier 1: implementation ──────────────────────────────────────────────
    // Tried first when loaded (auto/impl modes): it's the one tier that can
    // stay self-consistent across a POST-then-GET sequence (real routing +
    // an in-memory store), so a state-changing request has to reach it
    // before anything else gets a chance to answer. Routes it declines
    // (throw, timeout, explicit null) fall through to the recorded tier.
    if (modeAllowsImpl(mode) && loadedImpl.impl) {
      const query: Record<string, string> = {};
      for (const [k, v] of parsedUrl.searchParams) query[k] = v;

      const outcome = await callImplementation(
        loadedImpl.impl,
        { method, path: pathname, query, headers: flattenHeaders(req.headers), body: bodyText },
        IMPL_TIMEOUT_MS
      );

      if (outcome.outcome === 'answered') {
        implStats.hits++;
        const { response } = outcome;
        const responseBody = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        res.writeHead(response.status, {
          'Content-Type': response.contentType || 'application/octet-stream',
          'X-Mockify-Tier': 'implementation',
        });
        res.end(responseBody);
        rlog(`[mock] IMPL ${method} ${pathname} → ${response.status}`);
        return;
      }

      if (outcome.outcome === 'declined') {
        implStats.declines++;
        rlog(`[mock] IMPL ${method} ${pathname} → declined, falling through`);
      } else if (outcome.outcome === 'threw') {
        implStats.throws++;
        if (!implWarnedPaths.has(routeKey)) {
          implWarnedPaths.add(routeKey);
          rlog(
            `[mock] IMPL ${method} ${pathname} → threw: ${outcome.error} — falling through ` +
              `(further failures on this route are logged once)`
          );
        }
      } else {
        implStats.timeouts++;
        if (!implWarnedPaths.has(routeKey)) {
          implWarnedPaths.add(routeKey);
          rlog(
            `[mock] IMPL ${method} ${pathname} → timed out after ${IMPL_TIMEOUT_MS}ms — falling through ` +
              `(further failures on this route are logged once; override with MOCKIFY_IMPL_TIMEOUT_MS)`
          );
        }
      }
    }

    // ── Tier 2: recorded ──────────────────────────────────────────────────
    // The implementation tier either wasn't consulted, declined, or isn't
    // loaded — fall back to an exact recorded request/response match,
    // scored against query params / POST body.
    const matchedEntries = index.get(routeKey);

    if (matchedEntries && matchedEntries.length > 0) {
      let entry: TrafficEntry | null;
      if (method === 'POST') {
        entry = bestPostMatch(matchedEntries, bodyText ?? '');
      } else {
        entry = bestGetMatch(matchedEntries, parsedUrl.searchParams);
      }

      if (entry) {
        rlog(
          `[mock] ${method} ${pathname} → matched (${matchedEntries.length} candidate(s), status=${entry.status})`
        );

        // ── Fault injection ───────────────────────────────────────────────
        faultStats.totalRequests++;

        if (faultRate > 0 && Math.random() < faultRate) {
          const fault = pickRandomFault(enabledTypes);
          await injectFault(fault, entry, res, method, pathname);
          return;
        }

        // ── Send recorded response ──────────────────────────────────────
        res.writeHead(entry.status, {
          'Content-Type': entry.contentType || 'application/octet-stream',
          'X-Mockify-Tier': 'recorded',
        });
        res.end(entry.responseBody ?? '');
        return;
      }

      rlog(
        `[mock] ${method} ${pathname} → ${matchedEntries.length} candidate(s), none matched the request body — falling through`
      );
    }

    // ── Tier 3: synthetic ──────────────────────────────────────────────────
    // Still nothing — see if this request fits an endpoint template inferred
    // from OTHER recorded requests (e.g. /api/room/7 when only rooms 1-3
    // were ever captured).
    if (modeAllowsSynthetic(mode) && SYNTHETIC_ENABLED && synthetic) {
      const match = matchSyntheticTemplate(synthetic.templates, method, pathname);
      if (match) {
        syntheticStats.hits++;
        const body = synthesizeResponseBody(match.template, match.params, method, pathname);
        const responseBody =
          typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(match.template.status, {
          'Content-Type': match.template.contentType || 'application/octet-stream',
          'X-Mockify-Synthetic': 'true',
          'X-Mockify-Tier': 'synthetic',
        });
        res.end(responseBody);
        rlog(
          `[mock] SYNTH ${method} ${pathname} ← ${match.template.pathTemplate}`
        );
        return;
      }
    }

    // ── Tier 4: 404 ────────────────────────────────────────────────────────
    const similar = Array.from(index.keys())
      .filter((k) => k.includes(pathname.split('/').slice(0, 3).join('/')))
      .sort();

    const body = JSON.stringify(
      {
        error: 'No matching route',
        requested: `${method} ${pathname}`,
        hint: 'Check GET / for all available routes',
        similar: similar.length > 0 ? similar : undefined,
      },
      null,
      2
    );
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    rlog(`[mock] 404 ${method} ${pathname} (no match)`);
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartMockServerOptions {
  /** A traffic.json path, or a capture directory containing one. Falls back
   * to MOCK_DATA_PATH, then the capture-search defaults in loadTraffic(),
   * when omitted — so existing MOCK_DATA_PATH-driven invocations still work
   * unchanged. */
  dataPath?: string;
  /** Port to listen on. Falls back to the PORT env var, then 3456. */
  port?: number;
  /** Suppress the server's own startup/config lines. Callers that print their
   * own banner (`mockify replay`) set this; MOCK_VERBOSE=1 overrides it. */
  quiet?: boolean;
  /** Which of the implementation/synthetic tiers the request handler may
   * consult beyond the always-on recorded tier and 404 fallback. Default
   * `'auto'` — the full four-tier pipeline (see module doc). */
  mode?: ReplayMode;
  /** Override the implementation module path instead of the default
   * `<captureDir>/impl/handlers.mjs` — `mockify replay --impl <path>`, and
   * how tests exercise a fixture implementation without moving files. */
  implPath?: string;
}

export interface StartedMockServer {
  server: http.Server;
  port: number;
  captureDir: string;
  /** Total captured request/response entries loaded (traffic.json length). */
  entryCount: number;
  /** Number of distinct recorded routes (method+path) served — see route index at GET /. */
  routeCount: number;
  syntheticTemplateCount: number;
  mode: ReplayMode;
  /** Diagnostics for the implementation tier — mirrors what GET /_impl
   * reports, so `mockify replay`'s banner can be built from the same data
   * without a second file read. */
  implementation: LoadedImplementation;
}

/**
 * Start the mock server programmatically — no env vars required. This is
 * what `mockify replay`/`mockify serve` (src/cli.ts) and tests call; the
 * self-start guard below (`node dist/mock-server.js` / direct `tsx`
 * execution) is just a thin wrapper around the same function so that
 * long-standing direct-execution invocations keep working unchanged.
 * Resolves once the server is actually listening.
 */
export async function startMockServer(opts: StartMockServerOptions = {}): Promise<StartedMockServer> {
  const port = opts.port ?? DEFAULT_PORT;
  const mode: ReplayMode = opts.mode ?? 'auto';
  // `mockify replay` prints its own banner from the resolved StartedMockServer,
  // so it asks for silence here rather than having its banner buried under a
  // dozen internal config lines. MOCK_VERBOSE=1 overrides.
  const slog = opts.quiet && !VERBOSE ? () => {} : (m: string) => console.error(m);
  const { entries, index, captureDir } = loadTraffic(opts.dataPath, opts.quiet && !VERBOSE);

  const synthetic = SYNTHETIC_ENABLED && modeAllowsSynthetic(mode) ? loadSyntheticIndex(captureDir) : null;
  if (!modeAllowsSynthetic(mode)) {
    slog(`[mock] Synthetic tier not consulted (--mode ${mode})`);
  } else if (SYNTHETIC_ENABLED) {
    if (synthetic) {
      rlog(`[mock] Loaded ${synthetic.templates.length} synthetic templates`);
    } else {
      slog(
        `[mock] No synthetic/index.json found (run "mockify synthesize --data ${captureDir}" to generate one)`
      );
    }
  } else {
    slog('[mock] Synthetic replay disabled (MOCK_SYNTHETIC=0)');
  }

  // Loaded unconditionally (mode only gates whether the request handler
  // consults it) so GET /_impl and the replay banner report accurate
  // diagnostics no matter which mode is active.
  const loadedImpl = await loadImplementationForServer(captureDir, opts.implPath);
  if (!modeAllowsImpl(mode)) {
    slog(`[mock] Implementation tier not consulted (--mode ${mode})`);
  } else if (loadedImpl.impl) {
    slog(`[mock] Loaded implementation from ${loadedImpl.implPath}`);
  } else if (loadedImpl.loadError) {
    slog(`[mock] Implementation at ${loadedImpl.implPath} failed to load: ${loadedImpl.loadError}`);
  } else {
    slog(
      `[mock] No implementation found at ${loadedImpl.implPath} (run "mockify infer" to generate one)`
    );
  }
  if (loadedImpl.impl) {
    await loadedImpl.impl.reset();
  }

  const server = createServer(entries, index, synthetic, mode, loadedImpl);

  return new Promise((resolve) => {
    server.listen(port, () => {
      slog(`[mock] Specify Mock Server listening on http://localhost:${port}`);
      slog(`[mock] GET http://localhost:${port}/           → route index`);
      slog(`[mock] GET http://localhost:${port}/_traffic   → raw traffic data`);
      slog(`[mock] GET http://localhost:${port}/_faults    → fault injection state`);
      slog(`[mock] GET http://localhost:${port}/_sessions  → active sessions`);
      slog(`[mock] GET http://localhost:${port}/_synthetic → loaded synthetic templates`);
      slog(`[mock] GET http://localhost:${port}/_impl      → loaded implementation info`);
      slog(`[mock] Auth: POST http://localhost:${port}${LOGIN_PATH}  → create session`);
      slog(`[mock] Auth: GET  http://localhost:${port}${REFRESH_PATH}  → extend session`);
      slog(`[mock] Session cookie: "${SESSION_COOKIE_NAME}", TTL: ${SESSION_TTL_MS / 1000}s`);
      if (faultRate > 0) {
        slog(`[mock] Fault injection ENABLED: rate=${faultRate} types=${enabledTypes.join(',')}`);
      } else {
        slog(`[mock] Fault injection disabled (set MOCK_FAULT_RATE to enable)`);
      }
      resolve({
        server,
        port,
        captureDir,
        entryCount: entries.length,
        routeCount: index.size,
        syntheticTemplateCount: synthetic?.templates.length ?? 0,
        mode,
        implementation: loadedImpl,
      });
    });
  });
}

// Self-start only when this file is the process entry point (`node
// dist/mock-server.js`, or direct `npx tsx src/mock-server.ts`) — not when
// imported as a module by startMockServer()'s callers (src/cli.ts) or by
// tests, which would otherwise start a second, uncoordinated server.
function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  void startMockServer();
}
