# การวิเคราะห์ก่อนแปล: Go → Rust

ตาม [Step 8](../workshop/steps/08-pre-port-analysis.md) ข้อเท็จจริงเรื่อง crate ทุกข้อมาจากการรันจริงกับ **Rust 1.97.0, axum 0.8.9, hyper 1.12, tokio 1.54.1, serde_json 1.0.154, rusqlite 0.41.1 (SQLite 3 คอมไพล์รวม), http-body-util 0.1.5** ทดลองด้วยโปรเจกต์ทิ้ง (`rustprobe`) **ก่อนเขียน `handler.rs`** บทเรียนจาก [TypeScript](typescript-analysis.md), [Python](python-analysis.md) และ [Java](java-analysis.md) ถูกใช้เป็นรายการตรวจ: path (`%FF`, `%00`, `%2F`, `;`, `%zz`), method ที่ไม่ตรง, `OPTIONS`/`TRACE`/`HEAD`, header ที่ไม่ใช่ ASCII, body (UTF-8, UTF-16, NaN, ซ้อนลึก, lone surrogate, เลขยาว), panic ใน handler

## 1. ส่วนของ Go ที่ใช้จริง → วิธีใน Rust

| ส่วนใน Go | วิธีใน Rust |
|---|---|
| `error` + `errors.Is/As` | `Result<T, E>`: `ServiceError { code, message }` (ความผิดของ client), `RepoError { NotFound, Exists, Storage }`, และ `service::Error { Client, Storage }` ที่เป็นสิ่งเดียวที่ handler เห็น; `?` + `From` แทน `errors.Is` |
| `*model.Flag` = "อาจไม่มี" | `Option<&Flag>` |
| `*string` สำหรับ `variant` | `Option<String>` |
| ค่า rule/attribute `any` (string, float64, bool) | `enum Scalar { Str, Num(f64), Bool }`; `PartialEq` ที่ derive เทียบ variant ก่อนค่า จึงเป็น "ไม่แปลงชนิด" โดยโครงสร้าง |
| operator/reason เป็นสตริง | `enum Operator`, `enum Reason` (เทียบกันด้วย `match`: ไม่มี operator ที่พิมพ์ผิด) |
| struct + JSON tag | struct ธรรมดา + `to_json()` ด้วย `serde_json::json!` (ไม่ใช้ derive `Serialize`: ไม่เพิ่ม dependency `serde`) |
| `context.Context` | ตัดทิ้ง (rusqlite เป็น sync) |
| `Tx(fn)` + `recover()` | `transaction(|tx| …)`: `Err` หรือ panic ที่คลายสแตกผ่านไป → `Transaction` ถูก drop โดยไม่ commit → rollback |
| pool 1 connection + mutex | `Mutex<Connection>` (`std::sync`, ไม่มี `.await` ระหว่างถือ) |
| `database/sql` + modernc | `rusqlite` + `bundled` (ต้องมี C compiler: `gcc` มีอยู่), WAL, `busy_timeout` 5000, `BEGIN IMMEDIATE` |
| `ServeMux` + catch-all `/` | axum `Router` + `.fallback` + `.method_not_allowed_fallback` (404 `FLAG_NOT_FOUND` ทั้งคู่) |
| `recoverPanics` | middleware `guard` + `tokio::spawn` (task ที่ panic → `JoinError` → 500 ทึบ) |
| `MaxBytesReader` + `UseNumber` + `dec.Token()` EOF | อ่าน stream ด้วย `BodyExt::frame()` (นับเกิน 1 MiB แต่อ่านต่อจนจบ); `str::from_utf8` เข้มงวด; `serde_json::from_str` (ปฏิเสธข้อมูลหลังค่าแรก) |
| `subtle.ConstantTimeCompare` | ฟังก์ชัน `constant_time_eq` ของเราเอง (xor ทุกไบต์ของ key ที่ยาวกว่า) บน `HeaderValue::as_bytes()` |
| `regexp` | ตรวจไบต์ด้วยมือ (`is_ascii_lowercase` ฯลฯ) ไม่เพิ่ม dependency `regex` |
| `utf8.RuneCountInString` | `chars().count()` (`len()` นับไบต์) |
| `math.Erfc` | **Rust std ไม่มี** — เขียนเอง ผ่าน `erfc.json` (อัลกอริทึมเดียวกับ TypeScript/Java) |
| `time.Time` + `time.Parse(RFC3339)` | เก็บ `i64` มิลลิวินาที; จัดรูปแบบ/แปลงด้วย algorithm civil-from-days; ตรวจ timestamp ของ client ด้วยมือ (ไม่ใช้ chrono) |
| `signal.NotifyContext` + `Shutdown` | `with_graceful_shutdown` + `ctrl_c`/SIGTERM |

## 2. สเปกที่แก้ไว้แล้วก่อนแปล

BR-52, BR-54, BR-55, `evaluation.md` 3.1 (ดู [python-analysis.md](python-analysis.md) ข้อ 2 และ commit `4a0f398`) Rust ผ่านชุด contract 333 ข้อรอบแรก

## 3. กับดักของ Rust (ทดลองจริงด้วย `rustprobe`)

| เรื่อง | พฤติกรรมที่พบ | วิธีรับมือ | ตัวจับ |
|---|---|---|---|
| คูณ FNV 32 บิต | `*` ธรรมดา **panic ใน debug build** และ wrap เงียบๆ ใน release (`overflow-checks` ปิด) | `wrapping_mul` | unit test รันใน debug: mutation ที่ใช้ `*` ถูกจับ; vectors |
| ชนิดข้อมูลผสม | `true == 1` ทำไม่ได้ในระบบชนิด; `Scalar` derive `PartialEq` เทียบ variant ก่อน | ไม่ต้องทำอะไร | vectors `target-*-bool-*`, mutation |
| `f64` เทียบ | `-0.0 == 0.0` จริง; `NaN != NaN` | ใช้ `==` ตรงๆ | `types_are_never_converted`, `numbers_are_ieee_doubles` |
| `String` | เป็น UTF-8 เสมอ จึง hash ด้วย `as_bytes()` ได้ และ lone surrogate เกิดไม่ได้ | — | — |
| `serde_json` | ปฏิเสธ `NaN`, `01`, `.5`, `1.`, `+1`, comment, `'`, comma ท้าย, newline ดิบ, BOM, ข้อมูลหลังค่าแรก; **lone surrogate escape → error** (สเปกยอม: 400 ไม่ใช่ 5xx); **คีย์ซ้ำ: ค่าสุดท้ายชนะ**; **ซ้อนเกิน 128 ชั้น → error**; `1e999` และเลข 400 หลัก → "number out of range"; `-0` → `-0.0` (f64); `18446744073709551616` → f64 | ไม่ต้องทำอะไร | contract + `tests/http.rs` |
| `str::from_utf8` | เข้มงวด: ปฏิเสธไบต์ `ff` และ CESU-8 `ed a0 80` | ใช้ก่อน parse | contract |
| `u16::from_str("+80")` | **ยอมรับเครื่องหมายบวก** | ตรวจ `is_ascii_digit` ทุกตัวก่อน | `config::tests` |
| `char::is_numeric` / `is_alphanumeric` | รับเลขและตัวอักษร Unicode | ใช้ `u8::is_ascii_*` | mutation (Unicode digits ถูกจับ) |
| `HashMap` | ลำดับการวนไม่คงที่ | ผล evaluate เก็บใน `BTreeMap` (ลำดับ key คงที่) | — |
| `as` cast | `u64 as f64` ปัดแบบ round-to-nearest-even ถูกต้อง (`9007199254740993` → `…992`) | ใช้ `Number::as_f64()` | `numbers_are_ieee_doubles` |

## 4. การทดลอง axum (เปลี่ยนการออกแบบเล็กน้อย)

ส่ง `GET /v1/flags/<key>` ด้วย `curl --path-as-is` ไปยัง router ที่ทดลอง:

| path | `RawPathParams` / `Path` ของ axum | `uri.path()` |
|---|---|---|
| `/v1/flags/%FF`, `/v1/flags/%C3%28` | **400** `Invalid UTF-8 in key` (ก่อนถึงโค้ดเรา) | ดิบ `%FF` |
| `/v1/flags/a%2Fb` | key = `a/b` (ยังเป็น segment เดียว: matchit จับคู่บน path ดิบ) | ดิบ |
| `/v1/flags/%00`, `%7F` | key = NUL / DEL | ดิบ |
| `/v1/flags/%zz`, `/v1/flags/a%` | key = `%zz` (ไม่ error) | ดิบ |
| `/v1/flags/a;b` | key = `a;b` | ดิบ |
| `/v1/flags/`, `//x`, `/a/b` | ไม่ตรง route → fallback | |
| `PATCH /v1/flags/x`, `OPTIONS …`, `TRACE …`, `GET /v1/evaluate` | 405 → `method_not_allowed_fallback` | |
| `HEAD /v1/flags/x` | ตอบเหมือน `GET` แต่ไม่มี body (เหมือน Go) | |
| header `X-Admin-Key` ไบต์ Latin-1 | ผ่าน (`HeaderValue::as_bytes`) | |

ข้อสรุป: ใช้ routing ของ axum ได้ (ต่างจาก Java: ไม่ต้องเลิกใช้ framework) แต่ **ห้ามใช้ extractor `Path`/`RawPathParams`** ตัด key จาก `uri.path()` แล้วถอดรหัสเอง; `%zz` ตรวจเองใน middleware → 400 JSON; ไม่ใช้ extractor `Bytes`/`Json` ของ axum (ตอบ 413 แบบข้อความธรรมดาและไม่อ่านส่วนที่เหลือ) อ่าน `Body` เอง

## 5. Library และข้อสมมติ

| ใช้ | อยู่ใน CONVENTIONS | หมายเหตุ |
|---|---|---|
| axum 0.8.9 (features: `http1`, `tokio`) | ✅ | |
| rusqlite 0.41.1 (`bundled`) | ✅ | ต้องมี C compiler ตอน build |
| tokio 1.54.1 | ไม่อยู่ในตาราง | axum ใช้ tokio เป็น runtime; **ข้อสมมติ: ถือว่าเป็นส่วนของ axum** |
| serde_json 1.0.154 | ไม่อยู่ในตาราง | parser ของ JSON (extractor `Json` ของ axum ก็ใช้ตัวนี้); **ข้อสมมติเดียวกัน** (เขียน JSON parser เองเพื่อเลี่ยงถือว่าไม่สมเหตุผล) |
| http-body-util 0.1.5 | ไม่อยู่ในตาราง | อ่าน `Body` ทีละ frame (axum ก็ใช้ตัวนี้อยู่แล้ว); **ข้อสมมติเดียวกัน** |
| chrono / regex / serde / sha2 / subtle | ❌ ไม่ใช้ | เขียนเองเล็กน้อยแทน (เวลา, ตรวจไบต์, เทียบเวลาคงที่) |
| `cargo fmt` / `cargo clippy` | อยู่ในคำสั่ง gate | `rustfmt.toml` ตั้ง `max_width = 120`, `use_small_heuristics = "Max"` |

## 6. ความต่างที่ยอมรับ (ไม่มี test บังคับ)

- ตัวเลข rule ในผลตอบกลับเป็น `1.0` (Go: `1`) — JSON ค่าเดียวกัน
- path ที่ไม่สะอาด (`//`, `/./`): Go ตอบ 301; Rust ตอบ 404
- escape ผิดรูป (`%zz`): Go ตอบ 400 `text/plain`; Rust ตอบ 400 JSON `VALIDATION_ERROR` (เหมือนภาษาอื่น)
- lone surrogate ใน body: Rust ตอบ 400 (serde_json ปฏิเสธ) แทนที่จะแปลงเป็น U+FFFD แบบ Go — BR-54 อนุญาตทั้งสองแบบ
- ซ้อน JSON เกิน 128 ชั้นเป็น 400 (Go ไม่จำกัดจนกว่าสแตกจะหมด 10,000 ชั้น) — BR-52 บอกว่า "ซ้อนลึก → 400"
