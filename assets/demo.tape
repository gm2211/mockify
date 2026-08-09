# assets/demo.tape — mockify demo: capture artifacts, expansion, and replay
# Regenerate with: vhs assets/demo.tape
# (run from the repo root after `npm run build`; requires captures/demo-grok/,
#  a real capture recorded by grok exploring https://automationintesting.online
#  via `mockify mcp` — see README "Capture" section)

Output assets/demo.gif

Require npx
Require curl
Require jq

Set Shell "bash"
Set FontSize 14
Set Width 980
Set Height 640
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 26ms
Set PlaybackSpeed 1.0

# 1. A saved capture, by name.
Type `npx mockify list`
Enter
Sleep 2000ms

# 2. What that capture produced on disk.
Type `find captures/demo-grok -maxdepth 2 -not -path '*screenshots/*' -not -path '*observations/*' | sort`
Enter
Sleep 2500ms

Type `ls captures/demo-grok/screenshots | wc -l`
Enter
Sleep 1800ms

# 3. What expansion inferred beyond the literal capture: endpoint templates.
Type `jq -r '.templates[] | select(.paramNames | length > 0) | .method + " " + .pathTemplate' captures/demo-grok/synthetic/index.json`
Enter
Sleep 2800ms

# 4. Replay — clean, no env vars. (Filter out the server's own per-route
# request logging so only the startup banner shows here; it's real output,
# just not interleaved with the curls below.)
Type `npx mockify replay demo-grok 2>&1 | grep -v '^\[mock\]' &`
Enter
Sleep 2500ms

# 5. Recorded vs. synthesized, side by side.
Type `curl -s localhost:3456/api/room/1 | jq -c '{roomid, roomName, roomPrice}'`
Enter
Sleep 2200ms

Type `curl -si localhost:3456/api/room/7 | grep -i x-mockify-synthetic`
Enter
Sleep 2000ms

Type `curl -s localhost:3456/api/room/7 | jq -c '{roomid, roomName, roomPrice}'`
Enter
Sleep 2800ms

Type `kill %1`
Enter
Sleep 800ms
