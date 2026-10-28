#!/usr/bin/env bash
# Mutation check for the TypeScript port: apply ONE deliberate bug to a throw-away copy, build it and
# run tests. If every test still passes, the tests do not protect that behaviour.
#
#   tools/mutation-check/ts.sh unit <file under typescript/src> "<label>" <<'PY'
#   import sys; p = sys.argv[1]; s = open(p).read()
#   a = "Math.imul(h, 0x01000193) >>> 0"; assert a in s
#   open(p, "w").write(s.replace(a, "(h * 0x01000193) >>> 0"))
#   PY
#
#   tools/mutation-check/ts.sh http <file under typescript/src> "<label>" <<'PY' ... PY
#
# The Python snippet on stdin edits the file whose path it receives as argv[1] (use assert so that a
# mutation that no longer applies is reported instead of silently doing nothing).
#   unit  runs the unit tests (node --test on the compiled *.test.js files)
#   http  starts the mutated service and runs the contract tests (tests/contract) against it
#
# Results: "killed" (a test failed: good), "SURVIVED" (nothing noticed: a gap in the tests), or
# "BUILD FAILED" (the mutation does not compile, so it proves nothing: change it so it still builds).
set -u
mode="${1:?mode: unit or http}"; file="${2:?file under typescript/src}"; label="${3:?label}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/typescript"
cp -r "$repo/typescript/src" "$repo/typescript/package.json" "$repo/typescript/tsconfig.json" "$work/typescript/"
ln -s "$repo/typescript/node_modules" "$work/typescript/node_modules"
ln -s "$repo/tests" "$work/tests" # unit tests read ../tests/vectors relative to the compiled files

python3 - "$work/typescript/src/$file" || { echo "NOT APPLIED  $label"; exit 2; }
cd "$work/typescript"
if ! npx tsc -p tsconfig.json >"$work/build.log" 2>&1; then
  printf '%-52s BUILD FAILED (not a valid experiment)\n' "$label"; head -3 "$work/build.log"; exit 3
fi

if [ "$mode" = "unit" ]; then
  output="$(node --test "dist/**/*.test.js" 2>&1)"
  failed="$(echo "$output" | awk '/^# fail/ {print $3}')"
  first="$(echo "$output" | grep -E '^\s*not ok' | head -1 | sed -E 's/^ *not ok [0-9]+ - //')"
else
  port=$((8400 + RANDOM % 500))
  ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=$port DB_PATH="$work/mutant.db" node dist/server.js >/dev/null 2>&1 &
  pid=$!
  sleep 1.5
  cd "$repo"
  output="$(BASE_URL=http://localhost:$port node --test --test-concurrency=1 --test-reporter=spec "tests/contract/*.test.mjs" 2>&1)"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  failed="$(echo "$output" | awk '/^ℹ fail/ {print $3}')"
  first="$(echo "$output" | grep -E '^\s*✖' | grep -v '^✖' | head -1 | sed -E 's/ \([0-9.]+ms\)//; s/^ *//')"
fi

if [ "${failed:-0}" = "0" ]; then
  printf '%-52s SURVIVED\n' "$label"
else
  printf '%-52s killed (%s failing) e.g. %s\n' "$label" "$failed" "$first"
fi
