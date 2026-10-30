# Conventions

กติกากลางที่ AI และคนต้องทำตามในทุกภาษา ถ้าข้อใดขัดกับ `spec/` ให้ยึด `spec/`

## หลักการ

1. `spec/` และ `tests/` (contract, vectors) เป็นของกลาง **ห้ามแก้เพื่อให้โค้ดผ่าน**
2. แปลเป็นโค้ดที่เป็น idiom ของภาษานั้น ไม่แปลทีละบรรทัด
3. ใช้เฉพาะ library ในตารางด้านล่าง ถ้าต้องการเพิ่มให้ขออนุมัติก่อน — ยกเว้นสิ่งที่ framework ในตารางพึ่งพาโดยตรง (ดูหัวข้อ "Dependency" ใน `CLAUDE.md`) และ devDependencies ของ `typescript/` กับ `sdk-js/` (`typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `@types/*`, `esbuild`) และ `playwright` (เฉพาะ `tools/browser-check/`, pin เวอร์ชัน, ผู้ใช้สั่งเพิ่ม) ซึ่งอนุมัติแล้ว
4. ไม่มี global mutable state; ทำ dependency injection ผ่าน constructor/parameter

## โครงสร้าง layer (ทุกภาษาเหมือนกัน)

```
handler     HTTP parsing, status codes, auth middleware
service     business rules (BR-xx) + evaluation (spec/evaluation.md)
repository  SQLite access (interface ที่ service ใช้)
model       Flag, Rule, Variant, Context, EvaluationResult
```

- `evaluation` เป็น **pure function** ไม่แตะ DB/เวลา/random เพื่อทดสอบด้วย `tests/vectors/` ได้โดยตรง
- Dependency ไหลทางเดียว: handler → service → repository

## Library ต่อภาษา

| ภาษา | โฟลเดอร์ | HTTP | SQLite | Test |
|---|---|---|---|---|
| Go 1.22+ | `go/` | `net/http` (ServeMux) | `modernc.org/sqlite` | `testing` |
| TypeScript (Node 22) | `typescript/` | Fastify | `better-sqlite3` | `node:test` |
| Java 21 | `java/` | Spring Boot 3 (embedded **Undertow**, ไม่ใช่ Tomcat — ดู `docs/porting/java-analysis.md`) | JDBC + `sqlite-jdbc` | JUnit 5 |
| Python 3.12+ | `python/` | FastAPI (+ uvicorn เป็น ASGI server) | `sqlite3` (stdlib) | pytest (+ ruff สำหรับ lint) |
| Rust (stable) | `rust/` | axum | `rusqlite` | `cargo test` |

## Naming และรูปแบบข้อมูล

- JSON ใช้ `camelCase` ตาม `spec/openapi.yaml`; โค้ดใช้ naming ตามธรรมเนียมภาษา (Go `CamelCase`, Python `snake_case`, Rust `snake_case`, Java/TS `camelCase`)
- เวลาเป็น UTC และ serialize เป็น RFC 3339 (`2026-01-31T08:00:00Z`)
- Error ทุกตัวต้องออกเป็น `{ "error": { "code", "message" } }` และ `code` ตรงกับ enum ใน OpenAPI
- Config ผ่าน environment variable เท่านั้น:

| ตัวแปร | ความหมาย | Default |
|---|---|---|
| `PORT` | พอร์ต HTTP | `8080` |
| `DB_PATH` | ไฟล์ SQLite | `./flags.db` |
| `ADMIN_KEY` | admin key (**จำเป็น**) | — |
| `CLIENT_KEY` | client key (**จำเป็น**) | — |
| `CORS_ORIGINS` | origin ที่เบราว์เซอร์เรียก `/v1/evaluate` และ `/v1/events` ได้ คั่นด้วย `,` หรือ `*` (BR-56; ชื่อและรูปแบบเป็นข้อสมมติของเรา สเปกกำหนดแค่พฤติกรรม) | ว่าง = ปิด CORS |

## กับดักเรื่องตัวเลข/ข้อความ (ต้องผ่าน `tests/vectors/` ทุกแถว)

| ภาษา | วิธีที่ถูก |
|---|---|
| Go | `uint32` และวนรอบ `[]byte(s)` (ไม่ใช่ `range` string ที่ได้ rune) |
| TypeScript | `Math.imul(h, 16777619) >>> 0` และ `Buffer.from(s, "utf8")` (ไม่ใช่ `charCodeAt`) |
| Java | `int` + `Integer.toUnsignedLong` แล้ว `% 10000`; `s.getBytes(StandardCharsets.UTF_8)` |
| Python | `(h * 16777619) & 0xFFFFFFFF`; `s.encode("utf-8")` |
| Rust | `h.wrapping_mul(16777619)`; `s.as_bytes()` |

เปรียบเทียบค่าใน rule ต้องตรวจ **ชนิดก่อนค่า** (`"1" != 1`, `true != "true"`): ระวัง Python ที่ `True == 1`, และ JS ที่ `==`

## คำสั่ง gate ต่อภาษา

> **สถานะ:** แถว **ทั้งห้าภาษา (Go, TypeScript, Python, Java, Rust) ทดสอบกับโค้ดจริงแล้ว** (build/lint/test รันผ่าน) skill และเอกสาร workshop อ้างอิงตารางนี้ที่เดียว

รันในโฟลเดอร์ของภาษานั้น (`go/`, `typescript/`, ...) ถ้าทำงานทีละ layer ให้กรอง test ด้วย package/path ของ layer นั้น

| ภาษา | build | lint / format | unit test (รวม vectors) | เริ่ม server |
|---|---|---|---|---|
| Go | `go build ./...` | `go vet ./... && test -z "$(gofmt -l .)"` | `go test -count=1 -race ./...` ¹ | `go run ./cmd/server` |
| TypeScript | `npm run build` | `npm run lint` (typescript-eslint **strict + stylistic**) | `npm test` | `node dist/server.js` |
| Python | `python -m compileall -q app tests` ² | `ruff check . && ruff format --check .` | `pytest` | `python -m app.main` (อ่าน `PORT`) หรือ `uvicorn app.main:app --port 8080` |
| Java | `mvn -q -DskipTests package` | `mvn -q checkstyle:check` ³ | `mvn -q test` | `java -jar target/ffservice.jar` |
| Rust | `cargo build` | `cargo fmt --check && cargo clippy --all-targets -- -D warnings` ⁴ | `cargo test` | `cargo run --release` |

¹ `-count=1` จำเป็น: vectors อยู่นอกโมดูล Go จึงไม่ถูกนับเป็นอินพุตของ cache และ `go test` จะแสดง `(cached)` ทั้งที่ไฟล์เปลี่ยนไปแล้ว

² ไม่ใช้ `.` เพราะ `python/.venv` อยู่ในโฟลเดอร์เดียวกัน (compileall จะเดินเข้าไปคอมไพล์ทุก package ที่ติดตั้ง) ต้องสร้าง venv ก่อน: `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt` และรันคำสั่งผ่าน `.venv/bin/…`

³ ต้องมี `java/checkstyle.xml` (อยู่ในโปรเจกต์) และ `mvn` ต้องดาวน์โหลด plugin ครั้งแรก; JVM ที่อยู่ใน locale POSIX สร้างชื่อไฟล์ non-ASCII ไม่ได้ (กระทบ `DB_PATH` เท่านั้น)

⁴ ต้องมี `rust/rustfmt.toml` (`max_width = 120`) และ C compiler (SQLite ถูกคอมไพล์รวม); `tokio`, `serde_json`, `http-body-util` เป็น dependency ที่ axum ใช้อยู่ — ข้อสมมติที่ต้องยืนยัน

**Contract test** (ทุกภาษาเหมือนกัน): เริ่ม server ด้วย `ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key CORS_ORIGINS=https://app.example.com PORT=8080 DB_PATH=<ไฟล์ชั่วคราว>` แล้วรัน (ถ้าไม่ตั้ง `CORS_ORIGINS` test CORS ส่วนที่ต้องมี origin จะถูกข้าม แต่ test ที่ว่า "ปิดแล้วต้องไม่ตอบ CORS" จะรัน)

```bash
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
```

ปิด server ด้วย PID ของโปรเซสที่เปิดเอง (ห้าม `pkill` / `killall`)

> Makefile (`make build-<lang>`, `make test-<lang>`, `make contract-<lang>`) เป็นแผนในอนาคตเพื่อห่อคำสั่งข้างบน

ทุก task ถือว่า "เสร็จ" เมื่อ build + lint + test + contract ผ่านครบ และไม่มี warning ใหม่

## SDK ฝั่ง web (`sdk-js/`)

ไม่ใช่การแปลจาก Go แต่สร้างจาก `spec/openapi.yaml` จึงไม่ใช้ contract test; ตัดสินด้วย unit (fake fetch), spec test และ integration กับ service จริง

| build | lint | test | ขนาด |
|---|---|---|---|
| `npm run build` | `npm run lint` (typescript-eslint strict + stylistic) | `npm test` (build + unit + spec + integration; เปิด `tools/mock-server` เอง หรือใช้ `FF_BASE_URL`) | `npm run size` (gzip < 5120 ไบต์) |

dev dependencies (`esbuild`, `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `@types/node`) **อนุมัติแล้ว** (ผู้ใช้สั่งใช้ข้อเสนอ 4 ใน `lessons/summary.md`) ใช้ร่วมกับ `typescript/`; runtime dependency: ไม่มี

## ก่อนเขียน handler: ทดลอง framework (บังคับ)

ทุกภาษาที่มี HTTP framework ต้องเขียนโปรแกรมทิ้งเล็กๆ แล้ว**ส่งจริง** (ไม่เดาจากความจำ) ก่อนเริ่ม layer handler และเก็บผลเป็นตารางใน `docs/porting/<lang>-analysis.md` ข้อ "การทดลอง framework" รายการขั้นต่ำ (มาจากสิ่งที่ทำนายพลาดในทั้ง 4 ภาษา: `lessons/summary.md` ข้อ 3):

| กลุ่ม | input ที่ต้องลอง |
|---|---|
| path | `/v1/flags/%FF`, `%C3%28`, `%00`, `%7F`, `%2F` / `%2f`, `%252F`, `a;b`, `%zz`, `a%`, ว่าง (`/v1/flags/`), `//`, segment เกิน, key ยาว 5,000 ตัว, `%61` (ต้องถอดรหัสแล้วเจอ flag `a`) |
| method | `PATCH`/`OPTIONS`/`TRACE`/`HEAD` บน path ที่มี method อื่นอยู่ และบน path ที่ไม่มี; `GET /error`, `/docs`, `/openapi.json` |
| header | key เป็นไบต์ Latin-1 / `ff fe` / ยาว 5,000 ตัว; header ซ้ำ |
| body | UTF-8 ผิด, UTF-16, BOM, `NaN`/`Infinity`, `01`, `.5`, comment, comma ท้าย, ค่าซ้ำหลังค่าแรก, key ซ้ำ, ซ้อนลึก 100,000 ชั้น, เลข 5,000 หลัก, `1e999`, lone surrogate `"\ud800"`, เกิน 1 MiB (framework อ่านส่วนที่เหลือก่อนตอบหรือไม่), `Content-Type` ผิดชนิด (form/text) |
| ความล้มเหลว | panic/exception ใน handler → ลูกค้าได้ 500 JSON ทึบหรือ connection ถูกปิดเฉยๆ? |

ถ้า framework ทำให้ไม่ได้ตามสเปก ให้เปลี่ยน server ตัวที่ใช้หรือทำ routing/อ่าน body เอง (Java: Undertow + servlet filter) อย่าแก้สเปกให้ตรงกับ framework

## การทำงานร่วมกับ AI

- แปลทีละ layer ตามลำดับ model → evaluation → repository → service → handler → main (evaluation มาก่อนเพราะเป็น pure function ที่ `tests/vectors/` ตัดสินได้ทันที)
- AI ต้องรายงาน **ความต่างของพฤติกรรมและข้อสมมติ** ทุกครั้งที่ส่งงาน
- บันทึกบทเรียนต่อภาษาใน `lessons/<lang>.md` (AI พลาดอะไร, prompt แบบไหนได้ผล)
