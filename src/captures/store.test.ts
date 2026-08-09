/**
 * src/captures/store.test.ts — the capture registry (name ⇄ directory)
 *
 * All tests point MOCKIFY_CAPTURES_DIR at a fresh temp directory so nothing
 * here ever touches the real captures/ folder.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  allocateCaptureDir,
  capturesRoot,
  listCaptures,
  resolveCapture,
  slugifyName,
} from './store.js';

/** Run `fn` with MOCKIFY_CAPTURES_DIR pointed at a fresh temp dir, restoring
 * the previous env var value afterward regardless of outcome. */
async function withTempCapturesRoot(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-captures-'));
  const previous = process.env.MOCKIFY_CAPTURES_DIR;
  process.env.MOCKIFY_CAPTURES_DIR = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.MOCKIFY_CAPTURES_DIR;
    else process.env.MOCKIFY_CAPTURES_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeCapture(
  dir: string,
  opts: { traffic?: unknown[]; manifest?: unknown; screenshotCount?: number; syntheticTemplateCount?: number } = {}
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'traffic.json'), JSON.stringify(opts.traffic ?? []), 'utf8');
  if (opts.manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(opts.manifest), 'utf8');
  }
  if (opts.screenshotCount) {
    const shotDir = path.join(dir, 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    for (let i = 0; i < opts.screenshotCount; i++) {
      fs.writeFileSync(path.join(shotDir, `${String(i).padStart(3, '0')}-shot.png`), '');
    }
  }
  if (opts.syntheticTemplateCount !== undefined) {
    const synthDir = path.join(dir, 'synthetic');
    fs.mkdirSync(synthDir, { recursive: true });
    fs.writeFileSync(
      path.join(synthDir, 'index.json'),
      JSON.stringify({ version: 1, generatedFrom: 0, templates: new Array(opts.syntheticTemplateCount).fill({}) }),
      'utf8'
    );
  }
}

// ---------------------------------------------------------------------------
// capturesRoot
// ---------------------------------------------------------------------------

test('capturesRoot: defaults to <cwd>/captures when MOCKIFY_CAPTURES_DIR is unset', () => {
  const previous = process.env.MOCKIFY_CAPTURES_DIR;
  delete process.env.MOCKIFY_CAPTURES_DIR;
  try {
    assert.equal(capturesRoot(), path.resolve(process.cwd(), 'captures'));
  } finally {
    if (previous !== undefined) process.env.MOCKIFY_CAPTURES_DIR = previous;
  }
});

test('capturesRoot: honors MOCKIFY_CAPTURES_DIR when set', async () => {
  await withTempCapturesRoot((root) => {
    assert.equal(capturesRoot(), root);
  });
});

// ---------------------------------------------------------------------------
// slugifyName
// ---------------------------------------------------------------------------

test('slugifyName: hostname → lowercase hyphenated slug', () => {
  assert.equal(slugifyName('https://automationintesting.online'), 'automationintesting-online');
});

test('slugifyName: strips a leading www', () => {
  assert.equal(slugifyName('https://www.automationintesting.online'), 'automationintesting-online');
});

test('slugifyName: mixed case hostname is lowercased', () => {
  assert.equal(slugifyName('https://APP.Example.COM'), 'app-example-com');
});

test('slugifyName: ports are dropped (URL.hostname excludes the port)', () => {
  assert.equal(slugifyName('http://localhost:4173'), 'localhost');
});

test('slugifyName: paths and query strings are ignored — only the hostname matters', () => {
  assert.equal(slugifyName('https://example.com/foo/bar?x=1'), 'example-com');
});

test('slugifyName: underscores in the hostname become hyphens', () => {
  assert.equal(slugifyName('https://my_app.example.com'), 'my-app-example-com');
});

test('slugifyName: falls back to a sanitized raw string for an unparseable "url"', () => {
  // Spaces/punctuation aren't in the documented dots/underscores→hyphen
  // rule, so they're simply dropped (not turned into hyphens) — this just
  // pins the actual, documented behavior rather than asserting a nicer
  // hyphenation this function doesn't promise.
  assert.equal(slugifyName('not a url!!'), 'notaurl');
});

// ---------------------------------------------------------------------------
// allocateCaptureDir
// ---------------------------------------------------------------------------

test('allocateCaptureDir: defaults the name to the URL slug', async () => {
  await withTempCapturesRoot((root) => {
    const { name, dir } = allocateCaptureDir('https://automationintesting.online');
    assert.equal(name, 'automationintesting-online');
    assert.equal(dir, path.join(root, 'automationintesting-online'));
  });
});

test('allocateCaptureDir: an explicit name overrides the URL slug', async () => {
  await withTempCapturesRoot(() => {
    const { name } = allocateCaptureDir('https://automationintesting.online', 'my-demo');
    assert.equal(name, 'my-demo');
  });
});

test('allocateCaptureDir: creates nothing on disk — pure resolution', async () => {
  await withTempCapturesRoot((root) => {
    const { dir } = allocateCaptureDir('https://example.com');
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(root), true); // withTempCapturesRoot itself creates the root
  });
});

test('allocateCaptureDir: suffixes -2, -3, … when the name collides with an existing completed capture', async () => {
  await withTempCapturesRoot((root) => {
    writeCapture(path.join(root, 'example-com'), { traffic: [] });
    writeCapture(path.join(root, 'example-com-2'), { traffic: [] });

    const { name, dir } = allocateCaptureDir('https://example.com');
    assert.equal(name, 'example-com-3');
    assert.equal(dir, path.join(root, 'example-com-3'));
  });
});

test('allocateCaptureDir: a same-named directory WITHOUT traffic.json (e.g. an in-progress capture) does not trigger suffixing', async () => {
  await withTempCapturesRoot((root) => {
    fs.mkdirSync(path.join(root, 'example-com'), { recursive: true }); // no traffic.json yet
    const { name } = allocateCaptureDir('https://example.com');
    assert.equal(name, 'example-com');
  });
});

// ---------------------------------------------------------------------------
// listCaptures
// ---------------------------------------------------------------------------

test('listCaptures: returns [] when capturesRoot() does not exist', async () => {
  await withTempCapturesRoot((root) => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(listCaptures(), []);
  });
});

test('listCaptures: scans a mix of a good dir, a dir missing traffic.json (skipped), and a dir with synthetic templates', async () => {
  await withTempCapturesRoot((root) => {
    writeCapture(path.join(root, 'good-capture'), {
      traffic: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }],
      manifest: {
        session: {
          timestamp: '2026-01-01T00:00:00.000Z',
          targetUrl: 'https://example.com',
          hostFilter: 'example.com',
          outputDir: '/tmp/x',
          totalRequests: 2,
          totalScreenshots: 1,
          pagesVisited: 1,
          consoleLogCount: 0,
        },
      },
      screenshotCount: 1,
    });

    // No traffic.json at all — must be skipped, not crash the scan.
    fs.mkdirSync(path.join(root, 'incomplete-capture'), { recursive: true });
    fs.writeFileSync(path.join(root, 'incomplete-capture', 'notes.txt'), 'not a capture', 'utf8');

    writeCapture(path.join(root, 'with-synthetic'), {
      traffic: [{ url: 'https://example.com/c' }],
      manifest: {
        session: {
          timestamp: '2026-02-01T00:00:00.000Z',
          targetUrl: 'https://example.com',
          hostFilter: 'example.com',
          outputDir: '/tmp/y',
          totalRequests: 1,
          totalScreenshots: 0,
          pagesVisited: 1,
          consoleLogCount: 0,
        },
      },
      syntheticTemplateCount: 3,
    });

    const captures = listCaptures();
    assert.equal(captures.length, 2, 'the dir without traffic.json must be skipped');
    assert.ok(!captures.some((c) => c.name === 'incomplete-capture'));

    const withSynthetic = captures.find((c) => c.name === 'with-synthetic');
    assert.ok(withSynthetic);
    assert.equal(withSynthetic!.syntheticTemplates, 3);
    assert.equal(withSynthetic!.requests, 1);

    const good = captures.find((c) => c.name === 'good-capture');
    assert.ok(good);
    assert.equal(good!.requests, 2);
    assert.equal(good!.screenshots, 1);
    assert.equal(good!.target, 'https://example.com');
    assert.equal(good!.syntheticTemplates, 0);
  });
});

test('listCaptures: sorts newest first by capturedAt', async () => {
  await withTempCapturesRoot((root) => {
    writeCapture(path.join(root, 'older'), {
      traffic: [],
      manifest: { session: { timestamp: '2026-01-01T00:00:00.000Z', targetUrl: 'https://a.example.com' } },
    });
    writeCapture(path.join(root, 'newer'), {
      traffic: [],
      manifest: { session: { timestamp: '2026-06-01T00:00:00.000Z', targetUrl: 'https://b.example.com' } },
    });

    const names = listCaptures().map((c) => c.name);
    assert.deepEqual(names, ['newer', 'older']);
  });
});

test('listCaptures: tolerates a malformed traffic.json by skipping that dir, without crashing the scan', async () => {
  await withTempCapturesRoot((root) => {
    const badDir = path.join(root, 'corrupt');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'traffic.json'), '{ not valid json', 'utf8');

    writeCapture(path.join(root, 'fine'), { traffic: [] });

    const captures = listCaptures();
    assert.deepEqual(captures.map((c) => c.name), ['fine']);
  });
});

// ---------------------------------------------------------------------------
// resolveCapture
// ---------------------------------------------------------------------------

test('resolveCapture: resolves by exact name under capturesRoot()', async () => {
  await withTempCapturesRoot((root) => {
    writeCapture(path.join(root, 'demo-grok'), { traffic: [] });
    const resolved = resolveCapture('demo-grok');
    assert.equal(resolved.name, 'demo-grok');
    assert.equal(resolved.dir, path.join(root, 'demo-grok'));
  });
});

test('resolveCapture: resolves by a filesystem path to a capture directory', async () => {
  await withTempCapturesRoot(() => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-elsewhere-'));
    try {
      writeCapture(elsewhere, { traffic: [] });
      const resolved = resolveCapture(elsewhere);
      assert.equal(resolved.dir, elsewhere);
      assert.equal(resolved.name, path.basename(elsewhere));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('resolveCapture: resolves by a filesystem path directly to a traffic.json file', async () => {
  await withTempCapturesRoot(() => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-elsewhere-file-'));
    try {
      writeCapture(elsewhere, { traffic: [] });
      const resolved = resolveCapture(path.join(elsewhere, 'traffic.json'));
      assert.equal(resolved.dir, elsewhere);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('resolveCapture: throws a clear error naming "mockify list" when nothing resolves', async () => {
  await withTempCapturesRoot(() => {
    assert.throws(() => resolveCapture('does-not-exist-anywhere'), /mockify list/);
  });
});

test('resolveCapture: an exact name match wins even if a same-named relative path would also resolve', async () => {
  await withTempCapturesRoot((root) => {
    writeCapture(path.join(root, 'demo-grok'), {
      traffic: [],
      manifest: { session: { targetUrl: 'https://by-name.example.com' } },
    });
    const resolved = resolveCapture('demo-grok');
    assert.equal(resolved.dir, path.join(root, 'demo-grok'));
  });
});
