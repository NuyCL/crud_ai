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

## คำสั่งมาตรฐาน (Makefile ที่จะเพิ่มทีหลัง)

```
make build-<lang>      compile/type-check
make lint-<lang>       format + lint
make test-<lang>       unit test + vectors
make contract-<lang>   เปิด service แล้วรัน tests/contract/ ผ่าน HTTP
```

ทุก task ถือว่า "เสร็จ" เมื่อ build + lint + test + contract ผ่านครบ และไม่มี warning ใหม่

## การทำงานร่วมกับ AI

- แปลทีละ layer ตามลำดับ model → repository → service → handler → main
- AI ต้องรายงาน **ความต่างของพฤติกรรมและข้อสมมติ** ทุกครั้งที่ส่งงาน
- บันทึกบทเรียนต่อภาษาใน `lessons/<lang>.md` (AI พลาดอะไร, prompt แบบไหนได้ผล)
