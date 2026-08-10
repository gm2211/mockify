import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadImplementation, ImplementationLoadError } from './contract.js';

test('loadImplementation: throws a not_found error for a missing path', async () => {
  const missing = path.join(os.tmpdir(), 'mockify-contract-test-does-not-exist', 'handlers.mjs');
  await assert.rejects(
    () => loadImplementation(missing),
    (err: unknown) => {
      assert.ok(err instanceof ImplementationLoadError);
      assert.equal((err as ImplementationLoadError).code, 'not_found');
      return true;
    }
  );
});

test('loadImplementation: throws invalid_shape when default export is missing handle()/reset()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-contract-'));
  const file = path.join(dir, 'bad.mjs');
  fs.writeFileSync(file, 'export default { reset() {} };\n');
  try {
    await assert.rejects(
      () => loadImplementation(file),
      (err: unknown) => {
        assert.ok(err instanceof ImplementationLoadError);
        assert.equal((err as ImplementationLoadError).code, 'invalid_shape');
        assert.match((err as Error).message, /handle\(\)/);
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadImplementation: throws invalid_shape when there is no default export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-contract-'));
  const file = path.join(dir, 'no-default.mjs');
  fs.writeFileSync(file, 'export const foo = 1;\n');
  try {
    await assert.rejects(() => loadImplementation(file), ImplementationLoadError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadImplementation: throws invalid_shape when the default export is not an object', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-contract-'));
  const file = path.join(dir, 'primitive-default.mjs');
  fs.writeFileSync(file, 'export default "nope";\n');
  try {
    await assert.rejects(() => loadImplementation(file), ImplementationLoadError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadImplementation: loads a conformant module and returns its default export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockify-contract-'));
  const file = path.join(dir, 'good.mjs');
  fs.writeFileSync(
    file,
    'export default { reset() {}, handle() { return { status: 200, contentType: "text/plain", body: "ok" }; } };\n'
  );
  try {
    const impl = await loadImplementation(file);
    assert.equal(typeof impl.reset, 'function');
    assert.equal(typeof impl.handle, 'function');
    const res = await impl.handle({ method: 'GET', path: '/', query: {}, headers: {}, body: undefined });
    assert.deepEqual(res, { status: 200, contentType: 'text/plain', body: 'ok' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
