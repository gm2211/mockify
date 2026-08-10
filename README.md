# mockify

Record HTTP traffic from a live web app, then replay it as a local mock server — no live backend required.

## Capture

An agent explores the live app on its own — clicking, filling forms, screenshotting every step — while mockify records every request and response it makes along the way.

![An agent driving a headless browser through a live app while mockify records every request, response, and screenshot](assets/agent-capture.gif)

Point any MCP-capable agent at it, or skip the external agent and let mockify drive its own:

```bash
grok mcp add mockify -- node /path/to/mockify/dist/cli.js mcp
grok -p "capture https://automationintesting.online with the mockify tools"

# or, without an external agent:
mockify capture --url https://automationintesting.online
```

152 requests · 39 screenshots · booking, contact, and admin flows — real numbers from this run.

## What you get

Every capture is a self-contained directory, saved under a name (`mockify list` shows what's there):

```
captures/demo-grok/
├── traffic.json       # every request/response pair — replayed byte-for-byte
├── screenshots/        # one PNG per interaction step, in order
├── observations.json   # what the agent saw and decided at each step
├── manifest.json       # session metadata: target URL, counts, timestamp
└── synthetic/
    └── index.json       # inferred endpoint templates + response shapes (loaded at replay)
```

## Expansion

mockify doesn't just replay what it saw — it generalizes past the literal capture. It notices that `/api/room/1`, `/api/room/2`, and `/api/room/3` are one *endpoint template* (`/api/room/{id}`) and learns the shape of their responses. Ask for `/api/room/7`, never recorded, and you still get a plausible response, generated deterministically (a seeded PRNG) from that observed shape — generated data, never real data, no live backend involved.

A recorded exact match always wins; synthesis only kicks in on a miss. Synthesized responses carry an `X-Mockify-Synthetic: true` header, so you can always tell them apart:

```bash
$ curl localhost:3456/api/room/1        # recorded — replayed byte-for-byte
{"roomid":1,"roomName":"101","roomPrice":100, ...}

$ curl -i localhost:3456/api/room/7     # never recorded — synthesized, 200 OK
X-Mockify-Synthetic: true
{"roomid":7,"roomName":"103","roomPrice":132, ...}
```

`mockify capture` runs synthesis automatically (failures are non-fatal); regenerate by hand with `npx mockify synthesize --data captures/<name>`. `MOCK_SYNTHETIC=0` disables it; `GET /_synthetic` lists loaded templates and hit count.

## Replay

```bash
mockify list                # table of saved captures: target, counts, timestamp
mockify replay demo-grok    # serves it on http://localhost:3456
```

No env vars, no config file — `--port` overrides the default if you need it.

![mockify list showing a saved capture, a look at its files and inferred templates, then a clean replay banner and a recorded-vs-synthesized curl comparison](assets/demo.gif)

## Quickstart

```bash
npm install && npm run build
npx mockify capture --url https://app.example.com            # agent-driven (needs an API key or claude login; see below)
npx mockify capture --url https://app.example.com --manual   # or drive a real browser yourself, no agent needed
npx mockify list
npx mockify replay app-example-com
```

`mockify serve [--data <path>] [--port N]` is a back-compat alias for `replay` (`--data` takes a `traffic.json` file or a capture directory; omitted, it searches `<cwd>/captures/` for the newest one).

## Agent capture & MCP

`mockify capture --url <url>` is agent-driven by default: a Claude agent (`src/agent/runner.ts`) drives a real Chromium browser, surveying the app's pages and then exercising its list/detail/create/update/delete flows, pagination, filters, and error states (`src/agent/prompts.ts`). **Authentication**: `ANTHROPIC_API_KEY`, a `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), or an ambient `claude login` session — first one found wins. **Options**: `--name <name>` (default: slugified from `--url`), `--output <dir>` (bypasses naming entirely), `--headed`, `--storage-state <path|keychain:name>` / `--save-storage-state <path|keychain:name>`, `--timeout <seconds>`. **Manual fallback**: `--manual` opens a visible Chromium window for you to drive by hand — no API key needed. **Env**: `MOCKIFY_MAX_TURNS` (default 200), `MOCKIFY_MAX_BUDGET_USD` (default 5), `MOCKIFY_CAPTURE_HOST_FILTER`, `MOCKIFY_MODEL` (default `claude-opus-4-6`).

`mockify mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server exposing `capture_start`, `capture_finish`, `get_capture_guide`, and the same 13 `browser_*` tools as the built-in agent path — so grok, Codex, Claude Code, or any other MCP-capable agent can drive a capture session directly (register command shown at the top). `capture_start` takes the same `name`/`outputDir` as the CLI; `capture_finish` reports back the name it was saved under:

```
capture_start { "url": "..." } → read get_capture_guide → explore with browser_click/browser_fill/browser_goto/etc. → capture_finish { "summary": "..." }
```

## The traffic.json format

A JSON array of request/response pairs, typed as `CapturedTraffic` in `src/format/types.ts`. Produced by mockify's own recorders and also by specify's capture command — mockify's recorders and mock server were extracted from specify and share this format with it.

```json
{ "url": "https://example.com/api/widgets", "method": "GET", "status": 200, "contentType": "application/json; charset=utf-8", "responseBody": "{\"widgets\":[...]}" }
```

## Fault injection & diagnostics

Set `MOCK_FAULT_RATE` (0–1) to randomly inject failures instead of replaying real responses; `MOCK_FAULT_TYPES` restricts fault types (subset of `302,500,timeout,empty,malformed`; default: all):

```bash
MOCK_FAULT_RATE=0.1 npx mockify replay demo-grok
```

**Diagnostics** (no session cookie required): `GET /` (route index), `GET /_traffic` (raw traffic data), `GET /_faults` (fault config and stats), `GET /_sessions` (active sessions), `GET /_synthetic` (loaded synthetic templates and hit count).

**Advanced env knobs**, layered on top of `replay`/`serve`, not needed for normal use (see `src/mock-server.ts`): `PORT`, `MOCK_DATA_PATH` (overridden by `replay`'s `<name>`/`--port`), `MOCK_AUTH` (opt-in login gate, default off), `MOCK_SESSION_COOKIE_NAME`, `MOCK_SESSION_COOKIE_2_NAME`, `MOCK_SESSION_TTL_MS`, `MOCK_LOGIN_PATH`, `MOCK_POST_LOGIN_REDIRECT`, `MOCK_REFRESH_PATH`, `MOCK_SYNTHETIC` (`0` disables synthetic replay), `MOCKIFY_CAPTURES_DIR` (default `<cwd>/captures`).

## Spec & roadmap

`mockify.spec.yaml` is a starter behavioral spec in specify's v2 format, verifiable with `specify verify --spec mockify.spec.yaml`. Known gaps:

- Header capture and replay (cookies/auth/CORS not currently replayable)
- JSON request-body matching (currently form-encoded only)
- Body matching for PUT/PATCH/DELETE (currently routed through GET matching)
- Latency simulation from `tsStart`/`tsEnd` (captured but unused)
- Sequence-aware/stateful replay

## License

GPL-3.0. See [LICENSE](./LICENSE).
