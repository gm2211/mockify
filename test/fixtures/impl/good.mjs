// test/fixtures/impl/good.mjs — a genuine tiny implementation, hand-written
// to prove the validation harness (src/infer/harness.ts) rewards real
// routing + state over memorization.
//
// It seeds an in-memory store with the same ids/names as the fixture
// capture (test/fixtures/infer-capture/traffic.json) — a real backend for
// this data would obviously return the real names — but writes its own
// description text rather than reproducing the captured prose verbatim, so
// static hardcoding detection (src/infer/hardcoding.ts scanForHardcoding)
// has something real to distinguish it from test/fixtures/impl/cheating.mjs,
// which embeds the recorded response bodies byte-for-byte.
//
// Because this is real routing over real state (not a request->response
// table), it answers item 4 (held out by the fixture's deterministic split)
// exactly as well as it answers items 1/2/3/5 (train) — that's the point:
// the train/holdout gap should be small. It also supports the
// cross-request statefulness a memorized table never could: POST an item,
// then GET it back.

const SEED_ITEMS = [
  { id: 1, name: 'Widget Alpha', description: 'Alpha model, industrial-duty rating' },
  { id: 2, name: 'Widget Beta', description: 'Beta model, still in lab evaluation' },
  { id: 3, name: 'Widget Gamma', description: 'Gamma model, marine-grade coating' },
  { id: 4, name: 'Widget Delta', description: 'Delta model, shipped pre-assembled' },
  { id: 5, name: 'Widget Epsilon', description: 'Epsilon model, export-only variant' },
];

let items = [];
let nextId = 1;

function reset() {
  items = SEED_ITEMS.map((item) => ({ ...item }));
  nextId = items.length + 1;
}

// Seed initial state at module load too, so a caller that forgets to call
// reset() before the very first handle() still gets a sane store.
reset();

function handle({ method, path, body }) {
  if (method === 'GET' && path === '/api/items') {
    return { status: 200, contentType: 'application/json', body: items };
  }

  const detailMatch = /^\/api\/items\/(\d+)$/.exec(path);
  if (method === 'GET' && detailMatch) {
    const id = Number(detailMatch[1]);
    const item = items.find((i) => i.id === id);
    if (!item) {
      return { status: 404, contentType: 'application/json', body: { error: 'not found' } };
    }
    return { status: 200, contentType: 'application/json', body: item };
  }

  if (method === 'POST' && path === '/api/items') {
    let parsed;
    try {
      parsed = JSON.parse(body ?? '{}');
    } catch {
      return { status: 400, contentType: 'application/json', body: { error: 'invalid JSON body' } };
    }
    if (!parsed.name) {
      return { status: 400, contentType: 'application/json', body: { error: 'name is required' } };
    }
    const created = { id: nextId, name: parsed.name, description: parsed.description ?? '' };
    nextId += 1;
    items.push(created);
    return { status: 201, contentType: 'application/json', body: created };
  }

  return null;
}

export default { reset, handle };
