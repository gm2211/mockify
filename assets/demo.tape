# assets/demo.tape — mockify terminal demo
# Regenerate with: vhs assets/demo.tape
# (run from the repo root; requires the project's own node_modules)

Output assets/demo.gif

Require curl

Set Shell "bash"
Set FontSize 15
Set Width 980
Set Height 560
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 35ms
Set PlaybackSpeed 1.0

# Start the mock server against the repo's fixture capture, off-camera.
Hide
Type "PORT=3456 npx tsx src/cli.ts serve --data test/fixtures/captures/traffic.json > /tmp/mockify-demo.log 2>&1 & sleep 2 && clear"
Enter
Sleep 3s
Show

# 1. Log in — any non-empty username/password creates a session.
Type `curl -i -X POST localhost:3456/login -d "username=demo&password=demo" -c /tmp/mockify-demo-cookies.txt`
Enter
Sleep 3s

# 2. Replay a captured route using the session cookie.
Type `curl -s -b /tmp/mockify-demo-cookies.txt localhost:3456/api/widgets`
Enter
Sleep 2500ms

# 3. Hit an unknown route — 404 with a hint toward similar known routes.
Type `curl -i -s -b /tmp/mockify-demo-cookies.txt localhost:3456/api/widgets/999`
Enter
Sleep 3500ms

Hide
Type "kill %1 2>/dev/null; rm -f /tmp/mockify-demo-cookies.txt"
Enter
Show
