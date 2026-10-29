# Lessons: Rust

บันทึกหลังแปล Go → Rust (Step 10) ตามแม่แบบของ [Step 12](../docs/workshop/steps/12-retrospective.md) ตัวเลขทุกตัวมาจากการรันจริงใน session ที่สร้าง เวลาไม่ได้บันทึก "รอบ" = จำนวนครั้งที่รัน gate จนผ่าน

> **ข้อควรทราบ:** AI ตัวเดียวกันเขียนทั้งรายงานก่อนแปลและโค้ด เช่นเดียวกับ [`typescript.md`](typescript.md), [`python.md`](python.md) และ [`java.md`](java.md)

## ตัวเลข

| ขั้น | รอบ | gate ที่จับได้ | หมายเหตุ |
|---|---|---|---|
| ทดลอง axum/serde_json ก่อนเขียน handler | 2 โปรเจกต์ทิ้ง | `curl --path-as-is`, โปรแกรม `rustprobe` | ใช้ routing ของ axum ได้ แต่ห้ามใช้ `Path`/`RawPathParams` (ตอบ 400 กับ `%FF` เอง) |
| model, evaluation, erfc, timefmt | 1 | cargo build | ผ่านรอบแรก |
| parse, repository, service, handler, main | 1 | cargo build | **compile ผ่านรอบแรก** ไม่มี borrow checker error ที่ต้องแก้ (ออกแบบ `Service<R: Repository>` แบบ generic, `transaction(impl FnOnce(&dyn Tx))`) |
| contract | 1 | **333/333 ผ่านรอบแรก** (debug) และซ้ำกับ release build | รันทีละ server |
| fmt + clippy (`-D warnings`, `--all-targets`) | 1 | `cargo fmt --check`, `cargo clippy` | ตั้ง `rustfmt.toml` ก่อนรัน `cargo fmt` ครั้งแรก (ค่าปริยาย 100 คอลัมน์จะเขียนใหม่ทั้งไฟล์) |
| unit test | 1 | `cargo test` | 73 (lib) + 27 (HTTP) + 4 (vectors) ผ่านรอบแรกทั้งหมด |
| differential vs Go | 1 | `diff-servers` (release build) | **0 ความต่าง** seed 1–3 (3,000), 11–12 (8,000) และ Java↔Rust seed 41 (4,000) |

ทั้งสี่ภาษาที่แปลหลังต้นฉบับ (TypeScript, Python, Java, Rust) ผ่านชุด contract **โดยไม่แก้ test ใดๆ**; ที่ใช้เวลา/รอบมากสุดคือ **ทดลอง HTTP stack ก่อนเขียน handler** (Java) ไม่ใช่การแปล logic

## ความเสี่ยงที่ทำนายไว้ ([`rust-analysis.md`](../docs/porting/rust-analysis.md))

| ความเสี่ยง | เกิดจริงไหม | จับได้ด้วย |
|---|---|---|
| `*` ธรรมดา panic ใน debug / wrap เงียบใน release | ป้องกันตั้งแต่ต้น (`wrapping_mul`) | unit test ที่รันใน debug: mutation `h * FNV_PRIME` ถูกจับ 3 ข้อ |
| extractor ของ axum ตอบ 400 กับ `%FF` | **เกิดจริง** (ทดลอง) | `tests/http.rs` + contract BR-55; mutation "ไม่ถอดรหัส key" ถูกจับหลังเพิ่ม test (ดูข้างล่าง) |
| `u16::from_str("+80")` ยอมรับ `+` | ป้องกันตั้งแต่ต้น | `config::tests` (mutation ถูกจับ) |
| panic ใน handler ทำให้ connection ปิดเงียบ | **เกิดจริงในการออกแบบ** (ไม่ได้ทดสอบโดยไม่มี guard) | `a_panic_in_a_handler_is_an_opaque_500…` (mutation ลบ `tokio::spawn` ถูกจับ) |
| mutex ถูก poison หลัง panic ใน transaction | ป้องกันตั้งแต่ต้น | mutation `.unwrap()` แทน `into_inner` ถูกจับ |
| `HashMap` ลำดับไม่คงที่ | ป้องกัน (`BTreeMap`) | — |

## AI พลาดอะไร

| อาการ | สาเหตุจริง | แก้อย่างไร | ควรป้องกันที่ไหน |
|---|---|---|---|
| ไม่มี test ที่ตรวจว่า "ข้ามการตรวจ user id เมื่อมี rule" | **vectors ใช้ร่วมกันขาด**: ทุก vector ที่มี rule และไม่มี userId ล้มที่ targeting ก่อนอยู่แล้ว mutation ที่ข้ามการตรวจนั้นเมื่อมี rule จึงรอดจาก vectors และ contract | เพิ่ม unit test ใน Rust | **เสนอเพิ่ม vector** `rollout-targeting-hit-no-user` / `variant-targeting-hit-no-user` (ไม่ได้ทำ: `CLAUDE.md` ห้ามแก้ `tests/vectors/` เว้นแต่งานสั่ง) |
| test ของ "11 variants ถูกปฏิเสธ" ไม่ได้ทดสอบเลย | ผมใช้ 10 ตัวน้ำหนัก 10 + 1 ตัวน้ำหนัก 1 = 101 ถูกปฏิเสธเพราะ**ผลรวม**ไม่ใช่เพราะ**จำนวน** (ในภาษาก่อนหน้า Python/Java ผมเขียนผิดแบบเดียวกัน) | ใช้ 11 ตัวที่ผลรวม 100; แก้ test ของ Python และ Java ด้วย | review test: ตรวจว่ากรณี "ล้ม" ล้มด้วยเหตุผลที่ตั้งใจ |
| test key ไม่มีตัวพิมพ์ใหญ่ปนกลาง (`aB`) | ใช้เฉพาะ `A` เดี่ยว ซึ่งถูกปฏิเสธโดยกฎ "ตัวแรก" | เพิ่ม `aB`, `Ab`, `a-B` ในทั้ง Rust, Python, Java | mutation จับได้ (survived → test) |
| ไม่มี test "path key ที่เข้ารหัสแล้วต้องถอดรหัสก่อนค้น" | key ที่ใช้ทดสอบทุกตัวเป็นตัวที่ไม่มี flag อยู่จริง (404 ไม่ว่าถอดหรือไม่ถอด) mutation ที่ไม่ถอดรหัสจึงรอดทั้ง contract และ unit | เพิ่ม test `a%2Db` → flag `a-b` ใน 3 ภาษา | **ช่องว่างของ contract ที่ใช้ร่วมกัน** (ดูข้างล่าง) |
| mutation "events ไม่ atomic" รอดครั้งแรก | ผมเขียน mutation ผิด: commit transaction ว่างแล้วเริ่มใหม่ ซึ่งยัง atomic อยู่ | เขียนใหม่ให้ commit หลังแต่ละ event → ถูกจับ | mutation ที่ดีต้องพิสูจน์ก่อนว่ามัน *เปลี่ยนพฤติกรรม* จริง |
| `cargo fmt` จัดบรรทัดใหม่ทำให้ pattern ของ mutation 4 ข้อหาไม่เจอ ("NOT APPLIED") | สคริปต์ mutation จับคู่ข้อความ ไม่ใช่ AST | แก้ pattern และรันซ้ำ; สคริปต์รายงาน "NOT APPLIED" ไม่เงียบ | ออกแบบเครื่องมือให้ล้มดังๆ (ทำแล้ว) |

## เรื่องที่ไม่ได้ทำนายไว้

1. **ไม่มี borrow checker ปัญหา**: ตรงข้ามกับที่ step 10 คาดไว้ ไม่มี `.clone()` เพื่อเลี่ยง borrow ในโค้ด (มีแค่ clone ของ `String` ที่ต้องเป็นเจ้าของจริง) เพราะแยก `Service<R>` กับ `Repository` เป็น trait ตั้งแต่ต้น และ `transaction` รับ closure ที่ยืม `&dyn Tx`
2. **serde_json ปฏิเสธ lone surrogate (`"\ud800"`)** แทนที่จะแปลงเป็น U+FFFD แบบ Go: สเปก BR-54 อนุญาต (400 ได้) จึงไม่ต้องทำอะไร แต่เป็นความต่างที่ test ต้องรองรับทั้งสองทาง
3. **ซ้อน JSON เกิน 128 ชั้นเป็น 400** (limit ของ serde_json): ถูกกว่าที่ BR-52 ต้องการ ("ซ้อนลึก → 400")

## สถิติ mutation

ใช้ [`tools/mutation-check/rust.sh`](../tools/mutation-check/rust.sh) (`unit` = `cargo test`, `http` = contract กับไบนารีที่ถูกแก้)

| ชุด | ที่รัน | ผล |
|---|---|---|
| unit รอบแรก (56) | 50 ที่ใช้ได้ (4 "NOT APPLIED" หลัง `cargo fmt`, 2 compile ไม่ผ่าน) | killed 44; **รอด 6**: ข้ามตรวจ userId เมื่อมี rule (gap ของ vectors), 11 variants (test ผิด), events atomic (mutation ผิด), และ 3 ข้อ equivalent: `Scalar` รับ `Infinity` (serde_json ผลิตไม่ได้), เลข Unicode ใน timestamp (ตำแหน่งไบต์คงที่ไม่ยอมให้ผ่าน), `p <= 0.05` |
| unit รอบสอง (8 mutation ที่ต้องเขียน/รันใหม่) | 8 | killed 7; 1 equivalent: ตัวแรกของ key เป็นตัวพิมพ์ใหญ่ (`all()` ตรวจทุกตัวรวมตัวแรกอยู่แล้ว) |
| http (18 ที่ใช้ได้ + 1 compile ไม่ผ่านแล้วเขียนใหม่) | 19 | killed โดย contract 9; **contract ไม่ kill 10**: ถูก unit/`tests/http.rs` kill 7 (500 รั่ว, `%zz`, `;` ใน query, `+` ใน query, ไม่ถอดรหัส key [หลังเพิ่ม test], ไม่มี guard task, transaction ไม่ rollback), equivalent 2 (`&& false`, `+` เป็น space ใน path: ไม่มี key ที่ถูกต้องมี `+`), และ utf-8 (ถูก kill เมื่อเขียนใหม่) |

รวม 6 equivalent: `Scalar` Infinity, เลข Unicode, `<=`, ตัวแรกพิมพ์ใหญ่, `&& false`, `+` ใน path

## สิ่งที่จะเปลี่ยน

- **CONVENTIONS.md:** แถว Rust ใช้ `cargo build` / `cargo fmt --check && cargo clippy --all-targets -- -D warnings` / `cargo test` / `cargo run --release` (ทดสอบจริงแล้ว); เพิ่ม tokio, serde_json, http-body-util เป็นข้อสมมติที่ต้องยืนยัน
- **ช่องว่างของชุดกลางที่พบด้วย mutation (เสนอ ยังไม่ได้ทำ เพราะ `CLAUDE.md` ห้ามแก้ `tests/vectors/` และ `tests/contract/`):**
  1. vectors: `rollout-targeting-hit-no-user`, `variant-targeting-hit-no-user` (rule ตรง, ไม่มี userId, rollout < 100 หรือมี variants → `MISSING_USER_ID`)
  2. contract: path key ที่เข้ารหัสแล้วต้องเจอ flag จริง (`/v1/flags/a%2Db`), p-value ระหว่าง 0.05–0.5, `NaN` ในฟิลด์ที่ไม่รู้จัก, `%zz` → 400, `OPTIONS`/`TRACE`/`/error`/`/docs` → 404, 500 ไม่รั่วรายละเอียด, `;`/`+` ใน query
