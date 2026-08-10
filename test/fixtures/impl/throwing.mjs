// test/fixtures/impl/throwing.mjs — deliberately-broken implementation used
// to prove the mock server's implementation tier (src/mock-server.ts) falls
// through to the next tier instead of 500ing when a generated implementation
// throws. Every handle() call throws unconditionally, regardless of the
// request — the mock server should never let this crash the response.

function reset() {}

function handle() {
  throw new Error('throwing.mjs: intentional failure for fallthrough testing');
}

export default { reset, handle };
