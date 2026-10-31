# การวิเคราะห์ก่อนแปล: Go → TypeScript

เขียนก่อนแปลโค้ดบรรทัดแรก (ตาม [Step 8](../workshop/steps/08-pre-port-analysis.md)) จากการอ่าน `go/`, `CONVENTIONS.md`, `spec/` และ **การทดลองจริงกับ Fastify 5.12.7, better-sqlite3 13.0.3, Node 22.22, TypeScript 6.0.3** ทุกข้อเท็จจริงเกี่ยวกับ framework ด้านล่างมาจากผลการรันไม่ใช่ความจำ

> **วิธีทำรายงานนี้:** ทำตามขั้นตอนของ skill `spec-ambiguity-check` (ข้อ 8) ด้วยตัวเอง เพราะ session ที่สร้างไฟล์ skill ยังไม่รู้จักมัน (ถูกโหลดตอนเริ่ม session) จึงเรียกผ่าน `Skill` ไม่ได้ และรายงานนี้ไม่ได้เขียนโดย AI ในบทสนทนาใหม่ที่ไม่มีบริบท

## 1. ส่วนของ Go ที่ใช้จริง → วิธีใน TypeScript

| ส่วนใน Go | อ้างอิง | วิธีใน TypeScript |
|---|---|---|
| `error` ค่าที่คืน + `errors.Is/As` | `service/errors.go:22`, `service/service.go:51,63` | `class ServiceError extends Error` มี `code`; ข้อผิดพลาดของ repository เป็น class แยก (`NotFoundError`, `ExistsError`); ใช้ `instanceof` แทน `errors.Is`; ไม่ใช้ `Result` เพราะ Go-style `(v, err)` ไม่เหมาะกับ TS และ exception ตรงกับ transaction rollback ของ better-sqlite3 |
| `*model.Flag` = "อาจไม่มี" | `evaluation/evaluation.go` (`Evaluate(flag *Flag…)`) | `Flag \| null` |
| `*string` สำหรับ `variant` ที่เป็น `null` | `model/model.go` (`EvaluationResult.Variant`) | `variant: string \| null` |
| struct + JSON tag | `model/model.go` | `interface` (ไม่มี class) ฟิลด์ตรงกับ OpenAPI; ไม่ต้อง tag เพราะชื่อ property คือชื่อ JSON |
| `map[string]any` / `any` | `evaluation.go:77,110` | `Record<string, unknown>` สร้างด้วย `Object.create(null)` และอ่านด้วย `Object.hasOwn` (ดูข้อ 2) |
| `interface` Repository/Tx | `repository/repository.go` | `interface` ของ TypeScript ตรงๆ (structural) |
| `context.Context` | repository/service ทุกเมธอด | **ตัดทิ้ง**: better-sqlite3 เป็น synchronous จึงไม่มีอะไรให้ยกเลิก; ฟังก์ชัน service เป็น sync ทั้งหมด |
| goroutine / mutex | ไม่มีในโค้ดแอป; มีแค่ `main.go` (server goroutine + signal) | ไม่มี: Node เป็น single-thread และ DB เป็น sync จึงไม่มีทางแทรกกันระหว่าง `COUNT(*)` กับ `SELECT` (`sqlite.go:296` `read()` ไม่จำเป็น) |
| pool 1 connection | `sqlite.go:78` | connection เดียวโดยธรรมชาติ ไม่ต้องตั้งค่า |
| `Tx(fn)` + `recover()` ใน defer | `sqlite.go:175,183` | `db.transaction(fn)` ของ better-sqlite3: rollback เมื่อ throw (รวม panic-เทียบเท่า) **ต้องมี test ยืนยัน** ไม่ใช่เชื่อเอกสาร |
| `database/sql` + `modernc.org/sqlite` | `sqlite.go` | `better-sqlite3` (prepared statement, sync) SQL เดียวกันทุกประโยค |
| `INSERT OR IGNORE` (first-wins) | `sqlite.go:387,391` | SQL เดิม |
| `json.RawMessage` สำหรับ audit before/after | `model.go`, `sqlite.go:259` | เก็บเป็นสตริง JSON ใน SQLite และ `JSON.parse` ตอนคืน (Go คืนข้อความ JSON เดิมตรงๆ) |
| `time.Time` + `RFC3339Nano` | `sqlite.go:93` | เก็บสตริง `toISOString()` (UTC, ms) |
| `ServeMux` pattern `"GET /v1/flags/{key}"` | `handler/handler.go:34-48` | Fastify route (`app.get("/v1/flags/:key")`) |
| middleware `admin(...)` / `clientOrAdmin(...)` | `handler.go:71,85` | hook `onRequest` ต่อ route (ทำงาน **ก่อน** อ่าน body: ทดลองแล้ว ข้อ 4) |
| catch-all `"/"` → JSON 404 | `handler.go:54` | `setNotFoundHandler` |
| `recoverPanics` | `handler.go:95` | `setErrorHandler` (ข้อผิดพลาดที่ไม่รู้จัก → 500 `INTERNAL_ERROR` ไม่เปิดเผยรายละเอียด) |
| `http.MaxBytesReader(1 MiB)` + `dec.UseNumber()` + `dec.Token()` EOF | `handler.go:156-163` | `bodyLimit: 1048576` + content-type parser ของเราเอง (`JSON.parse` ซึ่งปฏิเสธข้อมูลเกินตามหลัง) |
| `subtle.ConstantTimeCompare` | `handler.go:63` | เทียบ SHA-256 ของสองฝั่งด้วย `crypto.timingSafeEqual` (ความยาวเท่ากันเสมอ) |
| `regexp` | `parse.go:24` | `RegExp` ตัวเดียวกัน (`$` ของ JS ไม่มี multiline จึงตรงท้ายข้อความเท่านั้น เหมือน Go: ต่างจาก Python) |
| `utf8.RuneCountInString` | `parse.go:104` | `Array.from(s).length` (นับ code point) |
| `math.Erfc` | `service.go:242` | **JavaScript ไม่มี `erfc` ในตัว** ต้องเขียนเอง (ข้อ 2) |
| `time.Parse(time.RFC3339, …)` | `parse.go:334` | ตรวจเอง: regex + ตรวจปฏิทิน (ข้อ 2) |
| `signal.NotifyContext` + `Shutdown` | `main.go:85,104` | `process.on("SIGINT"/"SIGTERM")` → `await app.close()` |
| `go test` + vectors จากไฟล์ | `*_test.go` | `node:test` อ่านไฟล์เดียวกัน |

## 2. กับดักด้านตัวเลขและข้อความ

| เรื่อง | Go | TypeScript / JavaScript | วิธีรับมือ | ตัวจับ |
|---|---|---|---|---|
| คูณ FNV 32 บิต | `uint32` wrap เอง | `number` เป็น double: `h * 16777619` เกิน 2⁵³ แล้วเพี้ยนเงียบๆ | `Math.imul(h, 16777619) >>> 0` | `fnv1a32.json`, `bucketing.json` |
| hash บนไบต์ | `s[i]` | `charCodeAt` ได้ UTF-16 | `Buffer.from(s, "utf8")` | `bucketing.json` (ไทย/ญี่ปุ่น/emoji) |
| นับ description | `RuneCountInString` | `s.length` นับ UTF-16 (emoji = 2) | `Array.from(s).length` | contract "500 emoji" |
| `10` กับ `10.0` | `json.Number` แยกได้ | `JSON.parse` แยก **ไม่ได้** (ทั้งคู่เป็น `10`) | ยอมรับ `10.0` ตามสเปกใหม่ (BR-30 แก้ใน step 8) ปฏิเสธ `10.5` ด้วย `Number.isInteger` | contract "the JSON number 10.0 is the integer 10" (ใหม่) |
| `1e999` | ปฏิเสธ (`Inf`) | `JSON.parse` ได้ `Infinity` | `Number.isFinite` | service test |
| เทียบ `"1"` กับ `1`, `true` กับ `"true"` | type switch | `==` แปลงชนิด; `true == 1` | `typeof a === typeof b && a === b` + eslint `eqeqeq` | `target-eq-type-*` |
| attribute ชื่อ `constructor`, `toString`, `__proto__` | `map` ปลอดภัย | `attrs["constructor"]` เจอ **function**; `"toString" in {}` เป็น true; `copy["__proto__"] = v` ถูกกลืนเงียบ | `Object.hasOwn`, สร้างด้วย `Object.create(null)` + `Object.defineProperty` | vectors `target-attr-*` (ใหม่ 6 case) |
| RFC 3339 | `time.Parse` เข้มงวด | `Date.parse("2026-02-30T00:00:00Z")` สำเร็จ (กลายเป็น 2 มี.ค.), `T24:00:00Z` สำเร็จ, วันที่ล้วนๆ สำเร็จ | regex + ตรวจวัน/เดือน/ชั่วโมง/นาที/offset เอง | contract timestamp × 9 (ใหม่) |
| `erfc` | `math.Erfc` | ไม่มี | ต้องใช้การประมาณที่แม่น ≤ 1e-7 (Abramowitz–Stegun 7.1.26 ที่ mock ใช้ ผิดพลาด < 1.5e-7) **เสี่ยง:** service test ของ Go เทียบ p-value ที่ 1e-9 ซึ่งการประมาณนี้ไม่ผ่าน (contract test ใช้ 1e-4 จึงผ่าน) → ใช้อัลกอริทึมที่แม่นกว่า และ **เพิ่ม `tests/vectors/erfc.json`** (37 แถวจาก Go ตรวจกับ Python) เป็นตัวบังคับความแม่นของทุกภาษา | `erfc.json` (ใหม่), contract "z-test" (1e-4) |
| สตริงที่มี lone surrogate (`"\ud800"`) | decoder แทนด้วย U+FFFD | เก็บไว้ และ `JSON.stringify` ออกเป็น `"\ud800"` | **ความต่างที่ยอมรับ** (ข้อ 6) ไม่แก้ | — |
| จำนวนเต็มใหญ่ใน rule (`> 2⁵³`) | float64 | double | เหมือน Go (ทั้งคู่ float64) | — |

## 3. Library

| ใช้ | อยู่ใน CONVENTIONS | หมายเหตุ |
|---|---|---|
| Fastify 5.12.7 | ✅ | |
| better-sqlite3 13.0.3 | ✅ | ติดตั้งได้ (มี prebuilt) ไม่ต้อง compile; ไม่ต้องใช้ `node:sqlite` ที่ยังเป็น experimental |
| `node:test` | ✅ | |
| TypeScript 6.0.3, ESLint 10 + typescript-eslint 8, `@types/node@22`, `@types/better-sqlite3` | ⚠️ **นอกรายการ (devDependencies)** | จำเป็นต่อ gate `npm run build` / `npm run lint` ที่ CONVENTIONS กำหนด ไม่เข้าไปใน runtime รออนุมัติ: ถ้าไม่อนุมัติ gate จะทำไม่ได้ |

## 4. สิ่งที่ Fastify ทำเองและขัดกับสเปก (ทดลองแล้ว)

| พฤติกรรมเริ่มต้นที่สังเกตได้ | ขัดกับ | วิธีแก้ (ทดลองแล้วว่าใช้ได้) |
|---|---|---|
| body `application/json` ที่เป็น JSON ปกติ → ส่งต่อได้ | — | — |
| `text/plain` → ส่ง **สตริงดิบ** เข้า handler (ไม่ parse) | BR-52 (ไม่ตรวจ Content-Type) | `removeAllContentTypeParsers()` + parser `"*"` แบบ `parseAs: "string"` ที่เรียก `JSON.parse` เอง |
| `application/x-www-form-urlencoded` หรือไม่มี Content-Type → **415** | BR-52 | เหมือนข้างบน |
| key `"__proto__"` ใน JSON → **400** `FST_ERR_CTP_INVALID_JSON_BODY` | vector `target-attr-proto-present` | parser ของเรา (`JSON.parse` สร้าง own property อย่างปลอดภัย) |
| body > 1 MiB → **413** `FST_ERR_CTP_BODY_TOO_LARGE` (พอดี 1 MiB ผ่าน) | BR-52 (ต้อง 400) | `bodyLimit: 1048576` + `setErrorHandler` แปลง 413 เป็น 400 `VALIDATION_ERROR` |
| body ว่างและไม่มี Content-Type → ไม่เรียก parser, `req.body` เป็น `undefined` | BR-52 | handler ต้องถือว่า `undefined` = "ไม่มี JSON" → 400 |
| body ว่างและเป็น `application/json` → เรียก parser (`JSON.parse("")` โยน) | — | ได้ 400 ตามต้องการ |
| route ที่ไม่มี หรือ method ผิด → **404 รูปแบบของ Fastify** (`{"message","error","statusCode"}`) | BR-53 | `setNotFoundHandler` |
| `/ok/` (ท้ายด้วย `/`) → 404 | — (ตรงกับ Go) | ไม่ต้องทำอะไร |
| `/p/%E0%A4%A` (escape ผิด) → 400 รูปแบบของ Fastify **และไม่ผ่าน `setErrorHandler`** | BR-52 / รูปแบบ error | ตัวเลือก `frameworkErrors` |
| query ซ้ำ `limit=1&limit=2` → `request.query.limit` เป็น **array** | BR-50 (Go ใช้ค่าแรก) | อ่านจาก `new URL(req.url, "http://x").searchParams` (`get` คืนค่าแรก) แทน `req.query` |
| path param `a%2Fb` → ถอดรหัสเป็น `a/b` | — (ตรงกับ Go) | — |
| `onRequest` hook ตอบ 401 **ก่อน** อ่าน body | BR-51 (ต้องเป็นแบบนี้) | ใช้ `onRequest` ไม่ใช่ `preHandler` |
| header ซ้ำ `X-Admin-Key: a` สองบรรทัด → Node ส่งต่อเป็น `"a, a"` (Go `Header.Get` ได้ `"a"`) | ไม่ได้ระบุในสเปก | **ความต่างที่ยอมรับ** (ข้อ 6) |

## 5. ความเสี่ยง 5 อันดับ

| # | ความเสี่ยง | ผลกระทบ | ตัวจับ | สถานะ |
|---|---|---|---|---|
| 1 | พฤติกรรมของ framework ต่อ body/route/error (ข้อ 4) | ได้ 415/413/ข้อความ 404 ผิดรูปแบบ; ปฏิเสธ `__proto__` | contract: Content-Type, ขนาด 1 MiB (พอดีและเกิน), ข้อมูลเกินท้าย JSON, auth ก่อน body, route ที่ไม่มี | **เพิ่มก่อนแปลแล้ว** (เดิมไม่มีตัวจับ) |
| 2 | ตัวเลข/hash (`Math.imul`, UTF-8) | bucket ผิด → ผู้ใช้ได้ variant ผิด | `fnv1a32.json`, `bucketing.json`, `evaluation.json` | มีอยู่แล้ว |
| 3 | lookup attribute ด้วยชื่อที่ชนกับ `Object.prototype` | rule ที่ไม่มีค่ากลับ "ผ่าน" | vectors `target-attr-*` | **เพิ่มก่อนแปลแล้ว** |
| 4 | `Date.parse` ผ่อนปรนเกินไป | timestamp ที่ผิดถูกรับ | contract timestamp × 9 | **เพิ่มก่อนแปลแล้ว** (ทำให้พบว่า mock เองก็ผิดด้วย) |
| 5 | `erfc` ไม่มีในตัว / ความแม่น p-value | `significant` ผิดใกล้ 0.05; ผลต่างจาก Go | `erfc.json` + contract (1e-4) + differential test | **เพิ่ม `erfc.json` ก่อนแปลแล้ว** (เดิมมีแค่ 1e-4) |

ที่ **ไม่มีตัวจับและไม่ได้เพิ่ม** (ตั้งใจ): lone surrogate, header ซ้ำ, รูปแบบตัวเลขขนาดใหญ่มากในผลลัพธ์ — ดู "ความต่างที่ยอมรับ"

## 6. ความต่างที่ยอมรับ (ไม่แก้ ไม่มี test บังคับ)

1. string ที่มี lone surrogate: Go เปลี่ยนเป็น U+FFFD ตอน decode, TypeScript คงไว้ (สเปกไม่ระบุ)
2. header ซ้ำ: Go ใช้ค่าแรก, Node รวมเป็น `"a, a"` ทำให้ key ไม่ตรง (สเปกไม่ระบุ)
3. timestamp ใน response: Go ตัดศูนย์ท้าย (`…:09Z`), JS เป็น 3 หลักเสมอ (`…:09.000Z`) ทั้งคู่ถูกต้องตาม RFC 3339
4. path ที่ไม่สะอาด (ทดลองแล้ว): `/v1//flags`, `//v1/flags`, `/v1/./flags` → Go (`ServeMux`) **redirect 301** ไปยัง `/v1/flags`; Fastify ตอบ **404** สำหรับ `//` และ **200** สำหรับ `/./` (สเปกไม่ระบุ)
5. ตัวเลข rule ขนาดใหญ่มากแสดงผลต่างกันเล็กน้อย (`1e+21` เทียบกับ `1e21`)

differential test (Step 9.6) ต้อง normalize ข้อ 3 และสุ่มไม่แตะข้อ 1, 2, 4, 5

## 7. ลำดับ layer และคำสั่ง gate

ลำดับ: `model → evaluation → repository → service → handler → main` (เหมือน Go) แต่ละ layer ต้องผ่าน build + lint + test ของ layer นั้นก่อนไปต่อ

```bash
cd typescript && npm run build && npm run lint && npm test   # แถว TypeScript ใน CONVENTIONS.md
node --test --test-concurrency=1 "tests/contract/*.test.mjs"      # หลังเสร็จ main
```

หมายเหตุ `erfc`: ต้องผ่าน `tests/vectors/erfc.json` ทุกแถว (ความคลาดเคลื่อน ≤ 1e-12 สัมบูรณ์ หรือ 1e-9 สัมพัทธ์) การประมาณแบบ Abramowitz–Stegun (< 1.5e-7) ไม่พอ จะเลือกวิธีและบันทึกผลใน `lessons/typescript.md`

## 8. จุดกำกวมของสเปกที่พบ (ผลของ `spec-ambiguity-check typescript`) และการตัดสินใจ

| # | จุดกำกวม | ผลถ้าตีความผิด | การตัดสินใจ | สถานะ |
|---|---|---|---|---|
| 1 | `10.0` นับเป็นจำนวนเต็มไหม | JS รับ/ปฏิเสธไม่เหมือน Go | นับ (BR-30) | แก้สเปก + เพิ่ม test |
| 2 | ต้องตรวจ Content-Type ไหม | Fastify ตอบ 415 | ไม่ตรวจ (BR-52) | แก้สเปก + เพิ่ม test |
| 3 | body ใหญ่เกินตอบอะไร | 413 กับ 400 | 400 `VALIDATION_ERROR` ขีดจำกัด 1 MiB (BR-52) | แก้สเปก + เพิ่ม test |
| 4 | `timestamp` "ถูกต้อง" แค่ไหน | `Date.parse` ผ่อนปรน | ถูกต้องตามปฏิทินและมีโซน (BR-43) | แก้สเปก + เพิ่ม test |
| 5 | attribute ชื่อ `constructor` ฯลฯ | lookup ผิดใน JS | เป็นชื่อธรรมดา (evaluation.md 3.1) | แก้สเปก + เพิ่ม vectors |
| 6 | route ที่ไม่มี / method ผิด | รูปแบบ error ของ framework | 404 `FLAG_NOT_FOUND` โดยไม่ต้อง auth (BR-53) | แก้สเปก + เพิ่ม test |
| 7 | auth ก่อนหรือหลังอ่าน body | 400 กับ 401 | auth ก่อน (BR-51 มีอยู่แล้ว) | เพิ่ม contract test (เดิมมีแค่ unit test ของ Go) |
| 8 | lone surrogate | ผลต่างกัน | ไม่ระบุ | ยอมรับ (ข้อ 6) |
| 9 | header ซ้ำ | key ไม่ตรง | ไม่ระบุ | ยอมรับ (ข้อ 6) |
| 10 | `limit=1&limit=2` | array กับค่าแรก | ใช้ค่าแรก | ใช้ `searchParams.get` ไม่มี test |
| 11 | `limit` เป็นเลขอาหรับ-อินเดีย `١٢` | `\d` ของ Python/Java ตรงกับ Unicode digit | ใช้ `[0-9]` เท่านั้น | ไม่มี test (ระวังตอนแปล Python) |

## 9. คำถามที่ต้องให้คนตัดสินใจ

1. อนุมัติ devDependencies ในข้อ 3 หรือไม่ (จำเป็นต่อ gate)
2. อนุมัติการตัดสินใจในข้อ 8 ที่ **แก้สเปก** (BR-30, 43, 52, 53 และ evaluation.md 3.1) ซึ่งเปลี่ยนสเปกที่ Go ใช้อยู่ด้วย (Go ผ่านชุดใหม่ทั้งหมดโดยไม่ต้องแก้โค้ด: 299/299)
3. ยอมรับความต่างข้อ 6 หรือต้องการให้เพิ่ม test บังคับ

## 10. หลังเพิ่ม CORS (BR-56) และ BR-57

อ่านจากโค้ดจริงใน `typescript/src/handler/handler.ts` (`buildApp`) และ `typescript/src/config.ts`:

- **CORS** อยู่ใน hook `onRequest` ของ Fastify (ไม่ใช่ plugin `@fastify/cors` เพราะไม่อยู่ในตาราง `CONVENTIONS.md`): ถ้า `Origin` ไม่ว่างและ path เป็น `/v1/evaluate` หรือ `/v1/events` ด้วย method `POST`/`OPTIONS` และ origin อยู่ในรายการ จะตั้ง `access-control-allow-origin` (และ `vary: Origin` เมื่อไม่ใช่ `*`) แล้วถ้าเป็น `OPTIONS` ตอบ 204 ทันทีโดยไม่ผ่านการตรวจ key; กรณีอื่นปล่อยผ่านไปยัง route ปกติ ส่วน header ที่ตั้งไว้ติดไปกับทุกสถานะของ `POST`
- **BR-57** เป็น hook `onRequest` อีกตัวที่ทำงาน**ก่อน** hook ของ CORS: ถ้า segment ใดของ path มี `%` ที่ไม่ใช่ key ของ `/v1/flags/{key}` ตอบ 404 `FLAG_NOT_FOUND` ทันที (จึงไม่มี CORS บน `/v1/%65valuate` ตามสเปก) ก่อนมีกฎนี้ Fastify ถอดรหัสทุก segment ก่อน routing ทำให้ `/v1/%65valuate` เข้า route จริง
- config: `CORS_ORIGINS` อ่านใน `config.ts` แล้วส่งเข้า `buildApp` ผ่าน `corsOrigins` (ไม่มี global state)
- ความต่างจาก Go: Go ใช้ middleware ห่อ `ServeMux`; ผลที่สังเกตได้จากภายนอกเหมือนกัน (ผ่าน contract 390 ข้อ และ differential)
