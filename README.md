# mockify

mockify records HTTP traffic from a live web application and replays it as a
local mock server. Point a recorder at a real site, browse around (or drive
it programmatically), and mockify saves every request/response pair to a
`traffic.json` file. Point the mock server at that file and it serves the
same responses back, matched by method, path, and (for GET) query
parameters — no live backend required.

This is useful for developing or testing a frontend against a stable,
offline copy of an API's behavior, including deliberately injected failure
modes (see Fault injection, below).

## Quickstart

Install dependencies and build:

```bash
npm install
npm run build
```

Record traffic from a live site. This launches a visible Chromium window;
log in and browse around, then press Ctrl+C to save the capture:

```bash
npx mockify capture --url https://app.example.com
```

By default this writes to `captures/<timestamp>/traffic.json` (plus
screenshots, console logs, and a summary) under the current directory.

Serve the capture back as a mock server:

```bash
npx mockify serve --data captures/2024-01-01_12-00-00/traffic.json --port 3456
```

`--data` sets `MOCK_DATA_PATH`; `--port` sets `PORT`. If `--data` is
omitted, the server searches `<cwd>/captures/` for a `traffic.json` (see
"Capture discovery" below).

During development you can run the CLI directly against source with `tsx`
instead of building first:

```bash
npm run serve -- --data captures/2024-01-01_12-00-00/traffic.json
```

## Capture discovery

When `MOCK_DATA_PATH` is not set, the mock server looks for traffic data
relative to the current working directory (`process.cwd()`), in this order:

1. `<cwd>/captures/mock-traffic.json`
2. `<cwd>/captures/traffic.json`
3. `<cwd>/captures/<subdir>/traffic.json`, most recent subdirectory first
   (subdirectories are named by capture timestamp, so a lexicographic sort
   picks the latest)

Set `MOCK_DATA_PATH` to point directly at a specific `traffic.json` file to
bypass this search entirely.

## The traffic.json format

`traffic.json` is a JSON array of captured request/response pairs. The
contract is defined in `src/format/types.ts` as `CapturedTraffic`, and is
produced both by mockify's own recorders (`src/recorders/browse-and-capture.mjs`,
`src/recorders/cdp-capture.ts`) and by specify's capture command — mockify's
recorders and mock server were extracted from the specify project and share
this format with it. Each entry looks like:

```json
{
  "url": "https://example.com/api/widgets",
  "method": "GET",
  "postData": null,
  "status": 200,
  "contentType": "application/json; charset=utf-8",
  "ts": 1700000000000,
  "tsStart": 1699999999900,
  "tsEnd": 1700000000000,
  "responseBody": "{\"widgets\":[...]}"
}
```

`tsStart`/`tsEnd` and `injectedFault` are optional fields not present in
every capture; see the Roadmap below for what the mock server does and does
not currently do with them.

## Fault injection

The mock server can randomly inject failures instead of replaying the real
captured response, to test how a frontend handles a flaky backend. Set
`MOCK_FAULT_RATE` to a value between 0 and 1 to enable it:

```bash
MOCK_FAULT_RATE=0.1 npx mockify serve --data captures/traffic.json
# or:
npm run serve:chaos
```

Environment variables (read by `src/mock-server.ts`):

- `PORT` — server port (default: `3456`)
- `MOCK_DATA_PATH` — path to `traffic.json` (default: searches `captures/`, see above)
- `MOCK_SESSION_COOKIE_NAME` — primary session cookie name (default: `session`)
- `MOCK_SESSION_COOKIE_2_NAME` — optional secondary cookie name (default: empty/disabled)
- `MOCK_SESSION_TTL_MS` — session TTL in milliseconds (default: `600000`, 10 minutes)
- `MOCK_FAULT_RATE` — fault injection rate, `0.0`–`1.0` (default: `0`, disabled)
- `MOCK_FAULT_TYPES` — comma-separated subset of fault types to inject: `302,500,timeout,empty,malformed` (default: all of them)
- `MOCK_LOGIN_PATH` — login page path (default: `/login`)
- `MOCK_POST_LOGIN_REDIRECT` — where to redirect after a successful login (default: `/`)
- `MOCK_REFRESH_PATH` — cookie refresh endpoint path (default: `/auth/refresh`)

Requests to any path other than the login page and the diagnostics
endpoints below require a valid session cookie; `POST` to `MOCK_LOGIN_PATH`
with any non-empty `username`/`password` form fields creates one.

## Diagnostics endpoints

These do not require a session cookie:

- `GET /` — index of available routes and how many captures exist for each
- `GET /_traffic` — the full raw traffic data currently loaded
- `GET /_faults` — fault injection configuration and live stats
- `GET /_sessions` — currently active sessions and their remaining TTL

## Roadmap

Known gaps in the current extraction, in no particular order:

- **Header capture and replay.** The current format records no headers, so
  cookies/auth/CORS are not replayable.
- **JSON request-body matching.** Currently form-encoded only.
- **Body matching for PUT/PATCH/DELETE.** Currently routed through GET
  matching.
- **Latency simulation from `tsStart`/`tsEnd`.** Captured but unused.
- **Sequence-aware/stateful replay.**
- **A test suite.** Currently none.

## Spec

`mockify.spec.yaml` in the repo root is a starter behavioral spec, in
specify's v2 format, covering the behaviors described above that actually
exist today (serving captures, the diagnostics endpoints, capturing
traffic, and 404 handling for unknown routes). It's verifiable with
specify itself: `specify verify --spec mockify.spec.yaml`.

## License

GPL-3.0. See [LICENSE](./LICENSE).
