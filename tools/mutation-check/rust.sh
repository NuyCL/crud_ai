#!/usr/bin/env bash
# Mutation check for the Rust port: apply ONE deliberate bug to a throw-away copy and run tests.
# If every test still passes, the tests do not protect that behaviour.
#
#   tools/mutation-check/rust.sh unit <file under rust/> "<label>" <<'PY'
#   import sys; p = sys.argv[1]; s = open(p).read()
#   a = "h.wrapping_mul(FNV_PRIME)"; assert a in s
#   open(p, "w").write(s.replace(a, "h ^ FNV_PRIME"))
#   PY
#
#   tools/mutation-check/rust.sh http <file under rust/> "<label>" <<'PY' ... PY
#
# The Python snippet on stdin edits the file whose path it receives as argv[1] (use assert so that a
# mutation that no longer applies is reported instead of silently doing nothing).
#   unit  runs `cargo test` (unit tests, tests/vectors.rs and tests/http.rs)
#   http  builds the binary and runs the contract tests (tests/contract) against it
# Dependencies are compiled once into rust/target-mut and reused by every mutant.
#
# Results: "killed" (a test failed: good), "SURVIVED" (nothing noticed: a gap in the tests) or
# "BUILD FAILED" (the mutation does not compile, so it proves nothing).
set -u
mode="${1:?mode: unit or http}"; file="${2:?file under rust/}"; label="${3:?label}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/rust"
cp -r "$repo/rust/src" "$repo/rust/tests" "$repo/rust/Cargo.toml" "$repo/rust/Cargo.lock" "$repo/rust/rustfmt.toml" "$work/rust/"
ln -s "$repo/tests" "$work/tests" # tests read ../tests/vectors relative to rust/
export CARGO_TARGET_DIR="$repo/rust/target-mut"

python3 - "$work/rust/$file" || { echo "NOT APPLIED  $label"; exit 2; }
cd "$work/rust"

if [ "$mode" = "unit" ]; then
  output="$(cargo test --quiet 2>&1)"
  if echo "$output" | grep -q 'could not compile'; then printf '%-52s BUILD FAILED (not a valid experiment)\n' "$label"; echo "$output" | grep -m2 '^error'; exit 3; fi
  failed="$(echo "$output" | grep -E '^test result: FAILED' | wc -l)"
  [ "$failed" = "0" ] && failed=0 || failed="$(echo "$output" | grep -Eo '[0-9]+ failed' | awk '{s+=$1} END {print s}')"
  first="$(echo "$output" | grep -E '^---- ' | head -1 | cut -c1-110)"
else
  if ! cargo build --quiet >"$work/build.log" 2>&1; then
    printf '%-52s BUILD FAILED (not a valid experiment)\n' "$label"; grep -m2 '^error' "$work/build.log"; exit 3
  fi
  port=$((8400 + RANDOM % 500))
  ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=$port DB_PATH="$work/mutant.db" "$CARGO_TARGET_DIR/debug/ffservice" >/dev/null 2>&1 &
  pid=$!
  for _ in $(seq 1 40); do curl -s "localhost:$port/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
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
