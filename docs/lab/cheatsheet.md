# Cheat sheet: ค่าและ prompt ทั้งหมดของแลบ

รวมทุกอย่างที่ต้องพิมพ์หรือวางไว้หน้าเดียว คัดลอกจากแต่ละ module โดยตรง (ตรวจแล้วว่าข้อความ prompt ตรงกับใน module) ค่าใช้จ่าย: 0 บาท, รันในเครื่อง · [กลับไป README](README.md)

> สถานะ: คำสั่งและค่าทั้งหมดในส่วน 1-4 รันจริงแล้ว (ดูตารางใน README) ส่วน prompt ในส่วน 5 **ยังไม่ได้ทดสอบกับ AI จริง** (เขียนจาก skill ใน `.claude/skills/` และบทเรียนใน `lessons/`)

## 1. ตัวแปรและพอร์ต

```bash
export REPO="$(pwd)" LAB="$(mktemp -d)"
```

| รายการ | ค่า |
|---|---|
| Go (contract) | `8080` · TypeScript `8082` · Python `8083` · Go อ้างอิง differential `8084`, `8086`, `8087` · mock `8081` (module 03), `8085` (module 06) · แอปทดลอง FastAPI `8090` · หน้าเว็บ `9001` |
| Header | `X-Admin-Key: test-admin-key` · `X-Client-Key: test-client-key` |
| `CORS_ORIGINS` | contract: `https://app.example.com,https://b.example.com` (390 ข้อ) · `*` (388) · ไม่ตั้ง (378) · เบราว์เซอร์: `http://localhost:9001` |
| Env ของ service | `ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=<พอร์ต> DB_PATH=<ไฟล์ใต้ $LAB> [CORS_ORIGINS=<ค่า>]` |
| Flag key | `lab-basic` (on/off), `new-checkout` (A/B), `checkout-button`, `rollout-flag`, `a` (ใช้โดย probe.sh) |
| User id | `u1` (rollout 7145, variant 7181 → green) · `u2` (variant 4324 → blue) · `u3` (variant 1943 → blue) · `v-50920`, `edge-5516` (จาก vectors) |

## 2. เปิด/ปิด server (รูปแบบเดียวที่ถูก)

```bash
( cd "$LAB/run" && ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH="$LAB/run/flags.db" exec "$LAB/ffservice" ) &
```

```bash
GO_PID=$!
```

```bash
until curl -sf localhost:8080/healthz; do sleep 0.3; done
```

```bash
kill "$GO_PID"
```

```bash
ps -o pid,args -p "$GO_PID" || echo "ไม่มีโปรเซส (ถูกต้อง)"
```

ห้าม: `cd x && cmd &` · `pkill` · `killall` · ตรวจด้วย `ss`

## 3. Body ตัวอย่าง (ทดสอบแล้วกับ Go)

| ใช้ทำอะไร | Body |
|---|---|
| สร้าง flag on/off (`POST /v1/flags`, admin) | `{"key":"lab-basic","enabled":true,"description":"my first flag"}` |
| สร้าง flag A/B | `{"key":"new-checkout","enabled":true,"description":"lab flag","rolloutPercent":80,"variants":[{"key":"blue","weight":50},{"key":"green","weight":50}],"rules":[{"attribute":"country","operator":"eq","value":"TH"}]}` |
| แก้ flag (`PUT /v1/flags/new-checkout`, ต้องมี `key`) | `{"key":"new-checkout","enabled":true,"rolloutPercent":70,"variants":[{"key":"blue","weight":50},{"key":"green","weight":50}],"rules":[]}` |
| Evaluate (`POST /v1/evaluate`, client) | `{"flags":["new-checkout","no-such-flag"],"context":{"userId":"u1","attributes":{"country":"TH"}}}` |
| Events (`POST /v1/events`, client) | `{"events":[{"type":"exposure","flagKey":"new-checkout","userId":"u1","variant":"green","timestamp":"2026-10-31T10:00:00Z"},{"type":"conversion","goal":"purchase","userId":"u1","timestamp":"2026-10-31T10:01:00Z"}]}` |
| รายงาน | `GET /v1/flags/new-checkout/results?goal=purchase` (admin) |

## 4. Vectors และคำตอบที่ตรวจแล้ว

| input ที่ hash | hash | bucket |
|---|---|---|
| `""` | 2166136261 | 6261 |
| `a` | 3826002220 | 2220 |
| `foobar` | 3214735720 | 5720 |
| `new-checkout:rollout:alice` | 3449471093 | 1093 |
| `new-checkout:rollout:ผู้ใช้-1` | 1899751408 | 1408 |
| `rollout-flag:rollout:edge-5516` | 1394700999 | 999 |
| `checkout-button:variant:v-50920` | 1061645000 | 5000 |
| `new-checkout:rollout:u1` | 2091417145 | 7145 |
| `new-checkout:variant:u1` | 3245987181 | 7181 |
| `new-checkout:variant:u2` | 3195654324 | 4324 |
| `new-checkout:variant:u3` | 3212431943 | 1943 |

| คำสั่งหลัก | ผลที่ต้องได้ |
|---|---|
| `node tools/verify-vectors/verify.mjs` | `fnv1a32: 11, bucketing: 300, evaluation: 65, failures: 0` |
| `CORS_ORIGINS="https://app.example.com,https://b.example.com" node --test --test-concurrency=1 "tests/contract/*.test.mjs"` (กับ server ที่ตั้งค่าเดียวกัน) | `# tests 390`, `# pass 390`, `# fail 0` |
| `docs/lab/assets/mock-bugs.sh` | 9 bug ถูกจับทั้งหมด (fail ตั้งแต่ 1 ถึง 9 ข้อ) |
| `node tools/diff-servers/diff.mjs http://localhost:8084 http://localhost:8082` (DB ว่างทั้งคู่) | `0 differing responses` |
| `( cd tools/browser-check && SVC_URL=http://localhost:8080 EXPECT=allowed npm run check )` | `ok: EXPECT=allowed isEnabled=true ...` |
| `( cd typescript && npm test )` | 176 ผ่าน |
| `( cd python && .venv/bin/pytest -q )` | 347 ผ่าน |

## 5. Prompt ทั้งหมด

ค่าในวงเล็บเหลี่ยม `[...]` ให้แทนด้วยค่าของคุณ แต่ละ prompt มี "ทำไมได้ผล", รายการตรวจ และ "ถ้า AI ตอบผิด" ใน module ที่ระบุ

### 5.1 อ่านสเปกแบบ implementer ([Module 01](01-spec-and-vectors.md)) — skill `spec-ambiguity-check`

```text
อ่านทุกไฟล์ใน spec/ ในฐานะ developer ที่ต้อง implement เป็น [TypeScript] และถามใครไม่ได้
รายการจุดที่ตีความได้มากกว่าหนึ่งแบบ (ทุกจุด ไม่ใช่แค่ 5 อันดับแรก) เรียงตามผลกระทบ
แต่ละจุดให้ระบุ: ข้อความที่กำกวม (ไฟล์และ BR), ความหมายที่แข่งกัน, คำตอบที่แนะนำ, และ test case เดียวที่ตัดสินได้
ต้องเช็คเรื่องเหล่านี้เสมอ: integer overflow, Unicode, missing/null/0, การเทียบชนิด, ลำดับ, ค่า default, ลำดับของ error
และเรื่องที่พลาดในทุกภาษาที่ผ่านมา: path ที่เข้ารหัส (%2F, %FF, %00, %zz, ;) framework ถอดรหัสก่อน routing หรือไม่,
method/path ที่ถือเป็น unknown route (OPTIONS, TRACE, HEAD, /error, /docs) และ body ของมัน,
request body (encoding อื่นนอกจาก UTF-8, BOM, NaN/Infinity, lone surrogate, key ซ้ำ, ซ้อนลึก, เลขยาว), header ที่ไม่ใช่ ASCII
ห้ามแก้ไฟล์ใดๆ ตอบเป็นรายการอย่างเดียว
```

### 5.2 รัน gate และสรุปตาม BR ([Module 02](02-run-go-contract.md)) — skill `verify-gates`

```text
ทำตามนี้ตามลำดับและห้ามแก้ไฟล์ใดๆ:
1. อ่านตาราง "คำสั่ง gate ต่อภาษา" ใน CONVENTIONS.md แถว Go
2. รัน build, lint, unit test ตามลำดับ หยุดทันทีที่ gate ใดล้มและรายงาน
3. เปิด service ด้วย ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH เป็นไฟล์ชั่วคราวใหม่
   และ CORS_ORIGINS=https://app.example.com,https://b.example.com เปิดด้วย ( cd dir && exec คำสั่ง ) & เก็บ $! รอ /healthz ตอบ
4. รัน node --test --test-concurrency=1 "tests/contract/*.test.mjs"
5. ปิดเฉพาะโปรเซสที่คุณเปิด ด้วย PID (ห้าม pkill/killall) แล้วตรวจด้วย ps ว่าไม่มีโปรเซสค้าง
6. รายงานตาราง gate กับผล (build, lint, unit, contract) และจัดกลุ่มข้อที่ล้มตาม BR-xx ในชื่อ test
   ทุกข้อที่ล้ม ให้บอกว่าคุณคิดว่าผิดที่โค้ด, test หรือสเปก พร้อมหลักฐาน
```

### 5.3 เขียน test ตามกติกา CLAUDE.md และวัดด้วย mutation ([Module 03](03-break-it.md))

```text
เพิ่ม unit test สำหรับ [BR-31 และ BR-33: ผลรวม weight ของ variants ต้องเท่ากับ 100 และมีได้ 2-10 variants] ใน [typescript/src/service/]
กติกา (CLAUDE.md):
- ห้ามแก้ spec/, tests/contract/, tests/vectors/ และห้ามข้าม ปิด หรือแก้ test เดิมเพื่อให้ผ่าน
- ห้ามให้ test คำนวณคำตอบที่คาดด้วยตรรกะเดียวกับโค้ดที่ทดสอบ: เขียนค่าที่คาดเป็นค่าตายตัวที่คุณคำนวณด้วยมือหรือมาจาก spec
- กรณี "ต้องล้ม" ต้องล้มด้วยเหตุผลเดียวที่ตั้งใจ เช่น ทดสอบ "เกิน 10 variants" ด้วย 11 variants น้ำหนักรวม 100 (ไม่ใช่ 101)
  และทดสอบ "ผลรวมไม่เท่า 100" ด้วยจำนวน variants ที่ไม่เกินกำหนด
- ทุก test ตั้งชื่อให้บอกพฤติกรรมและ BR ที่ปกป้อง
หลังเขียนเสร็จ: ให้ทำ mutation 3 ข้อกับสำเนาชั่วคราวด้วย tools/mutation-check/ts.sh (ขอบเขต, ชนิด, ลำดับ error)
รายงานผล killed/SURVIVED ของแต่ละข้อ ถ้า SURVIVED ให้เพิ่ม test แล้วรันซ้ำ ห้ามอธิบายว่า "เทียบเท่า" โดยไม่มีหลักฐาน
```

### 5.4 แปลหนึ่ง layer ([Module 04](04-port-layer.md)) — skill `port-layer` (`/port-layer typescript evaluation`)

```text
Role: senior TypeScript engineer.
อ่านตามลำดับ: CONVENTIONS.md, spec/business-rules.md, spec/evaluation.md, docs/porting/typescript-analysis.md, go/internal/evaluation/evaluation.go
Task: แปลเฉพาะ layer evaluation ไปเป็น [LAB]/lab/typescript/src/evaluation/index.ts ให้ผ่าน [LAB]/lab/typescript/src/evaluation/evaluation.test.ts
กติกา:
- พฤติกรรมต้องตรงกับ Go แต่ถ้า Go ขัดกับ spec ให้ยึด spec และรายงาน
- ใช้เฉพาะ library ที่อยู่ใน CONVENTIONS.md (evaluation เป็น pure function: ห้าม import อะไรนอก layer model)
- เขียนเป็น TypeScript ที่เป็น idiom ไม่ใช่แปลทีละบรรทัด
- ห้ามแก้ spec/, tests/ และห้ามแก้ไฟล์ test เพื่อให้ผ่าน
- ห้ามเขียนไฟล์ใดนอก [LAB]/lab/typescript/src/evaluation/
Done when: ในโฟลเดอร์ [LAB]/lab/typescript คำสั่ง npx tsc -p tsconfig.json และ node --test "dist/evaluation/*.test.js" ผ่านทั้งหมด และแสดงผลให้เห็น
Output: โค้ด + รายการ "ความต่างของพฤติกรรมจาก Go" + "ข้อสมมติทุกข้อที่ใช้" + "สิ่งในเอกสาร analysis ที่ผิด (ถ้ามี)"
```

### 5.5 ทดลอง framework ก่อนเขียน handler ([Module 05](05-framework-experiments.md))

```text
ก่อนเขียน layer handler เป็น [Rust (axum)] ให้ทดลองกับ framework จริง ห้ามตอบจากความจำ
1. เขียนโปรแกรมทิ้ง (ไม่อยู่ในรีโป) ที่มี route GET /v1/flags/{key} เปล่าๆ แล้วเปิด server จริง
   เปิดด้วย ( cd dir && exec คำสั่ง ) & เก็บ $! รอ /healthz ปิดด้วย PID เท่านั้น (ห้าม pkill/killall)
2. ยิงด้วย curl --path-as-is ทุกข้อ: path (/v1/flags/%FF, %C3%28, %00, %7F, %2F, %2f, %252F, a;b, %zz, a%, ว่าง, //, key ยาว 5,000 ตัว, %61 ต้องเจอ flag a),
   method (PATCH/OPTIONS/TRACE/HEAD บน path ที่มีและไม่มี method นั้น, GET /error /docs /openapi.json),
   header (key เป็นไบต์ Latin-1, ff fe, ยาว 5,000, header ซ้ำ),
   body (UTF-8 ผิด, UTF-16, BOM, NaN/Infinity, 01, .5, comment, comma ท้าย, key ซ้ำ, ซ้อนลึก 100,000 ชั้น, เลข 5,000 หลัก, 1e999, lone surrogate, เกิน 1 MiB, Content-Type ผิดชนิด),
   และ panic/exception ใน handler (ลูกค้าได้ 500 JSON หรือ connection ถูกปิด?)
3. บันทึกผลเป็นตาราง (input, สิ่งที่ framework ทำ, สถานะ/รูป body, ตรงกับ BR-xx ไหม) ลง docs/porting/[rust]-analysis.md หัวข้อ "การทดลอง framework"
4. ตารางสุดท้าย: แถวไหนขัดกับสเปก และวิธีรับมือ (เปลี่ยน server, ทำ routing/อ่าน body เอง) ห้ามเสนอให้แก้สเปกให้ตรงกับ framework
ห้ามเริ่มเขียน handler จนกว่าตารางเสร็จและฉันอนุมัติ
```

### 5.6 วิเคราะห์ผล differential ([Module 06](06-differential.md))

```text
ด้านล่างคือผลของ node tools/diff-servers/diff.mjs ระหว่าง A (Go ต้นฉบับ) กับ B ([TypeScript])
ห้ามแก้ไฟล์ใดๆ ก่อน
สำหรับ "แต่ละกลุ่มของความต่าง" (จัดกลุ่มตาม route + สาเหตุ ไม่ใช่ทีละ request):
1. ระบุว่าสเปก (spec/business-rules.md, spec/evaluation.md, spec/openapi.yaml) ตัดสินเรื่องนี้ไว้หรือไม่ อ้าง BR-xx หรือบรรทัด
2. ถ้าสเปกตัดสิน: ฝั่งไหนผิด (A หรือ B) พร้อมหลักฐาน
3. ถ้าสเปกเงียบ: เสนอข้อความที่ควรเพิ่มในสเปก และ contract test ที่ควรเพิ่ม (บอกเป็นข้อเสนอ ห้ามเพิ่มเอง เพราะห้ามแก้ spec/ และ tests/ โดยไม่ได้สั่ง)
4. ความต่างที่ยอมรับได้ต้องบอกเหตุผลและบันทึกใน docs/porting/[typescript]-analysis.md หัวข้อ "ความต่างที่ยอมรับ" ตามที่ฉันอนุมัติเท่านั้น
สรุปท้ายเป็นตาราง: กลุ่ม | ผิดที่ (โค้ด A / โค้ด B / test / สเปก) | หลักฐาน | สิ่งที่เสนอ
ผล diff:
[วางผลที่นี่]
```

### 5.7 ตรวจ CORS ด้วยเบราว์เซอร์จริง ([Module 07](07-sdk-cors.md))

```text
ตรวจ BR-56 และ BR-57 ของ service ภาษา [TypeScript] ด้วยเบราว์เซอร์จริง ห้ามแก้ไฟล์ใดๆ
1. build service และ SDK (sdk-js) ตาม CONVENTIONS.md
2. เปิด service ด้วย ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 CORS_ORIGINS=http://localhost:9001 DB_PATH เป็นไฟล์ชั่วคราว
   ใช้ ( cd dir && exec คำสั่ง ) & เก็บ $! รอ /healthz ตอบก่อน
3. รัน ( cd tools/browser-check && SVC_URL=http://localhost:8080 EXPECT=allowed npm run check ) แสดงผลบรรทัด ok/FAIL ทั้งบรรทัด
4. ปิด service ด้วย PID (ห้าม pkill/killall) ตรวจ ps แล้วเปิดใหม่โดยไม่ตั้ง CORS_ORIGINS และ DB ใหม่
5. รัน EXPECT=blocked แสดงผลทั้งบรรทัด แล้วปิดด้วย PID
6. ด้วย curl ยืนยัน: OPTIONS /v1/evaluate จาก origin ที่อนุญาต = 204 พร้อม Allow-Origin/Vary: Origin, origin อื่นและไม่มี Origin = 404,
   admin API ไม่มี header access-control-*, OPTIONS /v1/%65valuate = 404
7. รายงานเป็นตาราง ข้อตรวจ | ผลจริง | ผ่าน/ไม่ผ่าน และ "สิ่งที่ตรวจไม่ได้"
```

### 5.8 รีวิวอิสระใน session ใหม่ ([Module 08](08-review.md)) — skill `review-port` (`/review-port python`)

```text
คุณคือผู้รีวิว ไม่ใช่ผู้เขียน และ session นี้ต้องไม่เคยเห็นการทำงานของโค้ดที่รีวิว
ถ้าในบทสนทนานี้มีงานที่คุณหรือใครเขียนมาก่อน ให้บอกแล้วหยุด: ผลรีวิวจากบริบทของผู้เขียนไม่มีค่า
อ่านเฉพาะ spec/, tests/, CONVENTIONS.md, CLAUDE.md และโค้ดของ [python/] ห้ามอ่าน lessons/, docs/porting/, commit message ก่อน (เปิดทีหลังเพื่อเทียบเท่านั้น)
1. สำหรับทุก BR-xx ใน spec/business-rules.md: หาโค้ดที่ทำให้เป็นจริง และ test ที่จะล้มถ้าโค้ดผิด
   ติดป้าย: implemented and tested / implemented, not tested / not found
2. หาพฤติกรรมที่สเปกไม่ได้บอกแต่โค้ดตัดสินใจเอง (default, ลำดับ error, Unicode, ช่วงของ integer, ลำดับ, การจัดการ header และ path)
   แต่ละอย่างคือ finding: สเปกต้องมีกฎ หรือโค้ดกำลังเดา
3. อ่าน test แบบจับผิด: ค่าที่คาดมาจากตรรกะเดียวกับโค้ดหรือไม่ กรณี "ต้องล้ม" ล้มด้วยเหตุผลมากกว่าหนึ่งอย่างหรือไม่ บอกชื่อ bug ที่น่าจะลอดผ่าน test ได้
4. ตรวจกติกา CLAUDE.md: ไม่มี dependency นอก CONVENTIONS.md โดยไม่มีบันทึกใน docs/porting/[python]-analysis.md, ไม่มีการแก้ spec/ tests/contract/ tests/vectors/, ไม่มี test ที่ถูกข้าม
5. ห้ามแก้ไฟล์ใดๆ และห้ามรันอะไรที่เขียนนอกโฟลเดอร์ชั่วคราว (รัน gate ได้)
รายงานสั้นๆ: finding เรียงตามผลกระทบ แต่ละข้อมีไฟล์:บรรทัด กฎที่ขัด (BR-xx หรือ CLAUDE.md) และ input/test ที่แสดงปัญหาได้จริง
ต่อด้วยตาราง BR จากข้อ 1 แล้วหัวข้อ "สิ่งที่ฉันตรวจไม่ได้" ถ้าไม่มี finding ให้เขียน "no findings" ได้เฉพาะเมื่อดูทุก BR แล้วเท่านั้น ห้ามเติมรายการให้ยาว
```

## 6. ถ้า AI ตอบผิด: ทางลัดจากบทเรียนจริง

| อาการ | ทำอะไร | อ่านต่อ |
|---|---|---|
| test ผ่านแต่ AI เขียนเอง ค่าที่คาดคำนวณด้วยตรรกะเดียวกับโค้ด | ให้ใช้ค่าตายตัวจากสเปก | Module 03, `lessons/java.md` |
| test "ต้องล้ม" ล้มด้วยเหตุผลอื่น (11 variants น้ำหนักรวม 101) | ให้เหลือเงื่อนไขผิดข้อเดียว | Module 03, `lessons/rust.md` |
| เขียน handler ตามธรรมเนียม framework โดยไม่ทดลอง | ให้ทดลองก่อน ตารางผลจริง | Module 05 |
| บอกว่า CORS ผ่านเพราะ contract ผ่าน | ต้องรัน browser-check | Module 07 |
| เปิด server ด้วย `A && B &` / `pkill` / ตรวจด้วย `ss` | ใช้รูปแบบในส่วน 2 | Module 00 |
| แก้ test/spec/vectors ให้ผ่าน | ปฏิเสธ (CLAUDE.md "ห้าม") | Module 04 |
| รีวิวใน session เดียวกับที่เขียน | ไม่นับ เปิด session ใหม่ | Module 08 |
| ผล fail ทั้งชุด | ตรวจ `/healthz` และ `BASE_URL` ก่อน | Module 02 |
