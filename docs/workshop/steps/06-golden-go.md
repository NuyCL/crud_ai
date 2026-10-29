# Step 6: สร้างต้นฉบับ Go (golden implementation)

**เป้าหมาย:** service ที่เขียนด้วย Go ผ่าน unit test, `tests/vectors/` และ contract test ทั้งหมด ใช้เป็นต้นฉบับอ้างอิงตอนแปลภาษาอื่น
**เวลา:** 60–90 นาที · **ก่อนหน้า:** [Step 5](05-contract-tests.md) · **ถัดไป:** [Step 7](07-skills.md)

> ✅ **มีเฉลยและทดสอบแล้ว:** โค้ดอยู่ใน [`go/`](../../../go/README.md) คำสั่งตรวจในเอกสารนี้รันจริงแล้ว
> **ข้อควรทราบอย่างตรงไปตรงมา:** โค้ดใน `go/` สร้างโดยทำตามแนวทางของ prompt ด้านล่างภายในบทสนทนาเดียวที่มีบริบทของ step 1–5 อยู่แล้ว ยังไม่เคยนำ prompt เหล่านี้ไปรันกับ AI ในบทสนทนาใหม่ที่ไม่มีบริบท ผลของคุณอาจต่างจากเฉลย (โดยเฉพาะโครงสร้างภายใน) สิ่งที่ต้องตรงกันคือผล gate ไม่ใช่หน้าตาของโค้ด

## หลักคิด

- ทำทีละ **layer** และ **ตรวจก่อนไปต่อ** ถ้าให้ AI เขียนทั้งโปรเจกต์ในครั้งเดียว ถ้า fail คุณจะไม่รู้ว่าผิดที่ชั้นไหน
- ลำดับ: `model → evaluation → repository → service → handler → main` โดย **evaluation มาก่อน** เพราะเป็น pure function ที่ `tests/vectors/` ตัดสินได้ทันที ไม่ต้องมี database หรือ HTTP
- ห้ามแก้ `spec/` `tests/` ถ้าเห็นว่าสเปกผิด ให้หยุดและมาถามคุณ

## โครงสร้าง

```
go/
├── go.mod                       module ffservice, go 1.22
├── cmd/server/main.go
└── internal/
    ├── model/         Flag, Rule, Variant, Context, Result, AuditLog, Event
    ├── evaluation/    pure function ประเมิน flag (ไม่แตะ DB/เวลา)
    ├── repository/    SQLite (modernc.org/sqlite)
    ├── service/       กฎ BR-xx, audit log, รายงานผลการทดลอง
    └── handler/       HTTP, auth middleware, รูปแบบ error
```

เตรียม dependency ครั้งเดียว (ต้องต่อเน็ต): `cd go && go get modernc.org/sqlite@v1.29.10 && go mod tidy` เวอร์ชันนี้ยังรองรับ `go 1.22` ตาม CONVENTIONS เวอร์ชันใหม่กว่าอาจบังคับให้ยก `go` ใน `go.mod` ขึ้น

## ขั้นตอน

ทุก layer ใช้วงจรเดียวกัน: **prompt → gate → mutation check → commit**

### 6.1 โครงโปรเจกต์ + model

```text
อ่าน CLAUDE.md, CONVENTIONS.md, spec/openapi.yaml แล้วสร้าง go/ (module "ffservice", Go 1.22)
เฉพาะ internal/model: struct Flag, Rule, Variant, Context, EvaluationResult, AuditLog, Event, Results
ให้ตรงกับ OpenAPI
- JSON tag เป็น camelCase
- ตัวเลขใน rule ใช้ float64, ค่าใน rule/attribute เป็น string/float64/bool เท่านั้น
- ยังไม่ต้องเขียน logic ใดๆ
เสร็จเมื่อ: cd go && go build ./... && go vet ./... ผ่าน
```

> **การตัดสินใจที่ต่างจากร่างเดิม:** ร่างเดิมแนะนำให้ใช้ pointer เพื่อแยก "ไม่ส่ง" กับ `false`/`0` ในเฉลยแก้ปัญหานี้อีกแบบ: handler ถอด JSON เป็น `any` (ด้วย `UseNumber`) แล้ว service ตรวจว่าฟิลด์ "ปรากฏ" หรือไม่ ผลคือรู้ทั้งชนิดที่ผิดและฟิลด์ที่หายไปโดยไม่ต้องมี struct รับ input แยก

### 6.2 evaluation (pure function)

```text
อ่าน spec/evaluation.md แล้วสร้าง go/internal/evaluation:
- func Evaluate(flag *model.Flag, ctx model.Context) model.EvaluationResult
- ห้าม import database, http, time, rand
- FNV-1a เขียนเองตามสเปก วนบนไบต์ s[i] ไม่ใช่ range string (ซึ่งได้ rune)
- unit test อ่าน tests/vectors/fnv1a32.json, bucketing.json, evaluation.json (path สัมพัทธ์จาก package)
  แล้วตรวจทุกแถว ห้ามแก้ไฟล์ vectors
เสร็จเมื่อ: cd go && go test ./internal/evaluation ผ่านทุกแถว
```

ตรวจ: `cd go && go test ./internal/evaluation -v | grep -c "^    --- PASS"` ได้ **51** (หนึ่งต่อ evaluation case)

**Mutation check (อย่าข้าม):** ใส่ bug ลงในสำเนาแล้วดูว่า test จับได้ ในเฉลยจับครบ 3 แบบ

| bug ที่ใส่ | ผล |
|---|---|
| วน `for _, c := range s` (ได้ rune) | `TestFNV1a32Vectors`, `TestBucketingVectors`, `TestEvaluationVectors` ล้ม |
| สลับเป็น FNV-1 (คูณก่อน xor) | ล้มทั้งสาม |
| แปลง hash เป็น `int32` มีเครื่องหมาย | `TestBucketingVectors`, `TestEvaluationVectors` ล้ม |
| คำนวณเป็น `uint64` แล้วตัดเหลือ 32 บิตตอนท้าย | **ไม่ล้ม และไม่ใช่ bug จริง** ผล 32 บิตล่างเท่ากับการ wrap ทุกรอบพอดี (equivalent mutant) |

บรรทัดสุดท้ายคือบทเรียน: mutation ที่รอดไม่ได้แปลว่า test อ่อนเสมอไป ต้องถามก่อนว่า mutation นั้นเปลี่ยนพฤติกรรมจริงหรือไม่

### 6.3 repository (SQLite)

```text
สร้าง go/internal/repository ด้วย modernc.org/sqlite (ไม่ใช้ cgo)
- interface Repository และ Tx: การเปลี่ยน flag กับการเขียน audit log ต้องอยู่ใน transaction เดียวกัน
- rules และ variants เก็บเป็น JSON text, เก็บลำดับ variants ตามที่ส่งมา
- ListFlags เรียงตาม key ascending และคืน total ที่อ่านจาก transaction เดียวกับหน้าที่คืน
- RecordEvents: exposure แรกชนะ, conversion ซ้ำนับครั้งเดียว, ทั้งชุดสำเร็จหรือไม่เลย
- pool 1 connection (จำเป็นสำหรับ ":memory:" และ SQLite เขียนได้ทีละคนอยู่แล้ว)
- test ใช้ database ":memory:" ครอบคลุม CRUD, ลำดับ, total, key ซ้ำ, rollback, audit, events
เสร็จเมื่อ: go test -race ./internal/repository ผ่าน
```

Mutation ที่ลองและถูกจับ: ไม่ rollback เมื่อ callback ล้มเหลว, เรียง key ย้อนกลับ, exposure หลังทับแรก, conversion ไม่สนใจ goal

### 6.4 service (กฎธุรกิจ)

```text
สร้าง go/internal/service ที่ใช้ repository ผ่าน interface (ไม่ import sqlite ตรง)
- รับ body ที่ถอดจาก JSON แล้ว (any, ตัวเลขเป็น json.Number) และ validate ทุกข้อใน spec/business-rules.md
  (BR-01..09, BR-20, BR-30..35, BR-43..46, BR-50) แล้วคืน *Error ที่มี code ตรงกับ enum ใน OpenAPI
- นับความยาว description เป็น Unicode code point (utf8.RuneCountInString)
- rolloutPercent=10.5 ต้องถูกปฏิเสธ แต่ 10.0 รับได้
- เขียน flag + audit log ใน transaction เดียวกัน; request ที่ถูกปฏิเสธห้ามเขียน audit
- ลำดับการตรวจตาม BR-51: validation ก่อน แล้วค่อย 404/409
- รายงานผลการทดลองตามสูตรใน BR-42 (pooled two-proportion z-test, math.Erfc)
- unit test อ้างรหัส BR-xx ในชื่อ test ทุกข้อ
เสร็จเมื่อ: go test -race ./internal/service ผ่าน
```

Mutation ที่ลองในเฉลย: นับ description เป็นไบต์, รับ rolloutPercent ทศนิยม, ไม่ตรวจผลรวม weight, รับ variant key ซ้ำ, ยอมเปลี่ยน key, ไม่เขียน audit ตอนลบ, ไม่มีขั้นต่ำ 30 ตัวอย่าง, รับ `null` เป็น scalar, ใช้ z โดยไม่ใส่ค่าสัมบูรณ์ **ทั้ง 9 แบบถูกจับ** แต่ตอนรอบแรก 1 แบบรอด คือ **เครื่องหมาย z** เพราะทุก test ให้ treatment ดีกว่า control เสมอ จึงเพิ่ม test กรณี treatment แย่กว่า (two-sided) ตรงนี้คือช่องโหว่ของ test ที่ mutation check เปิดโปง

### 6.5 handler + main

```text
สร้าง go/internal/handler และ go/cmd/server/main.go
- net/http ServeMux (Go 1.22 pattern เช่น "GET /v1/flags/{key}")
- middleware auth ตาม BR-10..13 (401 ไม่มี/ผิด, 403 client key เรียก admin) และตรวจก่อนอ่าน body (BR-51)
- ทุก error ออกเป็น {"error":{"code","message"}} พร้อม Content-Type: application/json
  รวม route ที่ไม่มี (ไม่ใช่ข้อความ plain text ของ mux) และ panic (500 INTERNAL_ERROR ไม่เปิดเผยรายละเอียด)
- อ่าน body ด้วย json.Decoder + UseNumber, ต้องเป็น JSON 1 ค่าพอดี และจำกัดขนาด 1 MB (BR-52)
- config จาก env: PORT(8080), DB_PATH(./flags.db), ADMIN_KEY, CLIENT_KEY (สองตัวหลังบังคับ มิฉะนั้นไม่ start)
- graceful shutdown เมื่อได้ SIGINT/SIGTERM
เสร็จเมื่อ: go build ./... ผ่าน และ go test -race ./... ผ่าน
```

> ระหว่างทำพบว่าสเปกไม่มี error code สำหรับความผิดพลาดภายใน จึงเพิ่ม `INTERNAL_ERROR` (500) ใน `spec/openapi.yaml` และ `spec/business-rules.md` ตรงนี้คือตัวอย่างของ "แก้สเปกก่อน แล้วค่อยแก้โค้ด"

### 6.6 รัน contract test กับ Go (gate สุดท้าย)

```bash
cd go && go build -o ffservice ./cmd/server && cd ..
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH=go/contract.db go/ffservice & SVC_PID=$!
sleep 1
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
kill $SVC_PID
rm -f go/contract.db go/contract.db-shm go/contract.db-wal go/ffservice
```

ผลที่ถูกต้อง: `# pass 333`, `# fail 0`, `# skipped 0` เหมือนที่ mock ผ่าน (เฉลยผ่านตั้งแต่รันครั้งแรกกับ Go ตอนที่ชุด test ยังมี 258 ข้อ ต่อมาชุดโตเป็น 313 ระหว่าง step 8–9 โดยที่ Go ต้องถูกแก้ 1 จุด: ดู [`lessons/typescript.md`](../../../lessons/typescript.md) ข้อ 2 และเป็น 333 ใน step 10 โดย Go ต้องถูกแก้อีก 1 จุด: อ่านทั้งก้อนแล้วตรวจ UTF-8, ดู [`lessons/python.md`](../../../lessons/python.md))

ถ้า fail ให้ส่งชื่อ test และข้อความ error กลับให้ AI **ไม่เกิน 3 รอบ** แล้วคนเข้ามาอ่านเอง:

```text
test เหล่านี้ fail กับ Go server: <วางชื่อ test + ผล>
วิเคราะห์ก่อนแก้: ผิดที่โค้ด, test หรือสเปก? ระบุหลักฐาน (BR-xx) แล้วค่อยเสนอแก้
ห้ามแก้ tests/ หรือ spec/ ถ้าคิดว่าสเปกผิดให้หยุดและถามฉัน
```

**การตรวจเพิ่ม (ทำแล้วในเฉลย):**

| ตรวจอะไร | วิธี | ผล |
|---|---|---|
| data race | build ด้วย `go build -race` แล้วรัน contract test ทั้งแบบเรียงและขนาน | 0 race; เรียง 313/313, ขนาน 312 ผ่าน + 1 skipped (ข้อแบ่งหน้า) (ตรวจตอนชุดมี 313 ข้อ) |
| ใช้ database ซ้ำ | รัน contract test ซ้ำรอบที่สองบน server เดิม | 313/313 (ตอนชุดมี 313 ข้อ) |
| ข้อมูลอยู่รอดหลังรีสตาร์ท | สร้าง flag (description ไทย+emoji) → ปิด → เปิดใหม่ → อ่าน | ข้อมูลและ UTF-8 ครบ |
| โหมด MVP1 | `CONTRACT_MVP=1` | 154 ผ่าน, 52 ข้าม |
| mutation ระดับ HTTP | ใส่ bug ในโค้ด Go แล้ว build ใหม่ รัน contract test | 6/6 ถูกจับ: นับ description เป็นไบต์, client key ได้ 401 แทน 403, list ไม่สนใจ offset, ไม่ใช้ `UseNumber`, PUT รีเซ็ต `createdAt`, exposure หลังทับแรก |

### 6.7 รีวิว แล้ว commit

```text
review go/ ทั้งหมดเทียบกับ spec/ ในฐานะ reviewer: หา (1) พฤติกรรมที่ไม่มี test ครอบคลุม (2) data race
(3) ที่ที่ error ถูกกลืน (4) ทรัพยากรที่อาจรั่ว (connection, transaction, goroutine) (5) โค้ดที่ซับซ้อนเกินจำเป็น
รายงานเป็นตารางพร้อม file:line อย่าแก้โค้ด
```

รอบรีวิวของเฉลยเจอ 2 เรื่องที่ test ทั้งหมดก่อนหน้า **ไม่เห็น** (เขียน test ที่ล้มก่อน แล้วค่อยแก้):

1. **panic ใน callback ของ `Tx` ทำให้ connection ค้าง:** pool มี 1 connection ถ้า transaction ไม่ถูกจบ ทุก request หลังจากนั้นจะรอตลอดไป (handler กู้ panic ได้ แต่ผลข้างเคียงนี้ไม่หาย) แก้ด้วย `defer recover → Rollback → panic ต่อ`
2. **path ของ database ที่มี `?` `#` `%`** ถูกตีความเป็นส่วนของ URI ไฟล์ถูกสร้างผิดที่เงียบๆ test แรกที่ผมเขียนผ่านทั้งที่มี bug เพราะเปิดซ้ำด้วย path เดิมก็เจอไฟล์ผิดที่เดิม ต้อง `os.Stat` ที่ path ที่ขอจริง บทเรียน: test ที่ "ผ่าน" ต้องถามว่า **มันจะล้มไหมถ้าโค้ดผิด**

```bash
cd go && go build ./... && go vet ./... && test -z "$(gofmt -l .)" && go test -count=1 -race ./...
cd .. && git add -A && git commit -m "Add Go golden implementation" && git tag golden-v1
```

(คำสั่งตรวจในบรรทัดแรกคือแถว Go ในตาราง gate ของ [`CONVENTIONS.md`](../../../CONVENTIONS.md) และผ่านจริง)

## บทเรียนจากการสร้างจริง

| ที่เจอ | ต้นเหตุ | ป้องกันที่ไหน |
|---|---|---|
| test ของ service ผลรั่วข้ามการทดลอง | conversion ผูกกับ `(goal, userId)` ทั่วระบบ แต่ test ใช้ goal `buy` กับชื่อ user ซ้ำกัน (เหมือนที่เจอใน contract test) | ใช้ goal ที่ไม่ซ้ำต่อ test; สเปกควรเตือนข้อนี้ชัดๆ |
| test สร้าง key ที่มี `/` | key ใน test ประกอบจากชื่อ case | ใช้ตัวนับแทนชื่อ |
| mutation ที่รอดเพราะ build ล้ม | ลบโค้ดแล้ว import/ตัวแปรไม่ถูกใช้ ผลที่ได้คือ "build failed" ไม่ใช่ "test ล้ม" | อ่านผล mutation ว่าเป็นล้มเพราะ test หรือ build; ทำ mutation ให้ยัง compile ได้ |
| เครื่องหมาย z | ไม่มี test ที่ treatment แย่กว่า control | เพิ่ม test two-sided |
| 500 ไม่มี error code | สเปกลืม | เพิ่ม `INTERNAL_ERROR` |
| Tx panic, URI path | เจอตอนรีวิว | test ที่ล้มก่อนแก้ |
| กับดัก `$` ของ regex มีแค่ใน unit test ของ Go | ภาษาอื่นไม่ถูกบังคับ | เพิ่ม contract test 2 ข้อ ใช้ได้ทั้ง mock และ Go |
| `go test` แสดง `(cached)` หลัง vectors เปลี่ยน | vectors อยู่นอกโมดูล Go จึงไม่ถูกนับเป็นอินพุตของ cache | ใช้ `go test -count=1` ใน gate (แก้ใน CONVENTIONS แล้ว) |
| Go ผ่อนปรนกว่าสเปกเรื่อง timestamp | `time.Parse` รับชั่วโมงหลักเดียว, `,` ก่อนเศษวินาที, offset `+24:00` ซึ่ง RFC 3339 ไม่รับ | เจอตอนเทียบกับ TypeScript (step 9) แก้ Go + เพิ่ม contract test: **ต้นฉบับ "ผ่านทุก test" ไม่ได้แปลว่าถูกตามสเปก** |

## สิ่งที่ทำให้ Go ผ่านรอบแรก (และควรระวังตอนแปลภาษาอื่น)

| จุด | อาการถ้าพลาด | ตัวจับ |
|---|---|---|
| `range` ของ string ได้ rune ไม่ใช่ไบต์ | bucket ของ userId ภาษาไทย/emoji ผิด | `bucketing.json` |
| ถอด JSON เป็น `int` ตรงๆ | `rolloutPercent: 10.5` ผ่านเข้ามา | variants tests |
| `len(description)` | นับไบต์ ไม่ใช่ code point | test "500 emoji" |
| ไม่ใช้ transaction | audit log ไม่ตรงกับ flag เมื่อมี error | test audit |
| error จาก decoder กลายเป็น 500 | `malformed JSON` ได้ 500 | BR-52 |
| regex `$` | ใน Go `$` ตรงท้ายข้อความเท่านั้น (key `abc\n` ถูกปฏิเสธ) แต่ใน Python `$` ตรงก่อน `\n` ท้ายสุดได้ และ `find()` ของ Java ก็ยอม | contract test "trailing newline" (**เพิ่มหลังเขียน Go เสร็จ** เมื่อสังเกตว่ากับดักนี้มีแค่ใน unit test ของ Go จึงยังไม่บังคับภาษาอื่น) |

## ข้อควรระวัง

- เมื่อ test fail ให้ถาม **ใครผิด** (โค้ด/test/สเปก) ก่อนแก้ ถ้าสเปกผิด ให้แก้สเปกก่อนแล้วค่อยแก้โค้ด และสร้าง vectors ใหม่ (step 4)
- ปิด server ด้วย PID ที่จดไว้ ไม่ใช้ `pkill` และลบไฟล์ด้วยชื่อที่ระบุตรงๆ
- ต้นฉบับ Go ที่ผ่านแล้วคือ "golden": ต่อไปห้ามแก้พฤติกรรมโดยไม่แก้สเปกและ contract test ก่อน มิฉะนั้นภาษาอื่นจะเทียบไม่ได้
