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

## Write
3. Write idiomatic <language>, not a line-by-line translation. Use only libraries listed in CONVENTIONS.md.
4. Put unit tests beside the code. The evaluation layer must read tests/vectors/*.json and check every row.
5. Do not modify spec/, tests/contract/ or tests/vectors/.

## Verify
6. Run this layer's gates from the "คำสั่ง gate ต่อภาษา" table in CONVENTIONS.md.
7. If a gate fails, fix the code and rerun. After 3 failed rounds stop and report.
   Never weaken, skip or edit a test to make it pass.

## Report (always, in this shape)
- Files created or changed
- Gate results (command, pass or fail)
- Behavior differences from the Go reference
- Assumptions made
- Anything in the analysis document that turned out to be wrong
