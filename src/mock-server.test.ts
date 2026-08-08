/**
 * src/mock-server.test.ts — loadTraffic() directory-form acceptance
 *
 * mock-server.ts runs its startup (loadTraffic + server.listen) as a
 * top-level side effect on import, so it can't be unit-tested by importing
 * the module directly without also starting a live server. This spawns the
 * CLI's `serve` subcommand as a child process instead and exercises it over
 * HTTP — the same path a real `mockify serve --data <dir>` invocation takes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
// test/fixtures/captures/traffic.json — pointing MOCK_DATA_PATH at this
// *directory* (not the file inside it) is exactly the directory form
// loadTraffic() must accept.
const FIXTURE_CAPTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'captures');

function waitForOutput(child: ReturnType<typeof spawn>, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for /${pattern.source}/ in server output. Got:\n${buf}`));
    }, timeoutMs);
    const onData = (data: Buffer) => {
      buf += data.toString();
      if (pattern.test(buf)) {
        clearTimeout(timer);
        child.stderr?.off('data', onData);
        resolve(buf);
      }
    };
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('mockify serve accepts a capture directory (not just traffic.json) via MOCK_DATA_PATH', async () => {
  const port = 34567 + Math.floor(Math.random() * 1000);

  const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, 'serve'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_DATA_PATH: FIXTURE_CAPTURE_DIR,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  try {
    const output = await waitForOutput(child, /Loaded \d+ traffic entries/);
    assert.match(output, /Loaded \d+ traffic entries from traffic\.json/);

    const res = await fetch(`http://localhost:${port}/_traffic`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ url: string; method: string }>;
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0, 'expected at least one traffic entry from the fixture');
    assert.ok(body.some((e) => e.url.includes('/api/widgets')));
  } finally {
    child.kill();
  }
});
