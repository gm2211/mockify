# assets/infer-demo.tape — mockify demo: an LLM infers a real, stateful mock
# implementation from a capture, graded against traffic it never saw.
# Regenerate with: vhs assets/infer-demo.tape
# (run from the repo root after `npm run build`; requires captures/demo-grok/,
#  a real capture recorded from https://automationintesting.online, and its
#  generated implementation at captures/demo-grok/impl/handlers.mjs — see
#  README "Expansion" section.)

Output assets/infer-demo.gif

Require npx
Require curl
Require jq

Set Shell "bash"
Set FontSize 13
Set Width 1060
Set Height 650
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 26ms
Set PlaybackSpeed 1.0

# 1. Grade the generated implementation: train vs held-out pass rate, the gap
# verdict, and a hardcoding scan (do captured values show up verbatim?).
Type `npx mockify validate demo-grok | sed -n '1,8p;56,60p'`
Enter
Sleep 4200ms

# 2. Prove it's an implementation, not a lookup table: real validation logic
# derived from the recorded 400 responses, not copy-pasted fixtures.
Type `sed -n '207,229p' captures/demo-grok/impl/handlers.mjs`
Enter
Sleep 3800ms

# 3. Replay with all tiers active: implementation first, then recorded,
# then synthetic shapes for anything never observed.
Type `npx mockify replay demo-grok &`
Enter
Sleep 2500ms

# 4. The payoff — statefulness, which no matcher-based mock can do.
Type `curl -s localhost:3456/api/message/count`
Enter
Sleep 2800ms

Type `curl -si -X POST localhost:3456/api/message -H 'Content-Type: application/json' -d '{"name":"Alice Smith","email":"alice@example.com","phone":"07123456789","subject":"Breakfast question","description":"Does the room include breakfast and late checkout?"}'`
Enter
Sleep 3200ms

Type `curl -s localhost:3456/api/message/count`
Enter
Sleep 3200ms

# 5. Bonus: inferred validation on a different endpoint — real field rules
# the model derived from observed error responses, not guessed.
Type `curl -s -X POST localhost:3456/api/booking -d '{}' | jq .`
Enter
Sleep 3000ms

Type `kill %1`
Enter
Sleep 800ms
