#!/usr/bin/env bash
# Mutation check for the Java port: apply ONE deliberate bug to a throw-away copy and run tests.
# If every test still passes, the tests do not protect that behaviour.
#
#   tools/mutation-check/java.sh unit <path under java/> "<label>" <<'PY'
#   import sys; p = sys.argv[1]; s = open(p).read()
#   a = "h *= FNV_PRIME;"; assert a in s
#   open(p, "w").write(s.replace(a, "h = h * FNV_PRIME & 0x7fffffff;"))
#   PY
#
#   tools/mutation-check/java.sh http <path under java/> "<label>" <<'PY' ... PY
#
# The Python snippet on stdin edits the file whose path it receives as argv[1] (use assert so that a
# mutation that no longer applies is reported instead of silently doing nothing).
#   unit  runs `mvn test` (JUnit)
#   http  builds the jar and runs the contract tests (tests/contract) against it
# Needs the dependencies in ~/.m2 (run `mvn -q -DskipTests package` once in java/ first).
#
# Results: "killed" (a test failed: good), "SURVIVED" (nothing noticed: a gap in the tests) or
# "BUILD FAILED" (the mutation does not compile, so it proves nothing).
set -u
mode="${1:?mode: unit or http}"; file="${2:?path under java/}"; label="${3:?label}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/java"
cp -r "$repo/java/src" "$repo/java/pom.xml" "$repo/java/checkstyle.xml" "$work/java/"
ln -s "$repo/tests" "$work/tests" # tests read ../tests/vectors relative to java/

python3 - "$work/java/$file" || { echo "NOT APPLIED  $label"; exit 2; }
cd "$work/java"

if [ "$mode" = "unit" ]; then
  output="$(mvn -o test 2>&1 | grep -v 'Picked up')"
  if echo "$output" | grep -q 'COMPILATION ERROR'; then printf '%-52s BUILD FAILED (not a valid experiment)\n' "$label"; exit 3; fi
  failed="$(echo "$output" | grep -E '^\[(ERROR|WARNING)\] Tests run:' | tail -1 | sed -E 's/.*Failures: ([0-9]+), Errors: ([0-9]+).*/\1 \2/' | awk '{print $1+$2}')"
  first="$(echo "$output" | grep -E '^\[ERROR\]   ' | head -1 | cut -c1-110)"
else
  if ! mvn -o -q -DskipTests package >"$work/build.log" 2>&1; then
    printf '%-52s BUILD FAILED (not a valid experiment)\n' "$label"; grep -E 'ERROR' "$work/build.log" | head -3; exit 3
  fi
  port=$((8400 + RANDOM % 500))
  ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=$port DB_PATH="$work/mutant.db" exec java -jar target/ffservice.jar >/dev/null 2>&1 &
  pid=$!
  for _ in $(seq 1 40); do curl -s "localhost:$port/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
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
