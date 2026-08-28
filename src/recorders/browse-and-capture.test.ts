import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { urlMatchesHostFilter, shouldScheduleApiScreenshot } from './browse-and-capture.js';

// ---------------------------------------------------------------------------
// urlMatchesHostFilter — navigation gating for the screenshot-on-nav /
// screenshot-on-spa-nav listeners (SP-7ow.1)
// ---------------------------------------------------------------------------

test('urlMatchesHostFilter: matches same registrable domain across subdomains', () => {
  assert.equal(urlMatchesHostFilter('https://api.example.com/dashboard', 'www.example.com'), true);
  assert.equal(urlMatchesHostFilter('https://www.example.com/dashboard', 'www.example.com'), true);
});

test('urlMatchesHostFilter: rejects genuinely cross-origin hosts by default', () => {
  assert.equal(urlMatchesHostFilter('https://tracker.other-domain.com/pixel', 'www.example.com'), false);
});

test('urlMatchesHostFilter: empty hostFilter matches everything', () => {
  assert.equal(urlMatchesHostFilter('https://anything.test/page', ''), true);
});

test('urlMatchesHostFilter: invalid URL is rejected, not thrown', () => {
  assert.equal(urlMatchesHostFilter('not a url', 'www.example.com'), false);
});

test('urlMatchesHostFilter: MOCKIFY_CAPTURE_HOST_FILTER widens the match to extra domains', () => {
  const orig = process.env.MOCKIFY_CAPTURE_HOST_FILTER;
  process.env.MOCKIFY_CAPTURE_HOST_FILTER = 'payments.example';
  try {
    assert.equal(urlMatchesHostFilter('https://checkout.payments.example/pay', 'www.example.com'), true);
  } finally {
    if (orig === undefined) delete process.env.MOCKIFY_CAPTURE_HOST_FILTER;
    else process.env.MOCKIFY_CAPTURE_HOST_FILTER = orig;
  }
});

test('urlMatchesHostFilter: MOCKIFY_CAPTURE_HOST_FILTER="*" disables host filtering', () => {
  const orig = process.env.MOCKIFY_CAPTURE_HOST_FILTER;
  process.env.MOCKIFY_CAPTURE_HOST_FILTER = '*';
  try {
    assert.equal(urlMatchesHostFilter('https://anything.test/page', 'www.example.com'), true);
  } finally {
    if (orig === undefined) delete process.env.MOCKIFY_CAPTURE_HOST_FILTER;
    else process.env.MOCKIFY_CAPTURE_HOST_FILTER = orig;
  }
});

// ---------------------------------------------------------------------------
// shouldScheduleApiScreenshot — the debounced "data just loaded" screenshot
// ---------------------------------------------------------------------------

test('shouldScheduleApiScreenshot: true for a substantial 200 JSON response', () => {
  assert.equal(
    shouldScheduleApiScreenshot({ status: 200, contentType: 'application/json', responseBody: 'x'.repeat(51) }),
    true,
  );
});

test('shouldScheduleApiScreenshot: false for a short JSON response', () => {
  assert.equal(
    shouldScheduleApiScreenshot({ status: 200, contentType: 'application/json', responseBody: '{}' }),
    false,
  );
});

test('shouldScheduleApiScreenshot: false for a non-200 status', () => {
  assert.equal(
    shouldScheduleApiScreenshot({ status: 404, contentType: 'application/json', responseBody: 'x'.repeat(51) }),
    false,
  );
});

test('shouldScheduleApiScreenshot: false for a non-JSON content type', () => {
  assert.equal(
    shouldScheduleApiScreenshot({ status: 200, contentType: 'text/html', responseBody: 'x'.repeat(51) }),
    false,
  );
});

test('shouldScheduleApiScreenshot: false when there is no response body', () => {
  assert.equal(
    shouldScheduleApiScreenshot({ status: 200, contentType: 'application/json', responseBody: null }),
    false,
  );
});
