import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateSynthetic,
  loadSyntheticIndex,
  matchSyntheticTemplate,
  synthesizeResponseBody,
} from './generate.js';
import type { CapturedTraffic } from '../format/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_TRAFFIC = path.join(__dirname, '..', '..', 'test', 'fixtures', 'synthetic-captures', 'traffic.json');

function loadFixtureEntries(): CapturedTraffic[] {
  return JSON.parse(fs.readFileSync(FIXTURE_TRAFFIC, 'utf8')) as CapturedTraffic[];
}

function tempCaptureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-synth-'));
}

test('generateSynthetic: writes index.json under <captureDir>/synthetic', () => {
  const entries = loadFixtureEntries();
  const dir = tempCaptureDir();
  const summary = generateSynthetic(entries, dir);

  assert.ok(fs.existsSync(summary.indexPath));
  assert.equal(summary.indexPath, path.join(dir, 'synthetic', 'index.json'));

  const index = JSON.parse(fs.readFileSync(summary.indexPath, 'utf8'));
  assert.equal(index.version, 1);
  assert.equal(index.generatedFrom, entries.length);
  assert.ok(Array.isArray(index.templates));
  assert.ok(index.templates.some((t: { pathTemplate: string }) => t.pathTemplate === '/api/widgets/{p2}'));

});

test('loadSyntheticIndex: round-trips what generateSynthetic wrote', () => {
  const entries = loadFixtureEntries();
  const dir = tempCaptureDir();
  generateSynthetic(entries, dir);

  const loaded = loadSyntheticIndex(dir);
  assert.ok(loaded);
  assert.equal(loaded?.generatedFrom, entries.length);
});

test('loadSyntheticIndex: returns null (not a throw) when nothing was generated', () => {
  const dir = tempCaptureDir();
  assert.equal(loadSyntheticIndex(dir), null);
});

test('matchSyntheticTemplate + synthesizeResponseBody: an unrecorded id resolves to a synthesized body with the id substituted', () => {
  const entries = loadFixtureEntries();
  const dir = tempCaptureDir();
  generateSynthetic(entries, dir);
  const index = loadSyntheticIndex(dir);
  assert.ok(index);
  if (!index) return;

  const match = matchSyntheticTemplate(index.templates, 'GET', '/api/widgets/9');
  assert.ok(match, 'expected /api/widgets/9 to match the widgets id template');
  if (!match) return;
  assert.equal(match.template.pathTemplate, '/api/widgets/{p2}');

  const body = synthesizeResponseBody(match.template, match.params, 'GET', '/api/widgets/9') as {
    widgetid: unknown;
  };
  assert.equal(body.widgetid, 9);
});

test('matchSyntheticTemplate: a wholly unknown path does not match any template', () => {
  const entries = loadFixtureEntries();
  const dir = tempCaptureDir();
  generateSynthetic(entries, dir);
  const index = loadSyntheticIndex(dir);
  assert.ok(index);
  if (!index) return;

  const match = matchSyntheticTemplate(index.templates, 'GET', '/nonexistent/junk/path');
  assert.equal(match, null);
});

test('matchSyntheticTemplate: method matters — POST to a GET-only template path does not match', () => {
  const entries = loadFixtureEntries();
  const dir = tempCaptureDir();
  generateSynthetic(entries, dir);
  const index = loadSyntheticIndex(dir);
  assert.ok(index);
  if (!index) return;

  const match = matchSyntheticTemplate(index.templates, 'DELETE', '/api/widgets/9');
  assert.equal(match, null);
});
