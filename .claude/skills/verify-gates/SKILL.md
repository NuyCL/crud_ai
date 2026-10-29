---
name: verify-gates
description: Run every quality gate (build, lint, unit tests, contract tests, differential test, mutation check) for one language implementation of the feature flag service and summarise the result by business rule. Use before committing a port or when asked whether a language implementation is done.
---

# Verify all gates

Usage: `/verify-gates <language>`

1. Read the "คำสั่ง gate ต่อภาษา" table in CONVENTIONS.md for <language>.
2. Run build, lint and unit tests in that order. Stop at the first failing gate and report it.
3. Start the service with ADMIN_KEY=test-admin-key, CLIENT_KEY=test-client-key, PORT=8080 and a fresh
   temporary DB_PATH. Remember the PID of the process you started.
4. Run: node --test --test-concurrency=1 "tests/contract/*.test.mjs"
5. Stop only the process you started, using its PID. Never use pkill or killall.
6. Then, still without changing any file:
   - Differential test: start Go (reference) and this language on two ports with fresh databases and
     run `node tools/diff-servers/diff.mjs <urlA> <urlB> --seed=N --requests=3000` for at least 3 seeds;
     report the number of differing responses.
   - Mutation check: run tools/mutation-check/<language>.sh with at least 5 mutations covering
     boundaries, type comparison, error precedence and transactions; report killed and survived.
7. Report a table of gate and result (build, lint, unit, contract, differential, mutation). Group contract failures by the BR-xx in the test name.
   For each failure or surviving mutation say whether you think the fault is in the code, the test or
   the spec, with evidence.
8. Do not change any file.
