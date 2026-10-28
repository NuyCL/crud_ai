# Conventions

กติกากลางที่ AI และคนต้องทำตามในทุกภาษา ถ้าข้อใดขัดกับ `spec/` ให้ยึด `spec/`

## หลักการ

1. `spec/` และ `tests/` (contract, vectors) เป็นของกลาง **ห้ามแก้เพื่อให้โค้ดผ่าน**
2. แปลเป็นโค้ดที่เป็น idiom ของภาษานั้น ไม่แปลทีละบรรทัด
3. ใช้เฉพาะ library ในตารางด้านล่าง ถ้าต้องการเพิ่มให้ขออนุมัติก่อน
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
| Java 21 | `java/` | Spring Boot 3 | JDBC + `sqlite-jdbc` | JUnit 5 |
| Python 3.12 | `python/` | FastAPI | `sqlite3` (stdlib) | pytest |
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

> **สถานะ:** แถว **Go ทดสอบกับ `go/` แล้ว** (build/lint/test รันผ่านจริง) แถวอื่นเป็นข้อเสนอเริ่มต้นที่ยังไม่ได้ทดสอบ (ยังไม่มี implementation) เมื่อมีโค้ดของภาษานั้นให้แก้ให้ตรงกับของจริง skill และเอกสาร workshop อ้างอิงตารางนี้ที่เดียว

รันในโฟลเดอร์ของภาษานั้น (`go/`, `typescript/`, ...) ถ้าทำงานทีละ layer ให้กรอง test ด้วย package/path ของ layer นั้น

| ภาษา | build | lint / format | unit test (รวม vectors) | เริ่ม server |
|---|---|---|---|---|
| Go | `go build ./...` | `go vet ./... && test -z "$(gofmt -l .)"` | `go test ./...` | `go run ./cmd/server` |
| TypeScript | `npm run build` | `npm run lint` | `npm test` | `node dist/server.js` |
| Python | `python -m compileall -q .` | `ruff check . && ruff format --check .` | `pytest` | `uvicorn app.main:app --port 8080` |
| Java | `mvn -q -DskipTests package` | `mvn -q checkstyle:check` | `mvn -q test` | `java -jar target/*.jar` |
| Rust | `cargo build` | `cargo fmt --check && cargo clippy -- -D warnings` | `cargo test` | `cargo run --release` |

**Contract test** (ทุกภาษาเหมือนกัน): เริ่ม server ด้วย `ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH=<ไฟล์ชั่วคราว>` แล้วรัน

```bash
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
```

ปิด server ด้วย PID ของโปรเซสที่เปิดเอง (ห้าม `pkill` / `killall`)

> Makefile (`make build-<lang>`, `make test-<lang>`, `make contract-<lang>`) เป็นแผนในอนาคตเพื่อห่อคำสั่งข้างบน

ทุก task ถือว่า "เสร็จ" เมื่อ build + lint + test + contract ผ่านครบ และไม่มี warning ใหม่

## การทำงานร่วมกับ AI

- แปลทีละ layer ตามลำดับ model → evaluation → repository → service → handler → main (evaluation มาก่อนเพราะเป็น pure function ที่ `tests/vectors/` ตัดสินได้ทันที)
- AI ต้องรายงาน **ความต่างของพฤติกรรมและข้อสมมติ** ทุกครั้งที่ส่งงาน
- บันทึกบทเรียนต่อภาษาใน `lessons/<lang>.md` (AI พลาดอะไร, prompt แบบไหนได้ผล)
