# เปรียบเทียบทั้งห้าภาษา

ตารางจาก [Step 10](../docs/workshop/steps/10-port-other-languages.md) เติมจากข้อมูลจริง ตัวเลขทุกตัวมาจากการรันหรือนับจริง ช่องที่ไม่ได้บันทึกเขียนว่าไม่ได้บันทึก (เวลา)

| | Go (ต้นฉบับ) | TypeScript | Python | Java | Rust |
|---|---|---|---|---|---|
| framework / SQLite | `net/http` / modernc | Fastify / better-sqlite3 | FastAPI / `sqlite3` | Spring Boot **+ Undertow** / sqlite-jdbc | axum / rusqlite (bundled) |
| contract test (333 ข้อ ณ เวลาแปล; ปัจจุบัน 390 ดูท้ายไฟล์) รอบแรกกับ server จริง | ผ่านหลังแก้ Go ให้ตรงสเปก 1 จุด (timestamp) | ผ่านรอบแรก¹ | **ผ่านรอบแรก** | **ผ่านรอบแรก** | **ผ่านรอบแรก** |
| unit test² | 131 | 167 | 296 | 300 | 104 |
| โค้ดไม่รวม test (บรรทัดที่ไม่ใช่ว่าง/comment)³ | 1,471 | 853 | 982 | 1,724 | 1,549 |
| differential vs Go | — | 0 ความต่างหลังแก้ Go 1 จุด | **1 ความต่างจริง (`%2F`)** แก้แล้ว → 0 | 0 | 0 |
| ทดลอง framework ก่อนเขียน handler | — | ใช่ (Fastify) | ใช่ (Starlette) | ใช่ (3 server) **เปลี่ยนการออกแบบ** | ใช่ (axum, serde_json) |
| จำนวน mutation ที่ใช้ได้ / ถูกจับ | ดู lessons/typescript.md | ดู lessons/typescript.md | 64 / 61 (3 equivalent) | 68 / 66 (2 equivalent) | ≈65 / ≈59 (6 equivalent)⁴ |
| gate ที่จับ bug ได้บ่อยสุด | contract + vectors | contract (ที่เพิ่มก่อนแปล) | vectors + contract; **differential** จับ `%2F` | **การทดลองก่อนเขียน**; mutation จับช่องว่างของ test | mutation (จับช่องว่าง test 4 จุด + vectors 1 จุด) |
| bug ที่ AI สร้างซ้ำหลายภาษา | | | `A && B &` kill ไม่ถึงโปรเซส, test oracle ใช้ตรรกะเดียวกับโค้ด | test "11 variants" ผิดแบบเดียวกัน (น้ำหนักรวมเกิน 100), key ตัวพิมพ์ใหญ่ปนกลางไม่มีใน test | เช่นเดียวกัน (ทั้งสามเรื่อง) |
| เวลารวม | ไม่ได้บันทึก | ไม่ได้บันทึก | ไม่ได้บันทึก | ไม่ได้บันทึก | ไม่ได้บันทึก |

¹ ตาม `lessons/typescript.md` (ชุด 305/313 ข้อในเวลานั้น; ชุด 333 ข้อรันซ้ำหลังเพิ่ม test และแก้ Go/TS/mock ผ่านครบ)
² นับ `test`/`it` ที่รายงานโดยเครื่องมือของแต่ละภาษา: **เทียบกันตรงๆ ไม่ได้** (pytest/JUnit นับแต่ละกรณีของ `parametrize`, Go นับ subtest, Rust/TypeScript นับฟังก์ชัน test ที่วนหลายกรณีข้างใน)
³ นับด้วยสคริปต์ง่ายๆ (ตัดบรรทัดว่างและ comment); Rust ตัดส่วน `#[cfg(test)]` ออก; ไม่ใช่ตัวชี้วัดคุณภาพ
⁴ Rust ปัดเป็น "≈" เพราะบาง mutation ถูกเขียนใหม่หลัง `cargo fmt` และบางข้อรันทั้งแบบ unit และ http ดู [`rust.md`](rust.md)

## สิ่งที่เห็นจากการเทียบ

1. **ชุดกลาง (สเปก + vectors + contract) ใช้ได้จริง**: ทั้งสี่ภาษาที่แปลผ่านชุด contract โดยไม่แก้ test ใดๆ และ differential test กับ Go ไม่พบความต่างที่ test ไม่รู้ นอกจาก `%2F` ของ Python
2. **ส่วนที่ยากไม่ใช่ logic แต่คือ "framework ทำอะไรให้เอง"**: ทุกภาษาที่มี framework HTTP ต้องทดลองก่อนว่ามันถอดรหัส path, ตอบ 405/415/413/422, อ่าน body, ตอบ OPTIONS อย่างไร Java เสียมากสุด (เปลี่ยน server และเลิกใช้ controller) Rust เสียน้อยสุด (axum routing ใช้ได้ แต่ห้ามใช้ extractor `Path`)
3. **mutation check จับช่องว่างของ test ที่ AI เขียนเองได้สม่ำเสมอ** ในทั้ง Python, Java, Rust และ SDK: test ที่ผ่านตั้งแต่รอบแรกไม่ได้แปลว่า test ดี
4. **ช่องว่างของชุดกลางที่พบ (รายงานไว้ก่อน เพราะ `CLAUDE.md` ห้ามแก้ `tests/` เอง; ต่อมาผู้ใช้สั่งให้เพิ่มแล้ว = contract 333 → 354 และ vectors 63 → 65 ดู `lessons/summary.md`)**: vector `rollout/variant-targeting-hit-no-user`; contract: path key ที่เข้ารหัสแล้วค้นเจอ flag จริง, p-value ระหว่าง 0.05–0.5, `NaN` ในฟิลด์ที่ไม่รู้จัก, `%zz` → 400, `OPTIONS`/`TRACE`/`/error`/`/docs` → 404, 500 ไม่รั่วรายละเอียด, `;`/`+` ใน query, `PATCH` ที่ path ซึ่งมี `PUT`
5. **ข้อจำกัดของข้อสรุปนี้**: AI ตัวเดียวกันเขียนทั้งการวิเคราะห์ โค้ด และ test ในบทสนทนาเดียว; ไม่ได้ให้คนอื่นทำตามเอกสารเพื่อทดสอบว่าถึงผลเดียวกัน (เกณฑ์ข้อ 4 ของ Step 12) และไม่ได้บันทึกเวลา
6. **หลังเพิ่ม CORS (BR-56) และ BR-57:** contract เป็น 390 ข้อ (`CORS_ORIGINS=https://app.example.com,https://b.example.com`; 388 เมื่อ `*`; 378 เมื่อไม่ตั้ง), unit/lint/build ผ่านทั้งห้าภาษา, differential (Go เทียบแต่ละภาษา, seed 1 และ 2, ภาษาละ 3,000 คำขอ) 0 ความต่าง, `tools/browser-check` (Chromium จริง + bundle SDK) ผ่านทั้ง 6 server. BR-57 แสดงว่าตารางข้างบนยังขาดมิติหนึ่ง: Go/TypeScript/Python ถอดรหัสทุก segment ของ path ส่วน Java/Rust ไม่ (เพราะทดลอง framework แล้วเขียน routing เอง/ใช้ route ที่เทียบ path ดิบ) — ภาษาที่ทดลอง framework ก่อนไม่ต้องแก้ ดู `docs/porting/*-analysis.md` ท้ายไฟล์
7. **ข้อจำกัดที่ยังอยู่ (ซื่อสัตย์):** กรณี 5xx ของ CORS ทดสอบจากภายนอกไม่ได้ (มีแค่ unit test ต่อภาษา); ผู้เขียนกับผู้รีวิวรอบแรกเป็นโมเดลเดียวกัน; รีวิวอิสระใน session ใหม่โดยผู้ใช้ **กำลังดำเนินการ ยังไม่เสร็จ**
