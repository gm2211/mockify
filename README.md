# mockify

Record HTTP traffic from a live web app, then replay it as a local mock server — no live backend required.

![mockify demo: logging in, replaying a captured route, and a 404 with route hints](assets/demo.gif)

## Quickstart

```bash
npm install && npm run build

# Record traffic from a live site (opens a visible Chromium window; browse
# around, then Ctrl+C to save)
npx mockify capture --url https://app.example.com

# Serve the capture back as a mock server
npx mockify serve --data captures/2024-01-01_12-00-00/traffic.json --port 3456
```

If `--data` is omitted, the server searches `<cwd>/captures/` for a `traffic.json` (most recent timestamped subdirectory wins). During development, run `npm run serve -- --data <path>` to use `tsx` directly instead of building first.

## The traffic.json format

A JSON array of request/response pairs, typed as `CapturedTraffic` in `src/format/types.ts`. Produced by mockify's own recorders (`src/recorders/browse-and-capture.mjs`, `src/recorders/cdp-capture.ts`) and also by specify's capture command — mockify's recorders and mock server were extracted from the specify project and share this format with it. Consumable by specify's `spec generate`.

```json
{
  "url": "https://example.com/api/widgets",
  "method": "GET",
  "postData": null,
  "status": 200,
  "contentType": "application/json; charset=utf-8",
  "ts": 1700000000000,
  "responseBody": "{\"widgets\":[...]}"
}
```

## Fault injection

Set `MOCK_FAULT_RATE` (0–1) to randomly inject failures instead of replaying real responses, to test how a frontend handles a flaky backend:

```bash
MOCK_FAULT_RATE=0.1 npx mockify serve --data captures/traffic.json
# or: npm run serve:chaos
```

`MOCK_FAULT_TYPES` restricts which fault types are used (comma-separated subset of `302,500,timeout,empty,malformed`; default: all). Other environment variables (see `src/mock-server.ts`): `PORT`, `MOCK_DATA_PATH`, `MOCK_SESSION_COOKIE_NAME`, `MOCK_SESSION_COOKIE_2_NAME`, `MOCK_SESSION_TTL_MS`, `MOCK_LOGIN_PATH`, `MOCK_POST_LOGIN_REDIRECT`, `MOCK_REFRESH_PATH`.

## Diagnostics endpoints

No session cookie required: `GET /` (route index), `GET /_traffic` (raw traffic data), `GET /_faults` (fault config and stats), `GET /_sessions` (active sessions).

## Spec

`mockify.spec.yaml` is a starter behavioral spec in specify's v2 format, verifiable with `specify verify --spec mockify.spec.yaml`.

## Roadmap

- Header capture and replay (cookies/auth/CORS not currently replayable)
- JSON request-body matching (currently form-encoded only)
- Body matching for PUT/PATCH/DELETE (currently routed through GET matching)
- Latency simulation from `tsStart`/`tsEnd` (captured but unused)
- Sequence-aware/stateful replay
- A test suite (currently none)

## License

GPL-3.0. See [LICENSE](./LICENSE).
