# A real generated implementation

This directory is **output, not source** — a verbatim copy of what
`mockify infer demo-grok` produced from a capture of
[automationintesting.online](https://automationintesting.online), kept here so
you can read a real result without running the generator yourself.

The capture held 152 recorded request/response pairs across 21 endpoint
templates. The generator saw 122 of them; the other 30 were held out and shown
only to the grader.

| Measure | Result |
|---|---|
| Train pass rate | 100% (122/122) |
| Held-out pass rate | 97% (29/30) |
| Train → holdout gap | 3pp (flagged above 25pp) |
| Rounds used | 2 |
| Model | claude-sonnet-5 |

`handlers.mjs` is not a lookup table. It seeds an in-memory store, routes by
method and path, mutates state on writes, and implements the validation rules
that were only ever visible as error responses in the capture — so posting a
message raises `GET /api/message/count`, and posting an empty booking returns
the real field errors because it measures the fields, not because it memorised
that response.

The literal strings in the seed data are why the static hardcoding scan reports
a high ratio here (0.97). That signal alone cannot separate "seeded a store with
observed data" (wanted) from "memorised the answers" (not wanted) — the held-out
gap is what distinguishes them, and at 3pp this one generalises.

Regenerate with:

```bash
mockify infer demo-grok
mockify validate demo-grok
```
