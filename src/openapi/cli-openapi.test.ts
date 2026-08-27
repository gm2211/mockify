/**
 * src/openapi/cli-openapi.test.ts — `mockify openapi` as a real CLI subprocess.
 *
 * Exercises argument handling (positional capture name/path, --out, format
 * selection from --out's extension) the same way a user actually invokes
 * it, rather than calling buildOpenApiDocument() directly (covered in
 * build.test.ts).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fromYaml } from './yaml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const FIXTURE_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'synthetic-captures');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-spec-cli-'));
}

test('mockify openapi <path>: defaults to writing openapi.yaml under the capture directory', () => {
  const dir = tempDir();
  fs.cpSync(FIXTURE_CAPTURE_DIR, dir, { recursive: true });

  const result = runCli(['openapi', dir]);
  assert.equal(result.status, 0, `expected success, stderr:\n${result.stderr}`);

  const outPath = path.join(dir, 'openapi.yaml');
  assert.ok(fs.existsSync(outPath), `expected ${outPath} to be written`);

  const parsed = fromYaml(fs.readFileSync(outPath, 'utf8')) as { openapi: string; paths: Record<string, unknown> };
  assert.equal(parsed.openapi, '3.1.0');
  assert.ok(Object.keys(parsed.paths).length > 0);
});

test('mockify openapi <path> --out <path>.json: writes JSON when the extension is .json', () => {
  const dir = tempDir();
  fs.cpSync(FIXTURE_CAPTURE_DIR, dir, { recursive: true });
  const outPath = path.join(dir, 'custom.json');

  const result = runCli(['openapi', dir, '--out', outPath]);
  assert.equal(result.status, 0, `expected success, stderr:\n${result.stderr}`);
  assert.ok(fs.existsSync(outPath));

  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(parsed.openapi, '3.1.0');
  assert.ok(Object.keys(parsed.paths).length > 0);
});

test('mockify openapi <path> --out <path>.yaml: writes YAML at an explicit path', () => {
  const dir = tempDir();
  fs.cpSync(FIXTURE_CAPTURE_DIR, dir, { recursive: true });
  const outPath = path.join(dir, 'nested-out.yaml');

  const result = runCli(['openapi', dir, '--out', outPath]);
  assert.equal(result.status, 0, `expected success, stderr:\n${result.stderr}`);
  const content = fs.readFileSync(outPath, 'utf8');
  assert.match(content, /^openapi: 3\.1\.0/);
});

test('mockify openapi: missing positional argument exits non-zero with usage on stderr', () => {
  const result = runCli(['openapi']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: mockify openapi/);
});

test('mockify openapi: a nonexistent capture path exits non-zero with an error message', () => {
  const result = runCli(['openapi', path.join(os.tmpdir(), 'mockify-does-not-exist-xyz')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /error:/);
});
