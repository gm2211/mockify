// test/fixtures/impl/cheating.mjs — a "cheating" implementation, hand-written
// to prove the validation harness (src/infer/harness.ts) and hardcoding
// detector (src/infer/hardcoding.ts) catch memorization.
//
// This is exactly what a naive generator could produce: a lookup table
// keyed by the exact request, returning the recorded response body
// byte-for-byte. It only knows the responses recorded for the TRAIN half of
// test/fixtures/infer-capture/traffic.json's deterministic split (item 4's
// detail GET and the "Widget Eta" POST are the holdout pair — see
// src/infer/split.test.ts / src/infer/harness.test.ts, which compute that
// split directly rather than re-deriving it here) — so it scores perfectly
// on train and returns null (decline) for anything it wasn't shown,
// collapsing on holdout. Its source also contains the recorded response
// bodies verbatim, which the static scan is built to catch.

const MEMORY = {
  'GET /api/items': {
    status: 200,
    contentType: 'application/json',
    body: '[{"id":1,"name":"Widget Alpha","description":"A sturdy alpha-grade widget rated for industrial vibration testing"},{"id":2,"name":"Widget Beta","description":"A lightweight beta widget still undergoing lab experimentation trials"},{"id":3,"name":"Widget Gamma","description":"The gamma widget resists corrosion admirably in coastal seawater environments"},{"id":4,"name":"Widget Delta","description":"Delta widgets ship pre-assembled directly from the Cascade manufacturing facility"},{"id":5,"name":"Widget Epsilon","description":"Epsilon is the specialized export variant sold exclusively in Argentina"}]',
  },
  'GET /api/items/1': {
    status: 200,
    contentType: 'application/json',
    body: '{"id":1,"name":"Widget Alpha","description":"A sturdy alpha-grade widget rated for industrial vibration testing"}',
  },
  'GET /api/items/2': {
    status: 200,
    contentType: 'application/json',
    body: '{"id":2,"name":"Widget Beta","description":"A lightweight beta widget still undergoing lab experimentation trials"}',
  },
  'GET /api/items/3': {
    status: 200,
    contentType: 'application/json',
    body: '{"id":3,"name":"Widget Gamma","description":"The gamma widget resists corrosion admirably in coastal seawater environments"}',
  },
  'GET /api/items/5': {
    status: 200,
    contentType: 'application/json',
    body: '{"id":5,"name":"Widget Epsilon","description":"Epsilon is the specialized export variant sold exclusively in Argentina"}',
  },
  'POST /api/items:{"name":"Widget Zeta","description":"Zeta is the newest experimental prototype awaiting certification"}': {
    status: 201,
    contentType: 'application/json',
    body: '{"id":6,"name":"Widget Zeta","description":"Zeta is the newest experimental prototype awaiting certification"}',
  },
  // Deliberately NOT memorized: GET /api/items/4, and the "Widget Eta" POST
  // — those are the fixture's holdout pair. A real generator that only saw
  // train data would never have seen these either.
};

function reset() {
  // Nothing to reset — this "implementation" has no state, only a static
  // memorized table. That absence of state is itself a tell: it can never
  // support the POST-then-GET statefulness test/fixtures/impl/good.mjs
  // demonstrates.
}

function handle({ method, path, body }) {
  const key = method === 'POST' ? `${method} ${path}:${body}` : `${method} ${path}`;
  const hit = MEMORY[key];
  if (!hit) return null; // decline anything outside the memorized table
  return hit;
}

export default { reset, handle };
