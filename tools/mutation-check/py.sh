#!/usr/bin/env bash
# Mutation check for the Python port: apply ONE deliberate bug to a throw-away copy and run tests.
# If every test still passes, the tests do not protect that behaviour.
#
#   tools/mutation-check/py.sh unit <file under python/> "<label>" <<'PY'
#   import sys; p = sys.argv[1]; s = open(p).read()
#   a = "& 0xFFFFFFFF"; assert a in s
#   open(p, "w").write(s.replace(a, ""))
#   PY
#
#   tools/mutation-check/py.sh http <file under python/> "<label>" <<'PY' ... PY
#
# The Python snippet on stdin edits the file whose path it receives as argv[1] (use assert so that a
# mutation that no longer applies is reported instead of silently doing nothing).
#   unit  runs pytest
#   http  starts the mutated service and runs the contract tests (tests/contract) against it
# Needs python/.venv with the dev dependencies (see python/README.md).
#
# Results: "killed" (a test failed: good) or "SURVIVED" (nothing noticed: a gap in the tests).
set -u
mode="${1:?mode: unit or http}"; file="${2:?file under python/}"; label="${3:?label}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/python"
cp -r "$repo/python/app" "$repo/python/tests" "$repo/python/pyproject.toml" "$work/python/"
ln -s "$repo/tests" "$work/tests" # tests read ../tests/vectors relative to python/

python3 - "$work/python/$file" || { echo "NOT APPLIED  $label"; exit 2; }
cd "$work/python"
py="$repo/python/.venv/bin/python"

if [ "$mode" = "unit" ]; then
  output="$("$py" -m pytest -p no:cacheprovider 2>&1 | tr -d "\000")"
  failed="$(echo "$output" | grep -Eo '[0-9]+ failed' | head -1 | cut -d' ' -f1)"
  first="$(echo "$output" | grep -E '^FAILED' | head -1 | cut -c1-90)"
else
  port=$((8400 + RANDOM % 500))
  ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=$port DB_PATH="$work/mutant.db" "$py" -m app.main >/dev/null 2>&1 &
  pid=$!
  sleep 2
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
