# Step 10: แปลเป็น Python, Java และ Rust

> ⏳ **ฉบับร่าง:** ตาราง "กับดัก" และคำสั่งเป็นการคาดการณ์จากธรรมชาติของแต่ละภาษา ยังไม่ได้ยืนยันด้วยการแปลจริง ให้ตรวจกับรายงานของ step 8 และอัปเดตเอกสารนี้หลังทำจริง

**เป้าหมาย:** ใช้วงจรเดียวกับ [Step 9](09-port-typescript.md) กับอีกสามภาษา และเปรียบเทียบว่าภาษาไหนยากตรงไหน
**เวลา:** 45 นาทีต่อภาษา · **ก่อนหน้า:** [Step 9](09-port-typescript.md) · **ถัดไป:** [Step 11](11-js-sdk.md)

## ลำดับที่แนะนำ

| ลำดับ | ภาษา | เหตุผล |
|---|---|---|
| 1 | **Python** | แปลง่ายสุดหลัง TypeScript แต่มีกับดักเรื่อง `bool` กับ `int` ที่สอนได้ดี |
| 2 | **Java** | โครงสร้างชัด ต่างจาก Go ตรง exception และ framework ที่ทำเยอะเอง |
| 3 | **Rust** | ห่างจาก Go สุด (ownership, ไม่มี exception, wrap integer ต้องบอกเอง) ทำท้ายสุดเพื่อให้บทเรียนจากสามภาษาแรกพร้อมแล้ว |

**ทำทีละภาษาเท่านั้น** (ไม่ขนานกัน) เพราะบทเรียนและ prompt ที่ปรับแล้วจาก `lessons/<ภาษาก่อนหน้า>.md` ต้องเอาไปใช้กับภาษาถัดไป

## ขั้นตอนต่อภาษา (เหมือน step 9)

1. [Step 8](08-pre-port-analysis.md): รายงานก่อนแปล แล้วคุณอนุมัติ
2. สร้างโครงโปรเจกต์ (build, lint, test ผ่านโดยยังไม่มีโค้ด)
3. `/port-layer <lang> <layer>` ทีละ layer ตามลำดับ `model → evaluation → repository → service → handler → main`
4. รัน `/verify-gates <lang>`
5. Idiomatic pass → diff review เทียบกับ Go และกับภาษาก่อนหน้า
6. เขียน `lessons/<lang>.md` แล้ว **ปรับ** `CONVENTIONS.md`, skill และ prompt ก่อนเริ่มภาษาถัดไป

## สิ่งที่คาดว่าจะพลาดแยกตามภาษา (คาดการณ์)

| ภาษา | กับดักตัวเลข/ข้อความ | สิ่งที่ framework ทำเองและขัดสเปก | ตัวจับ |
|---|---|---|---|
| **Python** | `(h * 16777619) & 0xFFFFFFFF` ต้อง mask เอง (int ไม่ล้น); `s.encode("utf-8")`; **`True == 1`** (bool เป็น subclass ของ int) ทำให้ `true` เท่ากับ `1` ใน rule | pydantic แปลง `"50"` เป็น `50` ได้เอง; FastAPI ตอบ 422 ตอน validation ผิด | `target-eq-bool-vs-string`, `rolloutPercent` เป็น string |
| **Java** | `int` มีเครื่องหมาย ใช้ `Integer.toUnsignedLong` ก่อน `% 10000`; `String.length()` นับ UTF-16 ใช้ `codePointCount`; `getBytes(UTF_8)` | Jackson แปลง `"true"` เป็น boolean และเลขทศนิยมเป็น int ได้ตามตั้งค่า; Spring ตอบรูปแบบ error ของตัวเอง | bucketing, test "500 emoji", validation tests |
| **Rust** | `h.wrapping_mul(16777619)` ไม่งั้น panic ใน debug; `s.as_bytes()` เป็น UTF-8 อยู่แล้ว; `chars().count()` สำหรับ code point; ตัวเลข JSON เป็น `i64/u64/f64` (10 กับ 10.0) | axum ปฏิเสธ body ผิดด้วยข้อความ/รูปแบบของตัวเอง ต้องทำ error handler เอง; `rusqlite::Connection` ไม่ `Sync` ต้องออกแบบการแชร์ | ทั้ง vectors และ validation |

หมายเหตุสำหรับทุกภาษา: ให้ AI **ยืนยันด้วยโค้ด** ว่า framework ทำอะไรให้เองบ้างตั้งแต่ step 8 (เขียน test เล็กๆ ที่ส่ง `"50"` ให้ฟิลด์ตัวเลข) ไม่ใช่เดาจากความจำ

## คำสั่ง gate (ข้อเสนอเริ่มต้น เก็บจริงที่ [`CONVENTIONS.md`](../../../CONVENTIONS.md))

| ภาษา | build / lint / unit test | เริ่ม server |
|---|---|---|
| Python | `ruff check . && ruff format --check . && pytest` | `uvicorn app.main:app --port 8080` |
| Java | `mvn -q verify` | `java -jar target/*.jar` |
| Rust | `cargo fmt --check && cargo clippy -- -D warnings && cargo test` | `cargo run --release` |

## เปรียบเทียบหลังเสร็จทุกภาษา

เก็บตารางนี้ไว้ใน `lessons/comparison.md`:

| | Go | TypeScript | Python | Java | Rust |
|---|---|---|---|---|---|
| รอบแก้ถึงผ่าน gate (รวมทุก layer) | — | | | | |
| gate ที่จับ bug ได้บ่อยสุด | — | | | | |
| บรรทัดโค้ด (ไม่รวม test) | | | | | |
| bug ที่ AI สร้างซ้ำในหลายภาษา | | | | | |
| เวลารวม | | | | | |

## ข้อควรระวัง

- ถ้า **bug เดียวกันเกิดในทุกภาษา** ให้สงสัยสเปกหรือ test ก่อนสงสัย AI (เช่น สเปกไม่ได้บอกลำดับการตรวจ)
- Rust: ถ้า AI แก้ borrow checker ด้วยการ `.clone()` หรือ `Arc<Mutex<...>>` ทุกที่ ให้ถามว่า "ออกแบบ ownership ให้ไม่ต้องใช้ได้ไหม" ใน idiomatic pass แต่ **หลังจาก** test ผ่านแล้วเท่านั้น
- อย่าเปรียบเทียบความเร็วของภาษาด้วยโค้ดชุดนี้ มันไม่ได้ออกแบบมาเพื่อวัด performance
