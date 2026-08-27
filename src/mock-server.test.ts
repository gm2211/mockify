/**
 * src/mock-server.test.ts — loadTraffic() directory-form acceptance
 *
 * mock-server.ts runs its startup (loadTraffic + server.listen) as a
 * top-level side effect on import, so it can't be unit-tested by importing
 * the module directly without also starting a live server. This spawns the
 * CLI's `serve` subcommand as a child process instead and exercises it over
 * HTTP — the same path a real `mockify serve --data <dir>` invocation takes.
 *
 * Server readiness (SP-ish): spawnMockServer() (src/test-helpers/
 * spawn-mock-server.ts) waits for the server's own "listening" line rather
 * than an earlier startup log line — see that module's doc comment for why
 * the earlier approach was an outright race, not just a slow-CI flake.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { spawnMockServer, REPO_ROOT } from './test-helpers/spawn-mock-server.js';

// test/fixtures/captures/traffic.json — pointing MOCK_DATA_PATH at this
// *directory* (not the file inside it) is exactly the directory form
// loadTraffic() must accept.
const FIXTURE_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'captures');

test('mockify serve accepts a capture directory (not just traffic.json) via MOCK_DATA_PATH', async () => {
  const { child, port, stderr } = await spawnMockServer({ MOCK_DATA_PATH: FIXTURE_CAPTURE_DIR });
  try {
    assert.match(stderr, /Loaded \d+ traffic entries from traffic\.json/);

    const res = await fetch(`http://127.0.0.1:${port}/_traffic`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ url: string; method: string }>;
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0, 'expected at least one traffic entry from the fixture');
    assert.ok(body.some((e) => e.url.includes('/api/widgets')));
  } finally {
    child.kill();
  }
});
