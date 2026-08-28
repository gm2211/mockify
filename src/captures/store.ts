/**
 * src/captures/store.ts — the capture registry (name ⇄ directory)
 *
 * mockify's low-level UX made every replay a hand-assembled invocation like
 * `PORT=4173 MOCK_DATA_PATH=captures/demo-grok node dist/mock-server.js`,
 * with no way to discover what an agent had saved or under what name. This
 * module is the small bit of bookkeeping that fixes that: it maps a human
 * -friendly capture *name* onto the directory that holds its traffic.json
 * (+ manifest.json, synthetic/, screenshots/), so the CLI can offer
 * `mockify list` / `mockify replay <name>` instead of raw env vars.
 *
 * Nothing here talks to the network or starts a server — see
 * src/mock-server.ts (startMockServer) and src/cli.ts for that.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CaptureManifest } from '../format/types.js';
import { resolveCaptureFormatVersion } from '../format/types.js';

// ---------------------------------------------------------------------------
// Root directory
// ---------------------------------------------------------------------------

/** Directory captures are stored under. `MOCKIFY_CAPTURES_DIR` overrides the
 * default `<cwd>/captures` — mainly so tests can point this at a temp dir
 * without touching the real captures/ folder. */
export function capturesRoot(): string {
  const override = process.env.MOCKIFY_CAPTURES_DIR;
  return override ? path.resolve(override) : path.resolve(process.cwd(), 'captures');
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Turn a target URL into a filesystem-safe, human-readable capture name:
 * hostname → lowercase, dots/underscores → hyphens, strip a leading `www-`,
 * then drop anything that isn't alphanumeric or a hyphen.
 * `https://automationintesting.online` → `automationintesting-online`. */
export function slugifyName(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  let slug = hostname.toLowerCase().replace(/[._]/g, '-');
  slug = slug.replace(/^www-/, '');
  slug = slug.replace(/[^a-z0-9-]/g, '');
  slug = slug.replace(/-+/g, '-').replace(/^-|-$/g, '');

  return slug || 'capture';
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/** Resolve the name + directory a new capture should be written to, without
 * creating anything. `explicitName` (e.g. `--name`) wins when given;
 * otherwise the name is slugified from `url`. If the resulting directory
 * already holds a completed capture (a traffic.json), a numeric suffix
 * (-2, -3, …) is appended until a free name is found. */
export function allocateCaptureDir(url: string, explicitName?: string): { name: string; dir: string } {
  const root = capturesRoot();
  const baseName = explicitName && explicitName.trim() ? explicitName.trim() : slugifyName(url);

  let candidate = baseName;
  let n = 2;
  while (fs.existsSync(path.join(root, candidate, 'traffic.json'))) {
    candidate = `${baseName}-${n}`;
    n++;
  }

  return { name: candidate, dir: path.join(root, candidate) };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface CaptureSummary {
  name: string;
  dir: string;
  target: string;
  requests: number;
  screenshots: number;
  syntheticTemplates: number;
  /** ISO timestamp from manifest.json, or '' if unavailable. */
  capturedAt: string;
  /**
   * traffic.json entry format version (see CURRENT_CAPTURE_FORMAT_VERSION,
   * src/format/types.ts) — 1 for a capture predating requestHeaders/
   * responseHeaders (SP-lsc.8), including one with no manifest.json at all.
   */
  formatVersion: number;
}

/** Best-effort summary of a single capture directory. Returns null when the
 * directory isn't a capture at all (no traffic.json) or its traffic.json is
 * unreadable/unparseable — callers skip these rather than crash the whole
 * scan. manifest.json and synthetic/index.json are optional and read
 * best-effort; a malformed one just falls back to defaults instead of
 * failing the summary. */
export function summarizeCapture(name: string, dir: string): CaptureSummary | null {
  const trafficPath = path.join(dir, 'traffic.json');
  if (!fs.existsSync(trafficPath)) return null;

  let requests: number;
  try {
    const parsed = JSON.parse(fs.readFileSync(trafficPath, 'utf8'));
    if (!Array.isArray(parsed)) return null;
    requests = parsed.length;
  } catch {
    return null;
  }

  let target = '';
  let capturedAt = '';
  // resolveCaptureFormatVersion(undefined) already falls back to 1 — this is
  // what makes "no manifest.json at all" (an even older capture than "has a
  // manifest but it predates the formatVersion field") resolve the same way.
  let formatVersion = resolveCaptureFormatVersion(undefined);
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CaptureManifest;
      target = manifest.session?.targetUrl ?? '';
      capturedAt = manifest.session?.timestamp ?? '';
      formatVersion = resolveCaptureFormatVersion(manifest);
    } catch {
      // Malformed manifest — fall back to '' / version 1 below.
    }
  }

  // Screenshot count comes from the screenshots/ directory itself rather
  // than manifest.session.totalScreenshots: the manifest field can go stale
  // relative to what's actually on disk, while the directory listing can't.
  // As of SP-lsc.6, CaptureCollector.save() (src/agent/capture.ts) itself
  // derives totalScreenshots from the same on-disk enumeration, so new
  // manifests can't disagree with reality — but this workaround stays:
  // captures already on disk (written before that fix, including by the
  // now-retired plain-JS browse-and-capture.mjs recorder, since replaced by
  // src/recorders/browse-and-capture.ts) still carry the old counter-based
  // field, and this function has to summarize both.
  let screenshots = 0;
  const screenshotDir = path.join(dir, 'screenshots');
  try {
    if (fs.existsSync(screenshotDir)) {
      screenshots = fs.readdirSync(screenshotDir).filter((f) => f.endsWith('.png')).length;
    }
  } catch {
    screenshots = 0;
  }

  let syntheticTemplates = 0;
  const syntheticIndexPath = path.join(dir, 'synthetic', 'index.json');
  if (fs.existsSync(syntheticIndexPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(syntheticIndexPath, 'utf8')) as { templates?: unknown[] };
      syntheticTemplates = Array.isArray(idx.templates) ? idx.templates.length : 0;
    } catch {
      syntheticTemplates = 0;
    }
  }

  return { name, dir, target, requests, screenshots, syntheticTemplates, capturedAt, formatVersion };
}

/** List every saved capture under capturesRoot(), newest first. Directories
 * that aren't captures (no traffic.json) or whose traffic.json is corrupt
 * are silently skipped — this never throws for a partial/malformed root. */
export function listCaptures(): CaptureSummary[] {
  const root = capturesRoot();
  if (!fs.existsSync(root)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries: CaptureSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summary = summarizeCapture(entry.name, path.join(root, entry.name));
    if (summary) summaries.push(summary);
  }

  // Newest first. Missing timestamps ('') sort last.
  summaries.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return summaries;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Resolve a name (as saved under capturesRoot()) or a filesystem path (a
 * capture directory, or a traffic.json file itself) to `{ name, dir }`.
 * An exact name match under capturesRoot() always wins over treating the
 * input as a path. Throws a clear, actionable error when neither resolves. */
export function resolveCapture(nameOrPath: string): { name: string; dir: string } {
  const root = capturesRoot();
  const byName = path.join(root, nameOrPath);
  if (fs.existsSync(path.join(byName, 'traffic.json'))) {
    return { name: nameOrPath, dir: byName };
  }

  const resolved = path.resolve(process.cwd(), nameOrPath);
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      if (fs.existsSync(path.join(resolved, 'traffic.json'))) {
        return { name: path.basename(resolved), dir: resolved };
      }
    } else if (stat.isFile() && path.basename(resolved) === 'traffic.json') {
      const dir = path.dirname(resolved);
      return { name: path.basename(dir), dir };
    }
  }

  throw new Error(
    `Could not find a capture named or at "${nameOrPath}". Run "mockify list" to see saved captures.`
  );
}
