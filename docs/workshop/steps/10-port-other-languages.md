# Step 10: แปลเป็น Python, Java และ Rust

> ✅ **ทดสอบแล้ว:** ทำจริงครบทั้งสามภาษา ตัวเลขและบทเรียนอยู่ใน [`lessons/python.md`](../../../lessons/python.md), [`lessons/java.md`](../../../lessons/java.md), [`lessons/rust.md`](../../../lessons/rust.md) และตารางเปรียบเทียบใน [`lessons/comparison.md`](../../../lessons/comparison.md) (ข้อจำกัด: AI ตัวเดียวกันเขียนทั้งรายงานก่อนแปล โค้ด และ test ในบทสนทนาเดียว ไม่ได้ให้คนอื่นลองทำตามเอกสาร และไม่ได้บันทึกเวลา)

**เป้าหมาย:** ใช้วงจรเดียวกับ [Step 9](09-port-typescript.md) กับอีกสามภาษา และเปรียบเทียบว่าภาษาไหนยากตรงไหน
**เวลา:** 45 นาทีต่อภาษา (ตัวเลขเดิม ยังไม่ได้วัดจริง) · **ก่อนหน้า:** [Step 9](09-port-typescript.md) · **ถัดไป:** [Step 11](11-js-sdk.md)

## ลำดับที่ทำ

| ลำดับ | ภาษา | เหตุผล | ผล |
|---|---|---|---|
| 0 | (ก่อนแปล) | รัน `spec-ambiguity-check python` แล้วเติมสเปกและ test **ก่อนเขียนโค้ดภาษาใหม่** | แก้สเปก BR-52/54/55 + `evaluation.md` 3.1, เพิ่ม contract 20 ข้อ (313 → 333) และ vectors 6 แถว; Go, TypeScript และ mock ล้มตามที่คาดและถูกแก้ |
| 1 | **Python** | กับดัก `bool` กับ `int`, `NaN`, lone surrogate, `compare_digest` | contract 333/333 รอบแรก; differential พบ `%2F` (ข้อเดียวที่ contract ไม่มี) |
| 2 | **Java** | โครงสร้างชัด framework ทำเยอะ | **ทดลอง HTTP server ก่อนเขียน handler → เปลี่ยน Tomcat เป็น Undertow และเลิกใช้ Spring MVC controller**; contract 333/333 รอบแรก |
| 3 | **Rust** | ห่างจาก Go สุด | compile ผ่านรอบแรก ไม่มี borrow checker ปัญหา; contract 333/333 รอบแรก; ห้ามใช้ extractor `Path` ของ axum |

**ทำทีละภาษา** เพราะบทเรียนจากภาษาก่อนหน้าถูกใช้กับภาษาถัดไปจริง (เช่น Java และ Rust ทดลอง `%FF`/`%2F`/`;`/`%zz`/OPTIONS ก่อนเขียน handler เพราะ TypeScript และ Python เจอมาแล้ว)

## ขั้นตอนต่อภาษา (เหมือน step 9)

1. [Step 8](08-pre-port-analysis.md): รายงานก่อนแปลใน `docs/porting/<lang>-analysis.md` — **ทดลอง framework กับ input ตรงขอบเสมอ** (ไม่เดาจากความจำ)
2. สร้างโครงโปรเจกต์ที่ build/lint/test ผ่านก่อนมีโค้ด
3. แปลทีละ layer `model → evaluation → repository → service → handler → main` (ตัวอย่างข้างล่างทำโดยบอก AI เป็นรอบเดียวต่อภาษา เพราะ layer เล็กและมี vectors ตัดสิน)
4. รันทั้งชุด gate ([`CONVENTIONS.md`](../../../CONVENTIONS.md)) แล้ว **contract test กับ server จริง ทีละตัว**
5. **mutation check** ([`tools/mutation-check/`](../../../tools/mutation-check)): ใส่ bug ทีละจุดแล้วดูว่า test จับไหม; mutation ที่รอด = test ขาด (หรือ mutation ซ้ำซ้อน: ตรวจให้แน่ใจก่อนว่าเปลี่ยนพฤติกรรมจริง)
6. **differential test** vs Go (`tools/diff-servers`) หลาย seed
7. เขียน `lessons/<lang>.md` แล้วปรับ `CONVENTIONS.md`

## คำสั่ง gate ที่ทดสอบจริงแล้ว

| ภาษา | build | lint | unit test | เริ่ม server |
|---|---|---|---|---|
| Python | `python -m compileall -q app tests` | `ruff check . && ruff format --check .` | `pytest` | `python -m app.main` |
| Java | `mvn -q -DskipTests package` | `mvn -q checkstyle:check` | `mvn -q test` | `java -jar target/ffservice.jar` |
| Rust | `cargo build` | `cargo fmt --check && cargo clippy --all-targets -- -D warnings` | `cargo test` | `cargo run --release` |

อ่านรายละเอียด (ติดตั้ง venv, ข้อสมมติเรื่อง dependency) ใน README ของแต่ละโฟลเดอร์และ [`CONVENTIONS.md`](../../../CONVENTIONS.md)

## สิ่งที่พลาดจริง แยกตามภาษา (ตรงกับที่คาดไว้ใน step 8 / ไม่ตรง)

| ภาษา | กับดักตัวเลข/ข้อความที่เจอ | สิ่งที่ framework ทำเองและขัดสเปก | ตัวจับ |
|---|---|---|---|
| **Python** | `& 0xFFFFFFFF` ต้อง mask เอง; **`True == 1`**; `json.loads` รับ `NaN`; lone surrogate (`"\ud800"`) ทำให้ encode ไม่ได้; `hmac.compare_digest(str)` crash กับ non-ASCII; `$`/`\d` ของ `re` | Starlette: `query_params.get` คืน**ค่าสุดท้าย**, redirect `/x/` → 307, `/docs` เปิดอยู่, handler ของ `Exception` ส่ง response แล้ว **raise ซ้ำ**, **ถอดรหัส `%2F` ก่อน routing** | vectors, contract, differential (`%2F`) |
| **Java** | `byte` มีเครื่องหมายใน FNV; `String.getBytes` แทน lone surrogate ด้วย `?`; `Double.equals` (0.0 ≠ -0.0); `1e999999999999` โยน `NumberFormatException`; Jackson อ่าน `byte[]` แล้ว**เดา UTF-16** และไม่ปฏิเสธข้อมูลท้ายโดยปริยาย | **Tomcat/Jetty ตอบ 400 (HTML) กับ `%FF`, `%00`, `%2F` ก่อนโค้ดเรา**; Spring MVC ตัด `;param`, ตอบ `OPTIONS` 200 เอง, `GET /error` เป็น JSON ของ Boot | การทดลองก่อนเขียน handler, contract, mutation |
| **Rust** | `*` panic ใน debug / wrap ใน release → `wrapping_mul`; `u16::from_str("+80")`; `HashMap` ลำดับไม่คงที่ | extractor `Path`/`RawPathParams` ของ axum **ตอบ 400 กับ `%FF` เอง**; 405 ต้องแปลงเป็น 404; panic ใน handler ปิด connection เงียบๆ | การทดลอง `rustprobe`, contract, mutation |

หมายเหตุ: **ผลสุดท้ายต่างจากที่ร่างไว้ก่อนทำ**: ร่างเดิมคาดว่า pydantic/Jackson จะแปลง `"50"` เป็น `50` และ Rust จะมีปัญหา borrow checker ซึ่งไม่ใช่ทั้งสองข้อ (เราไม่ใช้ pydantic รับ body; โครงสร้าง generic + closure ที่ยืม `&dyn Tx` ไม่ต้อง `.clone()` เพื่อเลี่ยง borrow) ปัญหาจริงคือ **HTTP stack ถอดรหัส path ก่อนถึงโค้ด**

## บทเรียนที่ส่งต่อภาษาถัดไปได้ (สรุปจากสามภาษา)

- **ทดลอง framework ก่อนเลือกโครงสร้าง**: ส่ง `%FF`, `%00`, `%2F`, `;`, `%zz`, `PATCH`/`OPTIONS`/`TRACE`/`HEAD`, header ไบต์ Latin-1, body UTF-16/invalid UTF-8/NaN/ซ้อนลึก/เลขยาวมาก, panic ใน handler ถ้า framework ทำให้ไม่ได้ ให้เปลี่ยน server หรือ routing เอง (Java)
- **test ที่ผ่านรอบแรกยังไม่ใช่ test ที่ดี**: mutation check พบ test ที่ผมเขียนผิด 3 แบบซ้ำใน 3 ภาษา — oracle ที่ใช้ตรรกะเดียวกับโค้ด, กรณี "ล้ม" ที่ล้มด้วยเหตุผลอื่น (11 variants ที่น้ำหนักรวมเกิน 100 ถูกปฏิเสธเพราะผลรวม), กรณีที่ไม่ครอบคลุมตัวพิมพ์ใหญ่ปนกลาง
- **differential test กับต้นฉบับยังจำเป็น** แม้ contract 333 ข้อผ่าน (Python: `%2F`) และ **ไม่พบอะไรเลยก็เป็นข้อมูล**: Java และ Rust 0 ความต่างเพราะการทดลองก่อนเขียนครอบคลุมแล้ว
- รายงานช่องว่างของ vectors/contract ที่พบ แต่ **อย่าแก้ `tests/` เอง** ถ้ากติกาโปรเจกต์ห้าม: ดู `lessons/comparison.md` ข้อ 4

## ข้อควรระวัง

- ถ้า **bug เดียวกันเกิดในทุกภาษา** ให้สงสัยสเปกหรือ test ก่อนสงสัย AI
- Rust: ถ้า AI แก้ borrow checker ด้วย `.clone()` หรือ `Arc<Mutex<...>>` ทุกที่ ให้ถามว่า "ออกแบบ ownership ให้ไม่ต้องใช้ได้ไหม" ใน idiomatic pass แต่ **หลังจาก** test ผ่านแล้วเท่านั้น (รอบนี้ไม่เกิดขึ้น)
- อย่าเปรียบเทียบความเร็วของภาษาด้วยโค้ดชุดนี้ มันไม่ได้ออกแบบมาเพื่อวัด performance
