#!/usr/bin/env bash
# Mutation check for the JavaScript SDK: apply ONE deliberate bug to a throw-away copy of sdk-js/, build it and run the
# tests. If every test still passes, the tests do not protect that behaviour.
#
#   tools/mutation-check/sdk.sh <file under sdk-js/> "<label>" [unit|all] <<'PY'
#   import sys; p = sys.argv[1]; s = open(p).read()
#   a = "const MAX_BATCH = 100"; assert a in s
#   open(p, "w").write(s.replace(a, "const MAX_BATCH = 101"))
#   PY
#
# `unit` (default) runs test/client.test.mjs and test/spec.test.mjs; `all` adds test/integration.test.mjs (it starts
# tools/mock-server). The Python snippet on stdin edits the file whose path it receives as argv[1].
# Results: "killed", "SURVIVED" or "BUILD FAILED" (the mutation does not compile, so it proves nothing).
set -u
file="${1:?file under sdk-js/}"; label="${2:?label}"; scope="${3:-unit}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/sdk-js" "$work/spec" "$work/tools"
cp -r "$repo/sdk-js/src" "$repo/sdk-js/test" "$repo/sdk-js/package.json" "$repo/sdk-js/tsconfig.json" "$repo/sdk-js/build.mjs" "$work/sdk-js/"
ln -s "$repo/sdk-js/node_modules" "$work/sdk-js/node_modules"
cp "$repo/spec/openapi.yaml" "$work/spec/"
ln -s "$repo/tools/mock-server" "$work/tools/mock-server"

python3 - "$work/sdk-js/$file" || { echo "NOT APPLIED  $label"; exit 2; }
cd "$work/sdk-js"
if ! node build.mjs >"$work/build.log" 2>&1; then printf '%-52s BUILD FAILED (not a valid experiment)\n' "$label"; head -3 "$work/build.log"; exit 3; fi
files="test/client.test.mjs test/spec.test.mjs"
[ "$scope" = "all" ] && files="$files test/integration.test.mjs"
output="$(node --test --test-concurrency=1 --test-reporter=spec $files 2>&1)"
# a test that never finishes is "cancelled" by the runner when the process ends: that counts as caught too
failed="$(echo "$output" | awk '/^ℹ (fail|cancelled)/ {n += $3} END {print n + 0}')"
first="$(echo "$output" | grep -E '^\s*✖' | grep -v '^✖' | head -1 | sed -E 's/ \([0-9.]+ms\)//; s/^ *//')"
if [ "${failed:-0}" = "0" ]; then printf '%-52s SURVIVED\n' "$label"; else printf '%-52s killed (%s failing) e.g. %s\n' "$label" "$failed" "$first"; fi
