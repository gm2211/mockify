import test from 'node:test';
import assert from 'node:assert/strict';
import { diffHttpMessages, isVolatileFieldName, looksVolatileValue, type HttpMessage } from './engine.js';
import { REDACTED } from '../format/redact.js';

function msg(status: number, body: unknown): HttpMessage {
  return { status, body: body === null ? null : JSON.stringify(body) };
}

test('diffHttpMessages: exact match, no mismatches, no ignored fields for a fully stable body', () => {
  const result = diffHttpMessages(msg(200, { label: 'widget' }), msg(200, { label: 'widget' }));
  assert.equal(result.match, true);
  assert.equal(result.statusMatch, true);
  assert.equal(result.structuralMatch, true);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.ignoredFields, []);
});

test('diffHttpMessages: status mismatch fails the overall match even when bodies agree', () => {
  const result = diffHttpMessages(msg(200, { ok: true }), msg(404, { ok: true }));
  assert.equal(result.match, false);
  assert.equal(result.statusMatch, false);
  assert.equal(result.structuralMatch, true);
  assert.equal(result.expectedStatus, 200);
  assert.equal(result.actualStatus, 404);
});

test('diffHttpMessages: structural mismatch — actual is missing a recorded key', () => {
  const result = diffHttpMessages(msg(200, { label: 'widget', color: 'red' }), msg(200, { label: 'widget' }));
  assert.equal(result.match, false);
  assert.equal(result.structuralMatch, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]?.path, '$.color');
  assert.equal(result.mismatches[0]?.reason, 'missing');
});

test('diffHttpMessages: structural mismatch — actual has an extra key not in the recording', () => {
  const result = diffHttpMessages(msg(200, { label: 'widget' }), msg(200, { label: 'widget', color: 'red' }));
  assert.equal(result.match, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]?.reason, 'extra');
  assert.equal(result.mismatches[0]?.path, '$.color');
});

test('diffHttpMessages: value mismatch on a non-volatile field is reported', () => {
  const result = diffHttpMessages(msg(200, { label: 'widget' }), msg(200, { label: 'gadget' }));
  assert.equal(result.match, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]?.reason, 'value');
  assert.equal(result.mismatches[0]?.expected, 'widget');
  assert.equal(result.mismatches[0]?.actual, 'gadget');
});

test('diffHttpMessages: type mismatch is its own reason, distinct from value', () => {
  const result = diffHttpMessages(msg(200, { count: 3 }), msg(200, { count: '3' }));
  assert.equal(result.mismatches[0]?.reason, 'type');
});

test('diffHttpMessages: array length mismatch is reported and compares the overlap element-wise', () => {
  const result = diffHttpMessages(msg(200, { items: [1, 2, 3] }), msg(200, { items: [1, 2] }));
  assert.equal(result.match, false);
  const arrMismatch = result.mismatches.find((m) => m.reason === 'array-length');
  assert.ok(arrMismatch);
  assert.equal(arrMismatch?.expected, 3);
  assert.equal(arrMismatch?.actual, 2);
});

test('diffHttpMessages: volatile field names (id, timestamps, tokens) are ignored, not diffed', () => {
  const result = diffHttpMessages(
    msg(200, { id: 1, createdAt: '2024-01-01T00:00:00Z', sessionToken: 'abc', label: 'widget' }),
    msg(200, { id: 999, createdAt: '2025-06-06T12:00:00Z', sessionToken: 'xyz', label: 'widget' }),
  );
  assert.equal(result.match, true);
  assert.deepEqual(result.mismatches, []);
  assert.ok(result.ignoredFields.includes('$.id'));
  assert.ok(result.ignoredFields.includes('$.createdAt'));
  assert.ok(result.ignoredFields.includes('$.sessionToken'));
});

test('diffHttpMessages: volatile-looking values (UUID, ISO date, epoch ms) are ignored even under a generic key name', () => {
  const result = diffHttpMessages(
    msg(200, { key: '4d1c1e2a-4b5b-4c6d-8e9f-0123456789ab', when: '2024-01-01T00:00:00.000Z', ms: 1735689600000 }),
    msg(200, { key: 'ffffffff-ffff-ffff-ffff-ffffffffffff', when: '2025-01-01T00:00:00.000Z', ms: 1767225600000 }),
  );
  assert.deepEqual(result.mismatches, []);
});

test('diffHttpMessages: redacted ([REDACTED]) fields are excluded from diffing entirely, never a false failure', () => {
  const result = diffHttpMessages(msg(200, { token: REDACTED, label: 'widget' }), msg(200, { token: 'live-value-xyz', label: 'widget' }));
  assert.equal(result.match, true);
  assert.ok(result.ignoredFields.includes('$.token'));
});

test('diffHttpMessages: redacted field missing entirely on the actual side is still excluded, not "missing"', () => {
  const result = diffHttpMessages(msg(200, { token: REDACTED, label: 'widget' }), msg(200, { label: 'widget' }));
  assert.equal(result.match, true);
  assert.deepEqual(result.mismatches, []);
});

test('diffHttpMessages: strict mode disables volatile tolerance and diffs everything verbatim', () => {
  const result = diffHttpMessages(msg(200, { id: 1 }), msg(200, { id: 2 }), { strict: true });
  assert.equal(result.match, false);
  assert.equal(result.mismatches[0]?.path, '$.id');
});

test('diffHttpMessages: strict mode still excludes redacted fields (redaction is not a tolerance setting)', () => {
  const result = diffHttpMessages(msg(200, { token: REDACTED }), msg(200, { token: 'live' }), { strict: true });
  assert.equal(result.match, true);
});

test('diffHttpMessages: extraVolatileFields adds app-specific ignore patterns on top of the built-in list', () => {
  const result = diffHttpMessages(
    msg(200, { traceparent: 'abc' }),
    msg(200, { traceparent: 'xyz' }),
    { extraVolatileFields: ['traceparent'] },
  );
  assert.equal(result.match, true);
});

test('diffHttpMessages: null body on both sides matches', () => {
  const result = diffHttpMessages({ status: 204, body: null }, { status: 204, body: null });
  assert.equal(result.match, true);
});

test('diffHttpMessages: non-JSON text bodies compare as plain strings', () => {
  const result = diffHttpMessages({ status: 200, body: 'hello world' }, { status: 200, body: 'hello world' });
  assert.equal(result.match, true);
});

test('diffHttpMessages: non-JSON text body mismatch is reported', () => {
  const result = diffHttpMessages({ status: 200, body: 'hello' }, { status: 200, body: 'goodbye' });
  assert.equal(result.match, false);
});

test('isVolatileFieldName: matches id/timestamp/token-shaped names, not arbitrary ones', () => {
  assert.equal(isVolatileFieldName('id', []), true);
  assert.equal(isVolatileFieldName('userId', []), true);
  assert.equal(isVolatileFieldName('createdAt', []), true);
  assert.equal(isVolatileFieldName('csrfToken', []), true);
  assert.equal(isVolatileFieldName('label', []), false);
  assert.equal(isVolatileFieldName('color', []), false);
});

test('looksVolatileValue: UUID and ISO date strings are volatile-shaped, arbitrary strings are not', () => {
  assert.equal(looksVolatileValue('4d1c1e2a-4b5b-4c6d-8e9f-0123456789ab'), true);
  assert.equal(looksVolatileValue('2024-01-01T00:00:00Z'), true);
  assert.equal(looksVolatileValue('widget'), false);
  assert.equal(looksVolatileValue(3), false);
  assert.equal(looksVolatileValue(1735689600000), true);
});
