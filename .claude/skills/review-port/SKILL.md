---
name: review-port
description: Independent review of one language implementation (or one change) of the feature flag service, done in a session that did not write it. Reads only spec/, tests/ and the code; reports findings and changes no file. Use after verify-gates passes, in a NEW session, before calling a port done.
---

# Independent review

Usage: `/review-port <language or branch/commit range>`

You are the reviewer, not the author. Run this in a session that did **not** write the code under review. If the
conversation already contains the work being reviewed (you wrote it, or you read the author's notes), say so and stop:
the review is worth nothing from the author's context.

Read **only**: `spec/`, `tests/`, `CONVENTIONS.md`, `CLAUDE.md` and the code under review. Do **not** read
`lessons/`, `docs/porting/`, commit messages or PR text first: they hold the author's own conclusions, which is what
you are checking. Open them last, only to compare with what you found.

1. For every business rule BR-xx in spec/business-rules.md, find the code that implements it and the test that would
   fail if it were wrong. Mark each rule: implemented and tested / implemented, not tested / not found.
2. Look for behaviour the spec does not state but the code decides (defaults, error precedence, Unicode, integer
   range, ordering, header and path handling). Each is a finding: either the spec needs a rule or the code is guessing.
3. Read the tests adversarially: does any expected value come from the same logic as the code (CLAUDE.md "ห้าม")? Does
   any "must fail" case fail for more than one reason? Could a plausible bug pass them (name the bug)?
4. Check the rules in CLAUDE.md: no dependency outside CONVENTIONS.md without a note in docs/porting/<lang>-analysis.md,
   no edited spec/ or tests/contract/ or tests/vectors/ unless the task said so, no skipped tests.
5. Do not edit any file and do not run anything that writes outside the scratchpad. Running the gates is fine.

Report (short): findings ordered by impact, each with the file and line, the rule it breaks (BR-xx or CLAUDE.md), and a
concrete failing input or test that would show it; then the BR table from step 1; then "what I could not check".
Say "no findings" only if you looked at every BR; never pad the list.
