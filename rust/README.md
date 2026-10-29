# Rust implementation

พอร์ตจากต้นฉบับ Go ([`../go`](../go/README.md)) ผ่านสเปกเดียวกัน ([`../spec`](../spec)), vectors และ contract test ชุดเดียวกัน โดยไม่แก้ test ใดๆ เพื่อให้ผ่าน เหตุผลของการออกแบบอยู่ใน [`../docs/porting/rust-analysis.md`](../docs/porting/rust-analysis.md) และสิ่งที่เรียนรู้ใน [`../lessons/rust.md`](../lessons/rust.md)

Rust (edition 2024), axum 0.8, `rusqlite` (SQLite คอมไพล์รวมในไบนารี: feature `bundled`), `serde_json`, `cargo test`

## โครงสร้าง

```
src/
  model.rs        Flag, Rule, Scalar (Str/Num/Bool), Context, EvaluationResult, ... ; Reason, Operator เป็น enum
  evaluation.rs   pure function ประเมิน flag + FNV-1a (wrapping_mul, as_bytes) + bucket
  erfc.rs         เขียนเอง: std ของ Rust ไม่มี erfc
  error.rs        Code (รหัส error + status) และ ServiceError
  parse.rs        ตรวจ body/query (BR-xx), timestamp
  repository.rs   trait Repository/Tx + SqliteRepository (connection เดียว หลัง Mutex)
  service.rs      Service<R: Repository>: กฎ BR-xx, audit, รายงานผลการทดลอง
  handler.rs      axum: routes, auth, อ่าน/parse body เอง, แปล error -> status
  timefmt.rs      เวลาเป็น ms -> RFC 3339 (เขียนเอง ไม่ใช้ date-time crate)
  config.rs       อ่านตัวแปร env
  main.rs         จุดเริ่มต้น + graceful shutdown
tests/
  vectors.rs      vectors กลาง (fnv, bucketing, evaluation, erfc)
  http.rs         server จริงบนพอร์ตว่าง + raw TCP
```

dependency ไปทางเดียว: `handler → service → repository` และ `service → evaluation → model`

## รัน

| ตัวแปร | ความหมาย | Default |
|---|---|---|
| `PORT` | พอร์ต HTTP | `8080` |
| `DB_PATH` | ไฟล์ SQLite | `./flags.db` |
| `ADMIN_KEY` | key ของ admin API (**จำเป็น**) | — |
| `CLIENT_KEY` | key ของ evaluate/events (**จำเป็น**) | — |

```bash
cd rust
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key cargo run --release
```

## ตรวจคุณภาพ (gates)

```bash
cd rust
cargo build
cargo fmt --check && cargo clippy --all-targets -- -D warnings
cargo test
```

Contract test (ต้องเปิด server ก่อน) ดู [`../tests/contract/README.md`](../tests/contract/README.md)

## จุดที่ออกแบบไว้โดยเจตนา (กับดักของ Rust/axum/serde_json)

- **hash:** `wrapping_mul` (ตัว `*` ธรรมดา panic ใน debug build แต่ wrap เงียบๆ ใน release: บั๊กจะโผล่เฉพาะบางโหมด) และ `as_bytes()` (Rust `String` เป็น UTF-8 เสมอ จึงไม่มีทาง lone surrogate)
- **ชนิด:** `Scalar` เป็น enum `Str | Num(f64) | Bool` และ `PartialEq` ที่ derive เทียบ variant ก่อนค่า จึงไม่มีทางที่ `true == 1` (เป็นข้อดีของระบบชนิด ไม่ต้องเขียนเช็ค)
- **path:** axum จับคู่ route บน path ดิบ (`a%2Fb` เป็น segment เดียว, `;` ไม่มีความหมาย) แต่ extractor `Path`/`RawPathParams` **ถอดรหัสเองและตอบ 400** เมื่อเจอ `%FF` จึงตัด key จาก `uri.path()` แล้วถอดรหัสเอง (BR-55)
- **405:** axum ตอบ 405 เมื่อ method ไม่ตรง; ใช้ `method_not_allowed_fallback` ให้เป็น 404 `FLAG_NOT_FOUND` (BR-53)
- **JSON:** `serde_json` เข้มงวดตาม RFC 8259 โดยปริยาย (ปฏิเสธ NaN, เลขนำหน้า 0, comment, comma ท้าย, lone surrogate escape, ข้อมูลหลังค่าแรก, ซ้อนลึกเกิน 128); ถอดรหัส UTF-8 เองแบบเข้มงวดก่อน; เลขที่เกิน double (`1e999`) ถูกปฏิเสธตั้งแต่ parse
- **body:** อ่าน stream เองทั้งก้อน (ไม่ใช้ extractor ของ axum ที่ตอบ 413 และไม่อ่านส่วนที่เหลือ) แล้วนับเกิน 1 MiB
- **panic:** panic ใน handler ทำให้ connection ปิดโดยไม่ตอบ; middleware `guard` รันแต่ละ request ใน task ของตัวเอง (`tokio::spawn`) แล้วแปลง task ที่ panic เป็น 500 ทึบ (ไม่ต้องใช้ crate เพิ่ม)
- **transaction:** `rusqlite::Transaction` rollback เองเมื่อถูก drop โดยไม่ commit (รวมกรณี panic); mutex ที่ถูก poison ถูกใช้ต่อ เพราะ transaction ถูก rollback แล้ว
- **auth:** เทียบไบต์ของ header (`HeaderValue::as_bytes`) แบบเวลาคงที่; ค่าใดๆ ที่ไม่ตรงคือ key ผิด ไม่ใช่ error
- **`erfc`/เวลา:** std ไม่มี จึงเขียนเอง (`erfc` ผ่าน `erfc.json`; เวลาใช้ algorithm civil-from-days)

## ข้อจำกัดที่รู้อยู่

- connection เดียวหลัง `Mutex` และเรียก SQLite แบบ blocking ใน async handler: เหมาะกับ workshop ไม่ใช่โหลดสูง
- ความต่างที่ยอมรับจาก Go: ดู analysis ข้อ 6
