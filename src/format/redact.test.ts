import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  REDACTED,
  isSecretBodyKey,
  isSecretHeaderName,
  redactHeaders,
  redactBodyString,
  redactTrafficEntry,
  envDisablesRedaction,
} from './redact.js';

// ---------------------------------------------------------------------------
// isSecretBodyKey / isSecretHeaderName
// ---------------------------------------------------------------------------

test('isSecretBodyKey: matches the documented substrings, case-insensitively and across separators', () => {
  for (const key of [
    'token', 'Token', 'accessToken', 'refresh_token',
    'password', 'Password',
    'apiKey', 'api_key', 'API-KEY',
    'secret', 'clientSecret',
    'authorization', 'Authorization',
    'session', 'sessionId', 'session_id',
    'bearer', 'bearerToken',
  ]) {
    assert.equal(isSecretBodyKey(key), true, `expected "${key}" to be treated as secret`);
  }
});

test('isSecretBodyKey: leaves ordinary keys alone', () => {
  for (const key of ['id', 'name', 'roomId', 'status', 'createdAt', 'email']) {
    assert.equal(isSecretBodyKey(key), false, `expected "${key}" to NOT be treated as secret`);
  }
});

test('isSecretHeaderName: matches Authorization/Cookie/Set-Cookie/x-api-key case-insensitively', () => {
  for (const name of ['Authorization', 'authorization', 'Cookie', 'Set-Cookie', 'set-cookie', 'X-Api-Key', 'x-api-key']) {
    assert.equal(isSecretHeaderName(name), true, `expected "${name}" to be treated as secret`);
  }
});

test('isSecretHeaderName: leaves ordinary headers alone', () => {
  for (const name of ['content-type', 'accept', 'x-request-id', 'user-agent']) {
    assert.equal(isSecretHeaderName(name), false, `expected "${name}" to NOT be treated as secret`);
  }
});

// ---------------------------------------------------------------------------
// redactHeaders
// ---------------------------------------------------------------------------

test('redactHeaders: replaces Authorization/Cookie/Set-Cookie/x-api-key values, leaves others', () => {
  const out = redactHeaders({
    authorization: 'Bearer abc123',
    Cookie: 'sid=xyz',
    'Set-Cookie': 'sid=xyz; HttpOnly',
    'X-Api-Key': 'sk-live-123',
    'content-type': 'application/json',
    'x-request-id': 'req-1',
  });
  assert.equal(out.authorization, REDACTED);
  assert.equal(out.Cookie, REDACTED);
  assert.equal(out['Set-Cookie'], REDACTED);
  assert.equal(out['X-Api-Key'], REDACTED);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['x-request-id'], 'req-1');
});

test('redactHeaders: passes through undefined/null without throwing', () => {
  assert.equal(redactHeaders(undefined), undefined);
  assert.equal(redactHeaders(null), null);
});

// ---------------------------------------------------------------------------
// redactBodyString — JSON, including nested objects
// ---------------------------------------------------------------------------

test('redactBodyString: redacts top-level secret keys in a JSON object', () => {
  const body = JSON.stringify({ id: 1, token: 'abc123', name: 'ok' });
  const out = JSON.parse(redactBodyString(body)!);
  assert.equal(out.id, 1);
  assert.equal(out.token, REDACTED);
  assert.equal(out.name, 'ok');
});

test('redactBodyString: redacts secret keys nested arbitrarily deep, including inside arrays', () => {
  const body = JSON.stringify({
    user: {
      id: 1,
      credentials: { apiKey: 'sk-live-xyz', password: 'hunter2' },
      // Container key ("devices") deliberately does NOT itself look secret,
      // so this exercises redaction reaching *into* an array of objects
      // rather than the whole array being replaced because its own key
      // (e.g. a field literally named "sessions") matched first.
      devices: [{ session_id: 's1', device: 'phone' }, { session_id: 's2', device: 'laptop' }],
    },
    meta: { requestId: 'r-1' },
  });
  const out = JSON.parse(redactBodyString(body)!);
  assert.equal(out.user.id, 1);
  assert.equal(out.user.credentials.apiKey, REDACTED);
  assert.equal(out.user.credentials.password, REDACTED);
  assert.equal(out.user.devices[0].session_id, REDACTED);
  assert.equal(out.user.devices[0].device, 'phone');
  assert.equal(out.user.devices[1].session_id, REDACTED);
  assert.equal(out.meta.requestId, 'r-1');
});

test('redactBodyString: a container key that itself looks secret (e.g. "sessions") is redacted wholesale, not descended into', () => {
  const body = JSON.stringify({
    sessions: [{ id: 's1', ip: '1.2.3.4' }],
  });
  const out = JSON.parse(redactBodyString(body)!);
  assert.equal(out.sessions, REDACTED);
});

test('redactBodyString: redacts secret keys in a top-level JSON array of objects', () => {
  const body = JSON.stringify([{ token: 't1' }, { token: 't2', ok: true }]);
  const out = JSON.parse(redactBodyString(body)!);
  assert.equal(out[0].token, REDACTED);
  assert.equal(out[1].token, REDACTED);
  assert.equal(out[1].ok, true);
});

test('redactBodyString: leaves non-secret JSON untouched (value-equal, order-preserving)', () => {
  const body = JSON.stringify({ id: 1, roomName: '101', roomPrice: 100 });
  assert.equal(redactBodyString(body), body);
});

test('redactBodyString: null/undefined/empty string pass through unchanged', () => {
  assert.equal(redactBodyString(null), null);
  assert.equal(redactBodyString(undefined), undefined);
  assert.equal(redactBodyString(''), '');
});

test('redactBodyString: non-JSON plain text is returned unchanged', () => {
  assert.equal(redactBodyString('hello world'), 'hello world');
});

test('redactBodyString: a bare JSON scalar has no keys to redact and passes through', () => {
  assert.equal(redactBodyString('42'), '42');
  assert.equal(redactBodyString('"just a string"'), '"just a string"');
});

// ---------------------------------------------------------------------------
// redactBodyString — form-urlencoded (login forms)
// ---------------------------------------------------------------------------

test('redactBodyString: redacts secret fields in a form-urlencoded body', () => {
  const out = redactBodyString('username=alice&password=hunter2&remember=1')!;
  const params = new URLSearchParams(out);
  assert.equal(params.get('username'), 'alice');
  assert.equal(params.get('password'), REDACTED);
  assert.equal(params.get('remember'), '1');
});

test('redactBodyString: form-encoded body with no secret fields is untouched', () => {
  const body = 'q=widgets&page=2';
  assert.equal(redactBodyString(body), body);
});

// ---------------------------------------------------------------------------
// redactTrafficEntry
// ---------------------------------------------------------------------------

test('redactTrafficEntry: redacts postData and responseBody, preserves every other field', () => {
  const entry = {
    url: 'https://x.test/api/login',
    method: 'POST',
    postData: JSON.stringify({ username: 'alice', password: 'hunter2' }),
    status: 200,
    contentType: 'application/json',
    ts: 123,
    responseBody: JSON.stringify({ accessToken: 'abc', expiresIn: 3600 }),
  };
  const out = redactTrafficEntry(entry);
  assert.equal(out.url, entry.url);
  assert.equal(out.method, entry.method);
  assert.equal(out.status, 200);
  assert.equal(out.contentType, 'application/json');
  assert.equal(out.ts, 123);
  assert.equal(JSON.parse(out.postData!).username, 'alice');
  assert.equal(JSON.parse(out.postData!).password, REDACTED);
  assert.equal(JSON.parse(out.responseBody!).accessToken, REDACTED);
  assert.equal(JSON.parse(out.responseBody!).expiresIn, 3600);
  // Original entry is untouched — redaction returns a new object.
  assert.ok(entry.postData.includes('hunter2'));
});

// ---------------------------------------------------------------------------
// envDisablesRedaction
// ---------------------------------------------------------------------------

test('envDisablesRedaction: true for "1" and "true" (any case), false otherwise', () => {
  const orig = process.env.MOCKIFY_NO_REDACT;
  try {
    delete process.env.MOCKIFY_NO_REDACT;
    assert.equal(envDisablesRedaction(), false);

    process.env.MOCKIFY_NO_REDACT = '1';
    assert.equal(envDisablesRedaction(), true);

    process.env.MOCKIFY_NO_REDACT = 'true';
    assert.equal(envDisablesRedaction(), true);

    process.env.MOCKIFY_NO_REDACT = 'TRUE';
    assert.equal(envDisablesRedaction(), true);

    process.env.MOCKIFY_NO_REDACT = '0';
    assert.equal(envDisablesRedaction(), false);

    process.env.MOCKIFY_NO_REDACT = '';
    assert.equal(envDisablesRedaction(), false);
  } finally {
    if (orig === undefined) delete process.env.MOCKIFY_NO_REDACT;
    else process.env.MOCKIFY_NO_REDACT = orig;
  }
});
