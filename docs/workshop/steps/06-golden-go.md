# Step 6: สร้างต้นฉบับ Go (golden implementation)

> ⏳ **ฉบับร่าง:** ยังไม่มี `go/` ในรีโปนี้ คำสั่งและ prompt ด้านล่างเป็นแนวทางที่เขียนจากบทเรียน step 1–5 และ **ยังไม่ได้ทดสอบกับโค้ดจริง** เมื่อสร้าง `go/` แล้วจะกลับมาปรับ (เฉพาะ gate ที่ผ่านแล้วเท่านั้นที่เชื่อถือได้)

**เป้าหมาย:** service ที่เขียนด้วย Go ผ่าน unit test, `tests/vectors/` และ contract test ทั้งหมด ใช้เป็นต้นฉบับอ้างอิงตอนแปลภาษาอื่น
**เวลา:** 60–90 นาที · **ก่อนหน้า:** [Step 5](05-contract-tests.md) · **ถัดไป:** [Step 7](07-skills.md)

## หลักคิด

- ทำทีละ **layer** และ **ตรวจก่อนไปต่อ** (compile ผ่านก่อน → test ผ่านก่อน) ถ้าให้ AI เขียนทั้งโปรเจกต์ในครั้งเดียว ถ้า fail คุณจะไม่รู้ว่าผิดที่ชั้นไหน
- ลำดับ: `model → evaluation → repository → service → handler → main` โดย **evaluation มาก่อน** เพราะเป็น pure function ที่ `tests/vectors/` ตัดสินได้ทันที ไม่ต้องมี database หรือ HTTP
- ห้ามแก้ `spec/` `tests/` ถ้าเห็นว่าสเปกผิด ให้หยุดและมาถามคุณ

## โครงสร้าง

```
go/
├── go.mod
├── cmd/server/main.go
└── internal/
    ├── model/         Flag, Rule, Variant, Context, Result
    ├── evaluation/    pure function ประเมิน flag (ไม่แตะ DB/เวลา)
    ├── repository/    SQLite (modernc.org/sqlite)
    ├── service/       กฎ BR-xx, audit log
    └── handler/       HTTP, auth middleware, รูปแบบ error
```

## ขั้นตอน

### 6.1 โครงโปรเจกต์ + model

```text
อ่าน CLAUDE.md, CONVENTIONS.md, spec/openapi.yaml แล้วสร้าง go/ (module "ffservice", Go 1.22)
เฉพาะ internal/model: struct Flag, Rule, Variant, Context, EvaluationResult ให้ตรงกับ OpenAPI
- JSON tag เป็น camelCase
- ฟิลด์ optional ที่ต้องแยก "ไม่ส่ง" กับ "ส่ง false/0" ได้ ใช้ pointer
- ยังไม่ต้องเขียน logic ใดๆ
เสร็จเมื่อ: cd go && go build ./... && go vet ./... ผ่าน
```

### 6.2 evaluation (pure function)

```text
อ่าน spec/evaluation.md แล้วสร้าง go/internal/evaluation:
- func Evaluate(flag *model.Flag, ctx model.Context) model.EvaluationResult
- ห้าม import database, http, time, rand
- FNV-1a เขียนเองตามสเปก วนบน []byte(s) ไม่ใช่ range string (ซึ่งได้ rune)
- unit test อ่าน tests/vectors/fnv1a32.json, bucketing.json, evaluation.json (path สัมพัทธ์จาก package)
  แล้วตรวจทุกแถว ห้ามแก้ไฟล์ vectors
เสร็จเมื่อ: cd go && go test ./internal/evaluation ผ่านทุกแถว
```

ตรวจ: `cd go && go test ./internal/evaluation -v | tail -5`

### 6.3 repository (SQLite)

```text
สร้าง go/internal/repository ด้วย modernc.org/sqlite (ไม่ใช้ cgo)
- interface FlagRepository: Create, Get, Update, Delete, List(limit, offset) และ AuditRepository: Append, List
- rules และ variants เก็บเป็น JSON text, เก็บลำดับ variants ตามที่ส่งมา
- List เรียงตาม key ascending และคืน total
- schema สร้างอัตโนมัติตอนเปิด database
- test ใช้ database ":memory:" ครอบคลุม CRUD, ลำดับ, total, key ซ้ำ
เสร็จเมื่อ: go test ./internal/repository ผ่าน
```

### 6.4 service (กฎธุรกิจ)

```text
สร้าง go/internal/service ที่ใช้ repository ผ่าน interface (ไม่ import sqlite ตรง)
- implement validation ทุกข้อใน spec/business-rules.md (BR-01..09, BR-30..35, BR-50) แล้วคืน error ที่มี code
  ตรงกับ enum ใน OpenAPI
- นับความยาว description เป็น Unicode code point (utf8.RuneCountInString)
- ตัวเลขใน JSON อาจเป็นทศนิยม: rolloutPercent=10.5 ต้องถูกปฏิเสธ
- เขียน flag + audit log ใน transaction เดียวกัน; request ที่ถูกปฏิเสธห้ามเขียน audit
- unit test อ้างรหัส BR-xx ในชื่อ test ทุกข้อ
เสร็จเมื่อ: go test ./internal/service ผ่าน
```

### 6.5 handler + main

```text
สร้าง go/internal/handler และ go/cmd/server/main.go
- net/http ServeMux (Go 1.22 pattern เช่น "GET /v1/flags/{key}")
- middleware auth ตาม BR-10..13 (401 ไม่มี/ผิด, 403 client key เรียก admin)
- ทุก error ออกเป็น {"error":{"code","message"}} พร้อม Content-Type: application/json
- body ที่ไม่ใช่ JSON หรือชนิดผิด -> 400 VALIDATION_ERROR (ไม่ใช่ 500)
- config จาก env: PORT(8080), DB_PATH(./flags.db), ADMIN_KEY, CLIENT_KEY (สองตัวหลังบังคับ มิฉะนั้นไม่ start)
- graceful shutdown เมื่อได้ SIGINT/SIGTERM
เสร็จเมื่อ: go build ./... ผ่าน และ server start ได้
```

### 6.6 รัน contract test กับ Go (gate สุดท้าย)

```bash
cd go && go build -o /tmp/ffservice ./cmd/server && cd ..
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH=$(mktemp -u).db /tmp/ffservice & SVC_PID=$!
sleep 1
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
kill $SVC_PID
```

ผลที่ต้องการ: `fail 0` เหมือนที่ mock ผ่าน ถ้า fail ให้ส่งชื่อ test และข้อความ error กลับให้ AI **ไม่เกิน 3 รอบ** แล้วคนเข้ามาอ่านเอง

```text
test เหล่านี้ fail กับ Go server: <วางชื่อ test + ผล>
วิเคราะห์ก่อนแก้: ผิดที่โค้ด, test หรือสเปก? ระบุหลักฐาน (BR-xx) แล้วค่อยเสนอแก้
ห้ามแก้ tests/ หรือ spec/ ถ้าคิดว่าสเปกผิดให้หยุดและถามฉัน
```

### 6.7 รีวิว แล้วปักหมุด

```text
review go/ ทั้งหมดเทียบกับ spec/ ในฐานะ reviewer: หา (1) พฤติกรรมที่ไม่มี test ครอบคลุม (2) data race
(3) ที่ที่ error ถูกกลืน (4) โค้ดที่ซับซ้อนเกินจำเป็น รายงานเป็นตารางพร้อม file:line อย่าแก้โค้ด
```

```bash
cd go && go vet ./... && test -z "$(gofmt -l .)" && go test -race ./...
cd .. && git add -A && git commit -m "Add Go golden implementation" && git tag golden-v1
```

## สิ่งที่คาดว่าจะพลาด (จากบทเรียน step 1–5 และธรรมชาติของ Go)

| จุด | อาการ | test ที่จะจับ |
|---|---|---|
| `for _, c := range s` ได้ rune ไม่ใช่ไบต์ | bucket ของ userId ภาษาไทย/emoji ผิด | `bucketing.json` |
| ถอด JSON เป็น `int` ตรงๆ | `rolloutPercent: 10.5` ผ่านเข้ามา | `variants.test.mjs` |
| ฟิลด์ `bool` ธรรมดา | แยก "ไม่ส่ง" กับ `false` ไม่ได้ PUT จึง reset ผิด | `flags.test.mjs` (PUT full replace) |
| `len(description)` | นับไบต์ ไม่ใช่ code point | test "500 emoji" |
| ไม่ใช้ transaction | audit log ไม่ตรงกับ flag เมื่อมี error | test audit |
| error จาก decoder กลายเป็น 500 | `malformed JSON` ได้ 500 | BR-52 |

## ข้อควรระวัง

- เมื่อ test fail ให้ถาม **ใครผิด** (โค้ด/test/สเปก) ก่อนแก้ ถ้าสเปกผิด ให้แก้สเปกก่อนแล้วค่อยแก้โค้ด และสร้าง vectors ใหม่ (step 4)
- ปิด server ด้วย PID ที่จดไว้ ไม่ใช้ `pkill`
- ต้นฉบับ Go ที่ผ่านแล้วคือ "golden": ต่อไปห้ามแก้พฤติกรรมโดยไม่แก้สเปกและ contract test ก่อน มิฉะนั้นภาษาอื่นจะเทียบไม่ได้
