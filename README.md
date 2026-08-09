# mockify

Record HTTP traffic from a live web app, then replay it as a local mock server — no live backend required.

![mockify demo: logging in, replaying a captured route, and a 404 with route hints](assets/demo.gif)

## Quickstart

```bash
npm install && npm run build

# Record traffic from a live site — a Claude agent drives a real browser and
# explores the app for you (needs an Anthropic API key or a logged-in Claude
# Code session; see "Agent capture" below)
npx mockify capture --url https://app.example.com

# Prefer to click around yourself? --manual opens a visible Chromium window
# for you to drive (Ctrl+C to save) — no agent, no API key needed
npx mockify capture --url https://app.example.com --manual

# Serve the capture back as a mock server
npx mockify serve --data captures/2024-01-01_12-00-00 --port 3456
```

If `--data` is omitted, the server searches `<cwd>/captures/` for a `traffic.json` (most recent timestamped subdirectory wins). `--data` accepts either a `traffic.json` file directly or a capture directory containing one. During development, run `npm run serve -- --data <path>` to use `tsx` directly instead of building first.

## Agent capture

`mockify capture --url <url>` is agent-driven by default: a Claude agent (`src/agent/runner.ts`) drives a real Chromium browser, surveying the app's pages and then exercising its list/detail/create/update/delete flows, pagination, filters, and error states — so the recorded traffic can power a faithful mock server. Traffic, console logs, and screenshots are recorded automatically as the agent explores; see `src/agent/prompts.ts` for the exact exploration strategy it follows.

**Authentication**: the underlying Claude Agent SDK authenticates with, in order of what's available, `ANTHROPIC_API_KEY`, a `CLAUDE_CODE_OAUTH_TOKEN` (mint one with `claude setup-token`), or an ambient Claude Code login already on this machine (`claude login`) — no environment variable is required if you're already logged in to Claude Code. If none of these are usable, the run fails with a message naming all three options.

**Options**: `--output <dir>` (default `captures/<ISO-timestamp>`), `--headed` (show the browser instead of running headless), `--storage-state <path|keychain:name>` / `--save-storage-state <path|keychain:name>` (start authenticated from, or persist, cookies + localStorage), `--timeout <seconds>` (wall-clock budget for the run).

**Manual fallback**: `--manual` skips the agent entirely and opens a visible Chromium window for you to drive by hand instead — no API key needed. This is the original recorder flow (`src/recorders/browse-and-capture.mjs`), kept unchanged.

Environment variables:
- `MOCKIFY_MAX_TURNS` — max agent turns per run (default: 200)
- `MOCKIFY_MAX_BUDGET_USD` — max spend per run in USD (default: 5)
- `MOCKIFY_CAPTURE_HOST_FILTER` — comma-separated extra domains to capture traffic from beyond the target's own registrable domain, or `*` to disable host filtering entirely
- `MOCKIFY_MODEL` — override the agent model (default: `claude-opus-4-6`)

## Drive it with any agent (MCP)

`mockify mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server exposing `capture_start`, `capture_finish`, `get_capture_guide`, and the same 13 `browser_*` tools as the built-in agent path — so grok, Codex, Claude Code, or any other MCP-capable agent can drive a capture session directly, with every action recorded exactly like the Claude Agent SDK path above.

Register it with grok (verified against `grok mcp --help`):

```bash
grok mcp add mockify -- node /path/to/mockify/dist/cli.js mcp
```

(point at your built `dist/cli.js` — an absolute path works from any cwd; run `npm run build` first). Then, in your grok session:

```
capture_start { "url": "https://app.example.com" }
→ read get_capture_guide, explore with browser_click/browser_fill/browser_goto/etc.
→ capture_finish { "summary": "..." }
```

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

## License

GPL-3.0. See [LICENSE](./LICENSE).
