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
 *
 * Diagnostic endpoints (no auth required):
 *   GET /           → route index
 *   GET /_traffic   → raw traffic data
 *   GET /_faults    → fault injection state
 *   GET /_sessions  → active sessions
 *   GET /_synthetic → loaded synthetic templates + hit stats
 *
 * Requests that don't match a recorded route fall through to synthetic
 * (generalized) replay when `<captureDir>/synthetic/index.json` exists (see
 * src/synthesize/) — a plausible response is generated from the shape of
 * endpoints that WERE recorded, so e.g. `/api/room/7` can succeed even
 * though only rooms 1-3 were ever captured. Recorded exact matches always
 * win over synthetic ones. Set MOCK_SYNTHETIC=0 to disable this and fall
 * straight through to the 404-with-hints behavior instead.
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
const AUTH_EXEMPT_PATHS = new Set(['/', '/_traffic', '/_faults', '/_sessions', '/_synthetic']);
// Synthetic login gate is opt-in: most captures replay cleanly without it.
const AUTH_ENABLED = process.env.MOCK_AUTH === '1';

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
function scorePostMatch(capturedPostData: string | null, incomingBody: string): number {
  if (!capturedPostData) return 0;
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

function bestPostMatch(entries: TrafficEntry[], incomingBody: string): TrafficEntry {
  if (entries.length === 1) return entries[0];
  let best = entries[0];
  let bestScore = scorePostMatch(entries[0].postData, incomingBody);
  for (let i = 1; i < entries.length; i++) {
    const score = scorePostMatch(entries[i].postData, incomingBody);
    if (score > bestScore) {
      bestScore = score;
      best = entries[i];
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Load traffic
// ---------------------------------------------------------------------------
function loadTraffic(explicitDataPath?: string): { entries: TrafficEntry[]; index: RouteIndex; captureDir: string } {
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

  console.error(
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
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
        resolve();
        break;
      }
      case '302': {
        res.writeHead(302, { Location: LOGIN_PATH, 'Content-Length': '0' });
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
          });
          res.end(entry.responseBody ?? '');
          resolve();
        }, delayMs);
        break;
      }
      case 'empty': {
        res.writeHead(200, { 'Content-Type': entry.contentType || 'application/octet-stream' });
        res.end('');
        resolve();
        break;
      }
      case 'malformed': {
        const raw = entry.responseBody ?? '{}';
        const cutPoint = Math.max(1, Math.floor(raw.length / 2));
        res.writeHead(200, { 'Content-Type': entry.contentType || 'application/octet-stream' });
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
// Server
// ---------------------------------------------------------------------------
const { faultRate, enabledTypes } = parseFaultConfig();

interface SyntheticStats {
  templatesLoaded: number;
  hits: number;
}

function createServer(
  entries: TrafficEntry[],
  index: RouteIndex,
  synthetic: SyntheticIndex | null
): http.Server {
  const loginHtml = buildLoginHtml();
  const syntheticStats: SyntheticStats = {
    templatesLoaded: synthetic?.templates.length ?? 0,
    hits: 0,
  };

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
        console.error(`[mock] GET ${LOGIN_PATH} → login form`);
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
          console.error(`[mock] POST ${LOGIN_PATH} → 400 (missing credentials)`);
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
        console.error(`[mock] GET ${REFRESH_PATH} → 200 (session extended)`);
      } else {
        redirectToLogin(res);
        console.error(`[mock] GET ${REFRESH_PATH} → 302 (invalid session)`);
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
      console.error(`[mock] GET / → index (${index.size} routes)`);
      return;
    }

    if (method === 'GET' && pathname === '/_traffic') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(entries, null, 2));
      console.error(`[mock] GET /_traffic → raw traffic data`);
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
      console.error(`[mock] GET /_faults → fault injection state`);
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
      console.error(`[mock] GET /_sessions → ${sessionList.length} active session(s)`);
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
      console.error(`[mock] GET /_synthetic → ${syntheticStats.templatesLoaded} loaded template(s)`);
      return;
    }

    // ── Auth enforcement (opt-in via MOCK_AUTH=1) ─────────────────────────
    if (AUTH_ENABLED && !AUTH_EXEMPT_PATHS.has(pathname)) {
      const session = findValidSession(req);
      if (!session) {
        redirectToLogin(res);
        console.error(`[mock] AUTH: 302 → ${LOGIN_PATH} (no valid session for ${method} ${pathname})`);
        return;
      }
    }

    // ── Route matching ────────────────────────────────────────────────────
    const routeKey = `${method} ${pathname}`;
    const matchedEntries = index.get(routeKey);

    if (!matchedEntries || matchedEntries.length === 0) {
      // ── Synthetic fallback ────────────────────────────────────────────
      // No recorded exchange matches exactly — before giving up, see if this
      // request fits an endpoint template inferred from OTHER recorded
      // requests (e.g. /api/room/7 when only /api/room/1..3 were captured).
      if (SYNTHETIC_ENABLED && synthetic) {
        const match = matchSyntheticTemplate(synthetic.templates, method, pathname);
        if (match) {
          syntheticStats.hits++;
          const body = synthesizeResponseBody(match.template, match.params, method, pathname);
          const responseBody =
            typeof body === 'string' ? body : JSON.stringify(body);
          res.writeHead(match.template.status, {
            'Content-Type': match.template.contentType || 'application/octet-stream',
            'X-Mockify-Synthetic': 'true',
          });
          res.end(responseBody);
          console.error(
            `[mock] SYNTH ${method} ${pathname} ← ${match.template.pathTemplate}`
          );
          return;
        }
      }

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
      console.error(`[mock] 404 ${method} ${pathname} (no match)`);
      return;
    }

    // ── Pick best match ───────────────────────────────────────────────────
    let entry: TrafficEntry;

    if (method === 'POST') {
      const body = await readBody(req);
      entry = bestPostMatch(matchedEntries, body);
    } else {
      entry = bestGetMatch(matchedEntries, parsedUrl.searchParams);
    }

    console.error(
      `[mock] ${method} ${pathname} → matched (${matchedEntries.length} candidate(s), status=${entry.status})`
    );

    // ── Fault injection ───────────────────────────────────────────────────
    faultStats.totalRequests++;

    if (faultRate > 0 && Math.random() < faultRate) {
      const fault = pickRandomFault(enabledTypes);
      await injectFault(fault, entry, res, method, pathname);
      return;
    }

    // ── Send response ─────────────────────────────────────────────────────
    res.writeHead(entry.status, {
      'Content-Type': entry.contentType || 'application/octet-stream',
    });
    res.end(entry.responseBody ?? '');
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
}

/**
 * Start the mock server programmatically — no env vars required. This is
 * what `mockify replay`/`mockify serve` (src/cli.ts) and tests call; the
 * self-start guard below (`node dist/mock-server.js` / direct `tsx`
 * execution) is just a thin wrapper around the same function so that
 * long-standing direct-execution invocations keep working unchanged.
 * Resolves once the server is actually listening.
 */
export function startMockServer(opts: StartMockServerOptions = {}): Promise<StartedMockServer> {
  const port = opts.port ?? DEFAULT_PORT;
  const { entries, index, captureDir } = loadTraffic(opts.dataPath);
  const synthetic = SYNTHETIC_ENABLED ? loadSyntheticIndex(captureDir) : null;
  if (SYNTHETIC_ENABLED) {
    if (synthetic) {
      console.error(`[mock] Loaded ${synthetic.templates.length} synthetic templates`);
    } else {
      console.error(
        `[mock] No synthetic/index.json found (run "mockify synthesize --data ${captureDir}" to generate one)`
      );
    }
  } else {
    console.error('[mock] Synthetic replay disabled (MOCK_SYNTHETIC=0)');
  }

  const server = createServer(entries, index, synthetic);

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.error(`[mock] Specify Mock Server listening on http://localhost:${port}`);
      console.error(`[mock] GET http://localhost:${port}/           → route index`);
      console.error(`[mock] GET http://localhost:${port}/_traffic   → raw traffic data`);
      console.error(`[mock] GET http://localhost:${port}/_faults    → fault injection state`);
      console.error(`[mock] GET http://localhost:${port}/_sessions  → active sessions`);
      console.error(`[mock] GET http://localhost:${port}/_synthetic → loaded synthetic templates`);
      console.error(`[mock] Auth: POST http://localhost:${port}${LOGIN_PATH}  → create session`);
      console.error(`[mock] Auth: GET  http://localhost:${port}${REFRESH_PATH}  → extend session`);
      console.error(`[mock] Session cookie: "${SESSION_COOKIE_NAME}", TTL: ${SESSION_TTL_MS / 1000}s`);
      if (faultRate > 0) {
        console.error(`[mock] Fault injection ENABLED: rate=${faultRate} types=${enabledTypes.join(',')}`);
      } else {
        console.error(`[mock] Fault injection disabled (set MOCK_FAULT_RATE to enable)`);
      }
      resolve({
        server,
        port,
        captureDir,
        entryCount: entries.length,
        routeCount: index.size,
        syntheticTemplateCount: synthetic?.templates.length ?? 0,
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
