/**
 * src/mock-server-start.test.ts — startMockServer() as a programmatic API
 *
 * mock-server.test.ts / mock-server-synthetic.test.ts exercise the server
 * by spawning the CLI as a subprocess (because the module used to self-start
 * as an unconditional side effect of import). Now that startup is exported
 * as `startMockServer()` (src/mock-server.ts), guarded to self-start only
 * when the module is the process entry point, it can be exercised directly
 * in-process too — this is what `mockify replay <name>` (src/cli.ts) calls.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';
import { resolveCapture } from './captures/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'captures');

test('startMockServer: serves a resolved capture directory without any env vars set', async () => {
  const { dir } = resolveCapture(FIXTURE_CAPTURE_DIR);
  const started = await startMockServer({ dataPath: dir, port: 0 });
  try {
    assert.equal(started.captureDir, dir);
    assert.ok(started.entryCount > 0);
    assert.ok(started.routeCount > 0);

    const address = started.server.address();
    assert.ok(address && typeof address === 'object');
    const port = (address as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/_traffic`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ url: string }>;
    assert.ok(body.some((e) => e.url.includes('/api/widgets')));
  } finally {
    started.server.close();
  }
});

test('startMockServer: an explicit port option is honored', async () => {
  const port = 34567 + Math.floor(Math.random() * 1000);
  const started = await startMockServer({ dataPath: FIXTURE_CAPTURE_DIR, port });
  try {
    assert.equal(started.port, port);
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
  } finally {
    started.server.close();
  }
});
