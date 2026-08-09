# assets/demo.tape — mockify replay demo, recorded against a real agent capture
# Regenerate with: vhs assets/demo.tape
# (run from the repo root after `npm run build`; requires captures/demo-grok/,
#  a real capture recorded by grok exploring https://automationintesting.online
#  via `mockify mcp` — see README "Drive it with any agent" section)

Output assets/demo.gif

Require curl
Require jq

Set Shell "bash"
Set FontSize 15
Set Width 980
Set Height 560
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 28ms
Set PlaybackSpeed 1.0

# Start the mock server against the real grok capture (152 traffic entries,
# recorded live from automationintesting.online) — output prints to this
# same terminal so the real startup log is visible, not staged.
Type `PORT=4173 MOCK_DATA_PATH=captures/demo-grok node dist/mock-server.js &`
Enter
Sleep 1500ms

# 1. Replay a real captured room listing.
Type `curl -s localhost:4173/api/room | jq '.rooms[0]'`
Enter
Sleep 2500ms

# 2. Replay the real validation-error response the site returned for an
# empty booking submission.
Type `curl -s -X POST localhost:4173/api/booking -d '{}' | jq .`
Enter
Sleep 2500ms

# 3. Hit an unknown route — 404 with a hint toward known routes.
Type `curl -s localhost:4173/api/widgets | jq .`
Enter
Sleep 2500ms

Type `kill %1`
Enter
Sleep 800ms
