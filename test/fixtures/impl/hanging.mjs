// test/fixtures/impl/hanging.mjs — deliberately-hung implementation used to
// prove the mock server's implementation tier (src/mock-server.ts) enforces
// its wall-clock timeout (MOCKIFY_IMPL_TIMEOUT_MS) rather than letting a
// generated implementation hang the response forever. handle() returns a
// promise that never resolves.

function reset() {}

function handle() {
  return new Promise(() => {
    // Never resolves — simulates a generated implementation stuck in an
    // infinite loop, an unresolved external call, or similar.
  });
}

export default { reset, handle };
