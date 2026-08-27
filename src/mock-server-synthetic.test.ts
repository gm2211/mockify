/**
 * src/mock-server-synthetic.test.ts — server-level synthetic replay
 *
 * Exercises the mock server's fallback-to-synthesis path (SP-lsc.2) the
 * same way mock-server.test.ts exercises directory-form loading: spawn the
 * CLI's `serve` subcommand as a real child process and hit it over HTTP.
 * A fixture under test/fixtures produces a small deterministic template
 * set; synthetic/index.json is generated into a temp copy of that fixture
 * at test setup time (not checked in), matching how a real capture works.
 *
 * Server readiness (SP-ish): spawnMockServer() (src/test-helpers/
 * spawn-mock-server.ts) waits for the server's own "listening" line rather
 * than an earlier startup log line — see that module's doc comment for why
 * the earlier approach was an outright race, not just a slow-CI flake.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateSynthetic } from './synthesize/generate.js';
import { spawnMockServer, REPO_ROOT } from './test-helpers/spawn-mock-server.js';

const FIXTURE_TRAFFIC = path.join(REPO_ROOT, 'test', 'fixtures', 'synthetic-captures', 'traffic.json');

/** Copy the fixture into a fresh temp dir and generate synthetic/index.json
 * into it, so each test run starts from a clean, disposable capture dir. */
function prepareCaptureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-serve-synth-'));
  const trafficPath = path.join(dir, 'traffic.json');
  fs.copyFileSync(FIXTURE_TRAFFIC, trafficPath);
  const entries = JSON.parse(fs.readFileSync(trafficPath, 'utf8'));
  generateSynthetic(entries, dir);
  return dir;
}

async function withServer(
  captureDir: string,
  extraEnv: Record<string, string>,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const { child, port } = await spawnMockServer({ MOCK_DATA_PATH: captureDir, ...extraEnv });
  try {
    await fn(port);
  } finally {
    child.kill();
  }
}

test('mock-server: an exact recorded path returns the RECORDED body, not a synthesized one', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, {}, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/widgets/1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-synthetic'), null);
    const body = await res.json();
    assert.equal(body.widgetid, 1);
    assert.equal(body.name, 'Sprocket');
  });
});

test('mock-server: an unrecorded-but-templated path returns 200 + X-Mockify-Synthetic: true', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, {}, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/widgets/9`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mockify-synthetic'), 'true');
    const body = await res.json();
    assert.equal(body.widgetid, 9);
  });
});

test('mock-server: a wholly unknown path still 404s even with synthetic replay enabled', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, {}, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/completely/unknown/path`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-mockify-synthetic'), null);
  });
});

test('mock-server: MOCK_SYNTHETIC=0 disables synthetic replay, falling straight through to 404', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, { MOCK_SYNTHETIC: '0' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/widgets/9`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-mockify-synthetic'), null);
  });
});

test('mock-server: /_synthetic reports loaded templates', async () => {
  const dir = prepareCaptureDir();
  await withServer(dir, {}, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/_synthetic`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.ok(body.templatesLoaded > 0);
    assert.ok(body.templates.some((t: { pathTemplate: string }) => t.pathTemplate === '/api/widgets/{p2}'));
  });
});
