# Lessons: Java

บันทึกหลังแปล Go → Java (Step 10) ตามแม่แบบของ [Step 12](../docs/workshop/steps/12-retrospective.md) ตัวเลขทุกตัวมาจากการรันจริงใน session ที่สร้าง เวลาไม่ได้บันทึก "รอบ" = จำนวนครั้งที่รัน gate จนผ่าน

> **ข้อควรทราบ:** AI ตัวเดียวกันเขียนทั้งรายงานก่อนแปลและโค้ด เช่นเดียวกับ [`typescript.md`](typescript.md) และ [`python.md`](python.md) จึงไม่ใช่หลักฐานว่า prompt ในเอกสารให้ผลเท่ากันกับ AI ตัวอื่น

## ตัวเลข

| ขั้น | รอบ | gate ที่จับได้ | หมายเหตุ |
|---|---|---|---|
| ทดลอง HTTP server ก่อนเขียน handler | 4 server | `curl --path-as-is` | **เปลี่ยนการออกแบบ**: Tomcat/Jetty ปฏิเสธ `%FF`/`%00` ก่อนถึงโค้ด → Undertow; Spring MVC จัดการ `;`, OPTIONS, TRACE ผิด → เลิกใช้ controller (ดู analysis ข้อ 4) |
| model, evaluation, Scalars | 1 | vectors (63 + 300 + 11 + 37) | ผ่านรอบแรก |
| repository, service, Parse, Erfc | 1 | compile + unit | ผ่านรอบแรก |
| handler | 3 | compile, unit | ล้ม: `OPTIONS` ตอบ 200 (Spring), `/error` ตอบ JSON ของ Boot (`status:999`), annotation ห้ามใส่ `"0".repeat(5000)` (compile) → เปลี่ยนเป็น servlet filter |
| contract | 1 | **333/333 ผ่านรอบแรก** (และซ้ำหลังเปลี่ยนเป็น filter) | รันทีละ server ตามบทเรียนก่อนหน้า |
| lint (checkstyle) | 2 | `mvn checkstyle:check` | 37 ข้อ ล้วนเป็นบรรทัดยาว; ตั้งให้ test ผ่อนเรื่องความยาวบรรทัด (ตารางข้อมูล) แต่โค้ดไม่ผ่อน |
| unit test | 4 | `mvn test` | ล้ม: `café.db` สร้างไม่ได้ใน locale POSIX (ข้อจำกัดของสภาพแวดล้อม, ตัดออกพร้อมเหตุผล), 2 test ของผมเอง (audit ของ key ซ้ำข้าม test, `/error`) |
| differential vs Go | 1 | `diff-servers` | **0 ความต่าง** seed 1–3 (3,000), 11–12 (8,000) และ Python↔Java seed 31 (4,000) |

ต่างจาก Python: differential ไม่พบอะไรใหม่ เพราะบทเรียน `%2F` ถูกใช้ตอนทดลอง HTTP server แล้ว (ทดลอง `%2F` เป็นหนึ่งในกรณีของตารางข้อ 4)

## ความเสี่ยงที่ทำนายไว้ ([`java-analysis.md`](../docs/porting/java-analysis.md) ข้อ 5)

| ความเสี่ยง | เกิดจริงไหม | จับได้ด้วย |
|---|---|---|
| 1. HTTP server ถอดรหัส path ก่อนถึงโค้ด | **เกิดจริงและใหญ่ที่สุด** (Tomcat, Jetty) | การทดลอง `curl` ก่อนเขียน; contract BR-55 จะล้มบน Tomcat/Jetty (ไม่ได้รันซ้ำบนสองตัวนั้นหลังเขียนโค้ดเสร็จ — เป็นการอนุมานจากผลทดลอง) |
| 2. Jackson เดา encoding / ไม่ปฏิเสธข้อมูลท้าย | เกิดจริง (ยืนยันด้วย `JacksonFacts.java`) | ป้องกันตั้งแต่ต้น; mutation ที่ให้ Jackson อ่าน byte **ใช้พิสูจน์ไม่ได้** (ทำให้ทุกอย่างพังด้วยเหตุอื่น) จึงอ้างผลทดลองตรงๆ แทน |
| 3. `getBytes` เปลี่ยน lone surrogate เป็น `?` | ป้องกันตั้งแต่ต้น | contract + `ApiTest` (mutation: ไม่ล้าง surrogate ถูกจับ 2 ข้อ) |
| 4. `byte` มีเครื่องหมายใน FNV | ป้องกันตั้งแต่ต้น | vectors (mutation ถูกจับ 6 ข้อ) |
| 5. `Double.equals` | ป้องกันตั้งแต่ต้น | `EvaluationTest` (mutation ถูกจับ) |
| 6. transaction ค้างเมื่อเกิด `Error` | ป้องกันตั้งแต่ต้น | `aTransactionThatThrowsAnErrorDoesNotStrandTheConnection` (mutation `catch (RuntimeException)` ถูกจับ) |
| 7. สอง thread ใช้ connection เดียว | ป้องกันตั้งแต่ต้น | `concurrentWritersDoNotCorruptState` (mutation ลบ lock ถูกจับ) |

## AI พลาดอะไร

| อาการ | สาเหตุจริง | แก้อย่างไร | ควรป้องกันที่ไหน |
|---|---|---|---|
| ตั้งใจใช้ `@RestController` + `@PathVariable` ตามธรรมเนียม Spring | ธรรมเนียมของ framework ขัดกับสเปกหลายจุด (ข้อ 4) ผมรู้ว่ามี `%2F` ปัญหาแต่ไม่รู้ว่ามี OPTIONS/`/error`/`;` อีก | ทดลองก่อน แล้วเปลี่ยนเป็น servlet filter ที่ routing เอง | **ทดลอง framework กับ input ตรงขอบก่อนเลือกโครงสร้าง** — ตรงกับบทเรียน TypeScript; ควรเป็นข้อบังคับใน skill `port-layer` |
| `OPTIONS /v1/flags` ตอบ 200 ว่าง และ `GET /error` ตอบ JSON ของ Boot | ผมทดสอบ unknown route หลายตัวแต่ไม่ได้ใส่ `OPTIONS` และ `/error` จน test `br53` ล้ม | filter ตอบเองทั้งหมด + ใส่ทั้งสองในรายการ test | ใส่ `OPTIONS`, `TRACE`, `/error`, `/actuator/*`, `/docs` ใน contract ถ้าจะให้ภาษาต่อไปจับได้ก่อน (เสนอ ยังไม่ได้ทำ) |
| `application.properties` ที่ตั้ง `allow-encoded-slash=true` ไม่มีผลเลย | เมื่อ `decode-url=false` ตัวเลือกนี้ไม่ถูกใช้ ผมใส่ตามที่ลองครั้งแรก mutation รอดทั้งใน contract และ unit | ลบทิ้ง (ตัวเลือกที่ไม่มีผลคือภาระ) | mutation check ใช้ตรวจ "config ที่ไม่มีผล" ได้ด้วย |
| `ParseTest` ของ `br01KeyFormat` ใช้ regex เดียวกับโค้ดเป็นตัวตัดสิน | test ที่คำนวณคำตอบด้วยตรรกะเดียวกับโค้ดคือ test ที่ผ่านเสมอ | เปลี่ยนเป็นรายการ key ที่ถูก/ผิดแบบเขียนตรงๆ | review test: ถ้า oracle ใช้ implementation เดียวกันให้เปลี่ยน |
| `Scalars.of(Double.POSITIVE_INFINITY)` ไม่มี test | ทางเข้าจริง (JSON) ให้ `BigDecimal` เสมอ ส่วน `Number` อื่นไม่เคยถึง จึงไม่มีใคร test | เพิ่ม `ScalarsTest` | mutation จับได้ (survived → test) |
| รอบที่ mutation "ให้ Jackson อ่าน byte" kill 187 ข้อ | mutation ที่ออกแบบแย่: เปลี่ยน charset ของทุก body → ล้มทุกอย่าง ไม่พิสูจน์ว่า test กัน UTF-16 | ไม่นับ | mutation ที่ดีต้องเปลี่ยนจุดเดียวที่ต้องการวัด |
| ผมรัน `mvn test` ใน `java/` ขณะ batch mutation กำลังรัน | mutation ใช้สำเนาใน `/tmp` จึงไม่ชนกัน แต่เสี่ยง | — | รันเครื่องมือที่ใช้พอร์ต/ไฟล์ร่วมกันทีละตัว |

## เรื่องที่ไม่ได้ทำนายไว้

1. **Spring MVC ไม่เหมาะกับสเปกที่ขึ้นกับ path ดิบ**: ทั้งชั้นถูกออกแบบใหม่ ผลคือ `Api` (filter) + `Router` ~100 บรรทัดแทน controller
2. **JVM ใน locale POSIX ตั้งชื่อไฟล์ non-ASCII ไม่ได้** (`sun.jnu.encoding=ANSI_X3.4-1968`) — ข้อจำกัดของสภาพแวดล้อมที่มีผลกับ `DB_PATH`
3. **`1e999999999999`** ให้ `NumberFormatException` (ไม่ใช่ `JsonProcessingException`) — ถ้าจับเฉพาะ Jackson exception จะเป็น 500

## สถิติ mutation

ใช้ [`tools/mutation-check/java.sh`](../tools/mutation-check/java.sh) (`unit` = `mvn test`, `http` = contract กับ jar ที่ถูกแก้)

| ชุด | ที่รัน | ผล |
|---|---|---|
| unit (evaluation, Scalars, Parse, FlagService, Erfc, SqliteRepository) | 48 ที่ใช้ได้ (อีก 1 compile ไม่ผ่านจึงทำใหม่) | killed 46 ทันที; **รอด 2**: `Scalars.of` รับ `Infinity` (→ เพิ่ม `ScalarsTest` → killed) และ `p <= 0.05` (equivalent) |
| http (Api, Router, Query, Auth, ErrorCode, application.properties) | 20 ที่ใช้ได้ (อีก 1 ไม่นับ — ดูตาราง AI พลาด) | killed โดย contract 13; **contract ไม่ kill 7**: 500 รั่วรายละเอียด, `%zz`, `;` ใน query, `+` ใน query, `PATCH` ถูกจับคู่เป็น `PUT`, `decode-url=true`, `allow-encoded-slash=false` |
| 7 ข้อที่ contract ไม่ kill | | killed โดย unit ทันที 3 (`%zz`, `;`, `decode-url`); killed หลังเพิ่ม test 3 (500 รั่ว, `+`, `PATCH`); **equivalent 1** (`allow-encoded-slash` ไม่มีผลเมื่อ `decode-url=false` → ลบ property) |

รวม 68 = 48 + 20; killed 66, equivalent 2 (`<=`, `allow-encoded-slash`)

## สิ่งที่จะเปลี่ยน

- **CONVENTIONS.md:** แถว Java ใช้ `mvn -q -DskipTests package` / `mvn -q checkstyle:check` / `mvn -q test` / `java -jar target/ffservice.jar` (ทดสอบจริงแล้ว); ระบุ Undertow เป็นข้อสมมติที่ต้องยืนยัน
- **skill `port-layer`:** เพิ่มขั้น "ทดลอง framework กับ path ที่มี `%FF`, `%00`, `%2F`, `;`, `%zz`, OPTIONS, TRACE, `/error` ก่อนเลือกโครงสร้าง handler"
- **ช่องว่างของ contract ที่ใช้ร่วมกัน (เสนอ ยังไม่ได้ทำ เพราะ `CLAUDE.md` ห้ามแก้ `tests/contract/`):** รายการเดียวกับ Python + `500 ไม่รั่ว`, `%zz → 400`, `PATCH ที่ path ซึ่งมี PUT`, `+`/`;` ใน query, `OPTIONS`/`TRACE`/`/error`
