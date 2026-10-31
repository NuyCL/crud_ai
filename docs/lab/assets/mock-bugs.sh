#!/usr/bin/env bash
# รัน contract test กับ mock server ที่ใส่ bug ทีละชนิด แล้วสรุปจำนวนที่ล้ม
#   docs/lab/assets/mock-bugs.sh [bug ...]      (ไม่ใส่ = ทุกชนิด)  รันจาก root ของรีโป
# ใช้พอร์ต 8081 ปิดเฉพาะ PID ที่เปิดเอง ไม่ใช้ pkill
set -u
bugs=("$@")
if [ ${#bugs[@]} -eq 0 ]; then
  bugs=(none utf16-description no-audit-on-delete put-merges exposure-last-wins weights-not-checked client-gets-401 offset-ignored cors-everywhere cors-no-vary)
fi
repo="$(pwd)"
work="$(mktemp -d)"
export CORS_ORIGINS="https://app.example.com,https://b.example.com"
for bug in "${bugs[@]}"; do
  mb="$bug"; [ "$bug" = none ] && mb=""
  ( cd "$work" && PORT=8081 MOCK_BUG="$mb" exec node "$repo/tools/mock-server/server.mjs" ) >"$work/mock.log" 2>&1 &
  pid=$!
  for _ in $(seq 50); do curl -sf localhost:8081/healthz >/dev/null && break; sleep 0.2; done
  if ! curl -sf localhost:8081/healthz >/dev/null; then echo "mock ไม่ตอบ /healthz (bug=$bug)"; kill "$pid" 2>/dev/null; continue; fi
  out="$(BASE_URL=http://localhost:8081 node --test --test-concurrency=1 --test-reporter=spec "tests/contract/*.test.mjs" 2>&1)"
  kill "$pid"; wait "$pid" 2>/dev/null
  pass="$(echo "$out" | awk '/^ℹ pass/ {print $3}')"; fail="$(echo "$out" | awk '/^ℹ fail/ {print $3}')"
  first="$(echo "$out" | grep -E '^\s{2,}✖' | sed -E 's/ \([0-9.]+ms\)//; s/^ +//' | head -1 | cut -c1-70)"
  printf '%-20s pass=%-4s fail=%-3s %s\n' "$bug" "$pass" "$fail" "$first"
done
rm -rf "$work"
