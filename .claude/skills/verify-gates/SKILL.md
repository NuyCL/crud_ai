---
name: verify-gates
description: Run every quality gate (build, lint, unit tests, contract tests) for one language implementation of the feature flag service and summarise the result by business rule. Use before committing a port or when asked whether a language implementation is done.
---

# Verify all gates

Usage: `/verify-gates <language>`

1. Read the "คำสั่ง gate ต่อภาษา" table in CONVENTIONS.md for <language>.
2. Run build, lint and unit tests in that order. Stop at the first failing gate and report it.
3. Start the service with ADMIN_KEY=test-admin-key, CLIENT_KEY=test-client-key, PORT=8080 and a fresh
   temporary DB_PATH. Remember the PID of the process you started.
4. Run: node --test --test-concurrency=1 "tests/contract/*.test.mjs"
5. Stop only the process you started, using its PID. Never use pkill or killall.
6. Report a table of gate and result. Group contract failures by the BR-xx in the test name.
   For each failure say whether you think the fault is in the code, the test or the spec, with evidence.
7. Do not change any file.
