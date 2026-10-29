# Lessons: TypeScript

บันทึกหลังแปล Go → TypeScript (Step 9) ตามแม่แบบของ [Step 12](../docs/workshop/steps/12-retrospective.md) ข้อมูลทุกข้อมาจากการรันจริงใน session ที่สร้าง ไม่ใช่การประมาณ

> **ข้อควรทราบ:** ทั้งรายงานก่อนแปลและโค้ดสร้างโดย AI ตัวเดียวกันในบทสนทนาเดียวที่มีบริบท step 1–8 อยู่แล้ว (ไม่ใช่การแยกคนเขียน/คนรีวิว) และ skill ที่สร้างใน step 7 ถูกใช้เป็น "ขั้นตอนที่ทำตามด้วยมือ" เพราะ session นี้เรียกมันผ่าน `Skill` ไม่ได้ ผลที่ได้เป็นหลักฐานว่า **สเปก + test กลาง** ทำงานได้ ไม่ใช่หลักฐานว่า prompt ในเอกสารทำให้ AI ใดๆ ได้ผลเท่ากัน

## ตัวเลข

เวลาไม่ได้บันทึก (ไม่มีตัวจับเวลาใน session) "รอบ" = จำนวนครั้งที่รัน gate ของ layer จนผ่าน

| layer | รอบ | gate ที่จับได้ | หมายเหตุ |
|---|---|---|---|
| model | 1 | build | ไม่มี logic |
| evaluation | 1 | vectors (57 + 300 + 11) | 7/7 mutation ถูกจับ |
| repository | 1 | unit (18) | 9/9 mutation ถูกจับ |
| erfc | 1 | `erfc.json` (37 แถว) | แม่นสุด 1.3e-13 สัมพัทธ์ เทียบ Python บน 8,011 จุด |
| service | 1 | unit (41) | 19/19 mutation ถูกจับ |
| handler + main | **3** | build ล้ม 2 รอบ (type), unit ล้ม 1 รอบ (2 ข้อ) | unit 2 ข้อเป็นพฤติกรรมของ Fastify ที่ไม่เคยทดลองมาก่อน (ดูข้างล่าง) |
| contract (HTTP) | 1 | contract (305, ต่อมา 313) | ผ่านรอบแรกกับ server จริง ทั้งแบบเรียง ขนาน และซ้ำ |
| differential | 1 | diff-servers | 0 ความต่าง: seed 1–9 (3,000–4,000 request) ก่อนเพิ่ม scenario "experiment" และ seed 11–14 (3,000) หลังเพิ่ม ทั้งหมดรันหลังแก้ Go ข้อ 2 ด้านล่าง |

ที่จับ bug ได้มากสุดต่อเวลา: **สิ่งที่เพิ่มก่อนแปล** (vectors `target-attr-*`, timestamp, Content-Type, ขนาด body) และ **mutation check** ส่วน unit test ที่พอร์ตจาก Go ผ่านรอบแรกเกือบหมด จึงจับอะไรไม่ได้ในรอบนี้ (มีไว้กันถดถอย)

## ความเสี่ยงที่ทำนายไว้ ([`typescript-analysis.md`](../docs/porting/typescript-analysis.md) ข้อ 5)

| ความเสี่ยง | เกิดจริงไหม | จับได้ด้วย |
|---|---|---|
| 1. พฤติกรรม Fastify ต่อ body/route/error | **เกิดจริงทุกข้อในตารางข้อ 4 ของรายงาน** + 2 จุดที่ไม่ได้ทำนาย (`:key` ว่าง, `maxParamLength`) | contract tests ที่เพิ่มก่อนแปล; 2 จุดใหม่จับได้ตอนรัน unit/contract |
| 2. ตัวเลข/hash | ป้องกันตั้งแต่ต้น (`Math.imul`, UTF-8) | vectors (mutation: float multiply ถูกจับ 20 แถว, UTF-16 ถูกจับ 5 แถว) |
| 3. attribute ชื่อชนกับ `Object.prototype` | ป้องกันตั้งแต่ต้น | vectors `target-attr-*` (mutation 2 แบบถูกจับ) |
| 4. `Date.parse` ผ่อนปรน | ป้องกันตั้งแต่ต้น และ **ทำให้พบว่า mock เองก็ผิดด้วย** | contract timestamp |
| 5. `erfc` | เกิดจริง: การประมาณแบบตำราคลาดเคลื่อน ~1e-7 | `erfc.json` (+ test ที่พิสูจน์ว่าการประมาณนั้น *ไม่ผ่าน*) |

## AI พลาดอะไร (และสิ่งที่ผมรู้แล้วแต่ลืมไป)

| อาการ | สาเหตุจริง | แก้อย่างไร | ควรป้องกันที่ไหน |
|---|---|---|---|
| `GET /v1/flags/` (ไม่มี key) ตอบ 401 แทน 404 | Fastify จับคู่กับ `/v1/flags/:key` โดย `key` เป็นสตริงว่าง (Go: `{key}` ต้องไม่ว่าง) ทดลองใน step 8 ใช้ route ที่ไม่มี param จึงไม่เห็น | hook `nonEmptyKey` ก่อน auth | test BR-53 จับได้ (ทั้งที่เขียนไว้ก่อนแปล) → **ควรทดลอง framework กับ route ที่มี param ด้วย** |
| key ยาว > 100 ตัวได้ 400 | `maxParamLength` เริ่มต้น 100 | `routerOptions.maxParamLength` | เพิ่ม contract test "key ยาวเท่าไรก็ 404" (ทำแล้ว) |
| type error `reply.code(number)` | Fastify รับเฉพาะ literal ของรหัสสถานะ | union type `ErrorStatus`; cast ใน `frameworkErrors` | — (เป็นเรื่อง type ไม่ใช่พฤติกรรม) |
| query ซ้ำ `limit=1&limit=3` | `request.query` ให้ array | อ่านจาก `URLSearchParams` | **mutation ที่รอดทำให้รู้ว่าไม่มี contract test** → เพิ่ม BR-50 + test |
| ขอบ 30/31 exposure ไม่มี test | สเปกมีเกณฑ์ 30 แต่ทดสอบแค่ 29 กับ 200 | contract test ขอบ | **เจอจาก differential test เท่านั้น** (ผ่านทั้ง unit และ contract) |
| harness 2 ชุดชนพอร์ต | ผมรัน differential สองชุดพร้อมกันบนพอร์ตเดียวกัน (รอบหนึ่งยังค้างเบื้องหลัง) ได้ผล `ECONNREFUSED` และผล mutation 2 ข้อใช้ไม่ได้ | รันซ้ำทีละชุด; ผลที่ใช้ไม่ได้ถูกทิ้ง | อย่ารันเครื่องมือที่ใช้ทรัพยากรร่วมกันซ้อนกัน |
| ลืม `BASE_URL` ตอนรัน contract กับ TS | ผ่านคำสั่งที่เขียนเอง ผลคือ 312 ข้อล้มทั้งหมด (ยิงไปพอร์ตที่ไม่มี server) | เติม `BASE_URL` | ผล fail ทั้งชุดมักไม่ใช่ bug ของโค้ด ตรวจการเชื่อมต่อก่อน |
| server เก่าค้างและบังพอร์ต (พบตอนตรวจสุดท้าย) | ผมทำ mock server รั่ว 3 ตัว: เขียน `node --check x && PORT=... node server.mjs & MP=$!` ซึ่ง `&` ครอบทั้งชุด `$!` จึงเป็น PID ของ subshell แล้ว `kill $MP` ไม่ฆ่า node; และผมตรวจ "ไม่มี server ค้าง" ด้วย `ss` ซึ่งใช้ไม่ได้ในสภาพแวดล้อมนี้ (คืนค่าว่างเสมอ) การรันรอบสุดท้ายชนพอร์ตเก่าจึง fail 12 ข้อโดยที่โค้ดไม่ผิด ผลก่อนหน้าไม่ถูกกระทบเพราะแต่ละรอบใช้พอร์ตใหม่ | ปิดด้วย PID ที่ตรวจ cmdline แล้ว | แยก `A` กับ `B &` (อย่าใช้ `A && B &`), **ตรวจว่า process ที่เปิดตอบ `/healthz` ก่อนรัน test**, ตรวจ process ด้วย `ps` ไม่ใช่ `ss` |
| เรียก skill ไม่ได้ | ไฟล์ skill ที่สร้างกลางบทสนทนาไม่ถูกโหลด | ทำตามขั้นตอนใน `SKILL.md` ด้วยตัวเอง | เอกสาร step 7 ระบุแล้ว: เริ่ม session ใหม่หลังสร้าง skill |

## เรื่องที่ไม่ได้ทำนายไว้ และเปลี่ยนสเปกหรือต้นฉบับ

1. **mock server (JavaScript) ผิดเอง:** รับ 30 ก.พ./ชั่วโมง 24 เพราะ `Date.parse` ผ่อนปรน, เคย treat `/v1/flags/` เหมือน `/v1/flags`, authenticate route ที่ไม่มี, เก็บผลใน object ธรรมดา (`__proto__` หาย) → แก้ทั้งหมด contract test ที่เพิ่มคือสิ่งที่เปิดโปง
2. **ต้นฉบับ Go ผ่อนปรนกว่าสเปก:** `time.Parse` รับชั่วโมงหลักเดียว, `,` ก่อนเศษวินาที, offset `+24:00`/`+07:60` ขณะที่ RFC 3339 ไม่รับ → **แก้ Go** (กติกา: สเปกชนะโค้ด) ค้นพบจากการเทียบ validator ของ TS กับ Go บน 202 สตริง (ความต่าง 10 ข้อ → 0)
3. **Go test cache เห็นไม่ครบ:** vectors อยู่นอกโมดูล จึง `go test` แสดง `(cached)` หลังไฟล์เปลี่ยน ต้องใช้ `-count=1` (ใส่ในตาราง gate ของ CONVENTIONS แล้ว)
4. **สเปกที่ต้องเติม (8 ข้อ):** `10.0` เป็นจำนวนเต็ม, ไม่ตรวจ Content-Type, ขนาด body 1 MiB → 400, RFC 3339 แบบเข้ม, ชื่อ attribute เหมือนสมาชิก object, route ที่ไม่มี (BR-53), พารามิเตอร์ซ้ำใช้ค่าแรก, `INTERNAL_ERROR`
5. **`erfc.json` เป็นสินทรัพย์ใหม่ที่ทุกภาษาใช้ได้:** Rust ก็ไม่มี `erfc` ใน std

## Idiomatic pass และ diff review

- idiomatic: เปิด `typescript-eslint` ชุด **strict + stylistic** เป็น gate ถาวร พบเพียง `!` (non-null assertion) 12 จุด ในไฟล์ test ทั้งหมด (production ไม่มี) แก้เป็น assertion ที่มีข้อความ ไม่มีการ refactor พฤติกรรม และ test 161 ข้อผ่านก่อน-หลัง
- diff review (เทียบ Go กับ TS ในพฤติกรรมที่ test ไม่ครอบคลุม): ลำดับการตรวจ validation ของ flag และ evaluate ตรงกัน; ลำดับภายใน event ต่างกัน (Go ตรวจ timestamp ท้ายสุด, TS ก่อนฟิลด์เฉพาะประเภท) แต่ code เดียวกันทั้งหมด (`VALIDATION_ERROR`) จึงไม่มีผลสังเกตได้; Go escape `<>&` เป็น `<` ใน JSON แต่ parse แล้วเท่ากัน
- differential test ([`tools/diff-servers`](../tools/diff-servers/diff.mjs)): ไม่มีความต่างในทุก seed ที่รัน และตรวจแล้วว่าจับ bug ที่ใส่ไว้ได้ (bucket, `neq` ของ attribute ที่หาย, นับ UTF-16, timestamp ผ่อนปรน, z-test ไม่ two-sided, audit กลับด้าน, ขอบ 30/31) หลังเพิ่ม "experiment" ที่ทำให้เข้าถึงสายสถิติ: **ก่อนเพิ่ม harness ไม่เห็น z-test ผิดเลย**

## สิ่งที่จะเปลี่ยน

- **CONVENTIONS.md:** Go gate ใช้ `go test -count=1` (ทำแล้ว); แถว TypeScript ทดสอบแล้ว (ทำแล้ว)
- **skill `port-layer`:** เพิ่มข้อ "ถ้าภาษาปลายทางใช้ framework ให้ทดลอง framework กับ route ที่มี parameter, ที่ไม่มี และที่ว่าง แล้วบันทึกผลในรายงานก่อนแปล" (ยังไม่ได้แก้ไฟล์ skill)
- **Step 8:** เพิ่มขั้น "ทำ differential test ระหว่างภาษา" เป็นมาตรฐาน ไม่ใช่ทางเลือก และให้ harness มี scenario ที่เข้าถึงสายสถิติ
- **ก่อนแปลภาษาถัดไป (Python/Java/Rust):** Python `\d` ตรงกับเลข Unicode (เช่นเลขอาหรับ-อินเดีย) จึงต้องใช้ `[0-9]` — contract test `limit=%D9%A5` เพิ่มแล้ว; Rust ต้อง implement `erfc` เอง (ใช้ `erfc.json`)
