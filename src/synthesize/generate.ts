/**
 * src/synthesize/generate.ts — turn templates + shapes into an on-disk
 * synthetic index, and provide the runtime matching/synthesis helpers the
 * mock server uses to answer requests that were never recorded.
 *
 * Output layout (written under `<captureDir>/synthetic/`):
 *   index.json — { version, generatedFrom, templates: [...+ shape] },
 *                loaded by mock-server.ts at startup.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CapturedTraffic } from '../format/types.js';
import { inferTemplateGroups, type EndpointTemplate } from './templates.js';
import {
  inferShape,
  synthesizeValue,
  hashSeed,
  type Shape,
  type ResolvedParam,
  type SynthContext,
} from './schema.js';

export interface SyntheticTemplateRecord extends EndpointTemplate {
  shape: Shape;
}

export interface SyntheticIndex {
  version: number;
  generatedFrom: number;
  templates: SyntheticTemplateRecord[];
}

export interface GenerateSummary {
  outDir: string;
  indexPath: string;
  templateCount: number;
  templates: Array<{ method: string; pathTemplate: string; paramNames: string[]; entryCount: number }>;
}

/** Split "/api/room/{p2}" back into ["api","room","{p2}"] and resolve each
 * `{pN}` placeholder's ResolvedParam, using the immediately preceding
 * literal segment as the semantic "resource noun" (e.g. "room" for
 * roomid-style key matching). A variable that immediately follows another
 * variable has no literal noun to borrow, so it falls back to "". */
export function resolveParams(template: EndpointTemplate, capturedValues: string[]): ResolvedParam[] {
  const segs = template.pathTemplate.split('/').filter(Boolean);
  return template.paramNames.map((name, i) => {
    const pos = Number(name.slice(1));
    const precedingSeg = pos > 0 ? (segs[pos - 1] ?? '') : '';
    const resourceNoun = /^\{p\d+\}$/.test(precedingSeg) ? '' : precedingSeg;
    return { name, value: capturedValues[i] ?? '', resourceNoun };
  });
}

function buildResolvedPath(template: EndpointTemplate, capturedValues: string[]): string {
  const segs = template.pathTemplate.split('/').filter(Boolean);
  let vi = 0;
  const resolved = segs.map((seg) => (/^\{p\d+\}$/.test(seg) ? (capturedValues[vi++] ?? '0') : seg));
  return '/' + resolved.join('/');
}

/** Infer templates + response shapes from captured traffic and write
 * `<captureDir>/synthetic/index.json`. */
export function generateSynthetic(entries: CapturedTraffic[], captureDir: string): GenerateSummary {
  const groups = inferTemplateGroups(entries);
  const outDir = path.join(captureDir, 'synthetic');
  fs.mkdirSync(outDir, { recursive: true });

  const records: SyntheticTemplateRecord[] = [];

  for (const { template, entries: groupEntries } of groups) {
    // Prefer bodies from entries matching the template's modal status (the
    // status/content-type we're actually going to serve), falling back to
    // the whole group if that somehow comes up empty.
    const modalBodies = groupEntries
      .filter((e) => e.status === template.status)
      .map((e) => e.responseBody ?? '');
    const bodies = modalBodies.length > 0 ? modalBodies : groupEntries.map((e) => e.responseBody ?? '');

    const shape = inferShape(bodies);
    records.push({ ...template, shape });
  }

  const index: SyntheticIndex = {
    version: 1,
    generatedFrom: entries.length,
    templates: records,
  };

  const indexPath = path.join(outDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

  return {
    outDir,
    indexPath,
    templateCount: records.length,
    templates: records.map((r) => ({
      method: r.method,
      pathTemplate: r.pathTemplate,
      paramNames: r.paramNames,
      entryCount: r.entryCount,
    })),
  };
}

// ---------------------------------------------------------------------------
// Runtime helpers — used by mock-server.ts to answer unrecorded requests.
// ---------------------------------------------------------------------------

/** Load `<captureDir>/synthetic/index.json` if present. Returns null (not a
 * throw) when missing or unparseable, since synthesis is always optional. */
export function loadSyntheticIndex(captureDir: string): SyntheticIndex | null {
  const indexPath = path.join(captureDir, 'synthetic', 'index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as SyntheticIndex;
  } catch {
    return null;
  }
}

export interface SyntheticMatch {
  template: SyntheticTemplateRecord;
  params: ResolvedParam[];
}

/** Find the first template (method + regex) matching an incoming request. */
export function matchSyntheticTemplate(
  templates: SyntheticTemplateRecord[],
  method: string,
  pathname: string
): SyntheticMatch | null {
  const upper = method.toUpperCase();
  for (const template of templates) {
    if (template.method !== upper) continue;
    const re = new RegExp(template.regex);
    const m = re.exec(pathname);
    if (!m) continue;
    return { template, params: resolveParams(template, m.slice(1)) };
  }
  return null;
}

/** Synthesize a response body for a matched template + real request path.
 * Deterministic: the same (method, pathname) always yields the same body. */
export function synthesizeResponseBody(
  template: SyntheticTemplateRecord,
  params: ResolvedParam[],
  method: string,
  pathname: string
): unknown {
  const seed = hashSeed(`${method.toUpperCase()} ${pathname}`);
  const ctx: SynthContext = { params, seed };
  return synthesizeValue(template.shape, ctx);
}
