---
name: port-layer
description: Port one layer (model, evaluation, repository, service, handler, main) of the feature flag service from the Go reference to typescript, python, java or rust, then run the quality gates. Use when asked to port, translate or convert a layer to another language.
---

# Port one layer

Usage: `/port-layer <language> <layer>`

## Before writing code
1. Read, in order: CONVENTIONS.md, spec/business-rules.md, spec/evaluation.md (evaluation and
   service layers), docs/porting/<language>-analysis.md, then the Go source in go/internal/<layer>/.
2. Check that the layers this one depends on already exist in <language>/ and pass their gates.
   If not, stop and say which are missing.
3. For the handler layer: first run the framework experiment from CONVENTIONS.md ("ก่อนเขียน handler:
   ทดลอง framework") and record the table in docs/porting/<language>-analysis.md. Do not write the
   handler from memory of how the framework behaves. If the framework cannot meet the spec, say so
   and propose changing the server or routing yourself; do not bend the spec.

## Write
4. Write idiomatic <language>, not a line-by-line translation. Use only libraries listed in CONVENTIONS.md.
5. Put unit tests beside the code. The evaluation layer must read tests/vectors/*.json and check every row.
   Expected values must not be computed with the logic under test, and every "must be rejected" case
   must be rejected for the one reason it names.
6. Do not modify spec/, tests/contract/ or tests/vectors/.

## Verify
7. Run this layer's gates from the "คำสั่ง gate ต่อภาษา" table in CONVENTIONS.md.
8. If a gate fails, fix the code and rerun. After 3 failed rounds stop and report.
   Never weaken, skip or edit a test to make it pass.
9. Mutation check: once the layer's tests pass, apply 5 or more deliberate bugs to a throw-away copy
   with tools/mutation-check/<script> (one per behaviour: boundary, type comparison, ordering,
   error precedence, resource cleanup) and show the results. A surviving mutation is a missing test:
   add the test, or explain why the mutation changes nothing. Do not hand-wave "equivalent".
   (<script> is ts.sh, py.sh, java.sh or rust.sh; read its header for the usage.)

## Report (always, in this shape)
- Files created or changed
- Gate results (command, pass or fail)
- Behavior differences from the Go reference
- Assumptions made
- Anything in the analysis document that turned out to be wrong
