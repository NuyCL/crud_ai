# สรุปบทเรียนรวม (Step 12.3)

สังเคราะห์จาก [`typescript.md`](typescript.md), [`python.md`](python.md), [`java.md`](java.md), [`rust.md`](rust.md), [`sdk-js.md`](sdk-js.md), [`comparison.md`](comparison.md), `docs/porting/*-analysis.md` และ `git log` ทุกข้อมีหลักฐานเป็นไฟล์/commit ข้อที่เป็นข้อสันนิษฐานระบุไว้ว่า "สันนิษฐาน"

> **ข้อจำกัดที่ต้องอ่านก่อน:** AI ตัวเดียวกันเขียนแผน โค้ด test และบทเรียนทั้งหมดในบทสนทนาเดียว; ไม่ได้บันทึกเวลา; ไม่มีคนอื่นลองทำตามเอกสาร (เกณฑ์ข้อ 4 ของ step 12 ยังไม่ผ่าน) ข้อสรุปจึงเป็น "สเปก + test กลางใช้ได้จริงในโปรเจกต์นี้" ไม่ใช่ "ได้ผลกับ AI/ทีม/โปรเจกต์อื่น"

## 1. แผนต่างจากที่ทำจริงตรงไหน

`docs/plan.md` ที่ step 1 อ้างถึง **ไม่เคยถูกสร้าง** (ผลของการวางแผนอยู่ใน `README.md` ตาราง "แผน Workshop" และ Roadmap) จึงเทียบกับสองส่วนนั้น

| แผน | จริง | สาเหตุ / หลักฐาน |
|---|---|---|
| รอบ 1: MVP1 (on/off) ใน Go → TypeScript | Go ทำ MVP1+MVP2 ฝั่ง server พร้อมกัน (commit `c252562`..`cae9243`); TypeScript ตามด้วยโค้ดครบ | ทำสเปกครบก่อน (`f881a90`) จึงไม่แยกรอบ |
| สเปก/test เสร็จก่อนแปล แล้ว "ไม่แก้" | `spec/` และ `tests/` ถูกแก้ใน **8 commit** หลังมี Go (`4b0607d`, `55c5c8a`, `d5726f2`, `1bd93e3`, `4a475c1`, `fc4f0f2`, `c390c36`, `4a0f398`); contract 258 → 313 → 333 | แต่ละครั้งมาจากการวิเคราะห์/แปลภาษาถัดไปที่เจอจุดกำกวม (เช่น BR-52/54/55 จาก `spec-ambiguity-check python`) — สเปก "เสร็จ" ก่อนแปลภาษาแรกไม่ได้ ต้องย้อนกลับมาแก้ทุกภาษา |
| รอบ 2: Python, Java | Python ง่ายสุดตามแผน; Java **ต้องออกแบบ handler ใหม่** (Undertow + servlet filter) | `docs/porting/java-analysis.md` ข้อ 4 (การทดลองสาม server) |
| รอบ 3: Rust "ห่างจาก Go สุด / ยากสุด" เก็บท้าย | Rust compile ผ่านรอบแรก ไม่มีปัญหา borrow checker ใน `lessons/rust.md`; ปัญหา HTTP น้อยกว่า Java | ออกแบบ `Service<R: Repository>` + closure ยืม `&dyn Tx` ตั้งแต่ต้น; หมายเหตุ: "ง่าย" ตรงนี้เป็นของโปรเจกต์ขนาดนี้และ AI ที่มีบทเรียนสามภาษาก่อนหน้า (สันนิษฐาน) |
| รอบ 4: MVP3 SDK "สร้างจากสัญญา" | ตามแผน แต่ติด **CORS** ที่สเปกไม่ได้กำหนด | `sdk-js/README.md` ข้อจำกัด; `lessons/sdk-js.md` |
| เครื่องมือ: contract + vectors เป็นตัวตัดสิน | เพิ่มอีกสามอย่างที่แผนไม่ได้พูดถึง: **diff-servers**, **mutation-check** (5 สคริปต์), **การทดลอง framework ก่อนเขียน** | เกิดจากข้อพลาดของ TypeScript (`lessons/typescript.md`) แล้วใช้ซ้ำทุกภาษา |
| "ต้องมีคนอ่านโค้ด" (README ข้อควรระวัง) | **ไม่ได้ทำ** — ไม่มีคนอ่านโค้ดของภาษาใดนอกจาก AI | จึงยังไม่รู้ว่า gate ปัจจุบันปล่อยโค้ดที่ผ่านทุก test แต่ไม่ idiomatic ไว้แค่ไหน |

## 2. bug ที่เกิดซ้ำในหลายภาษา — ต้นเหตุร่วมอยู่ที่ไหน

| อาการ | ภาษา | ต้นเหตุร่วม | หลักฐาน |
|---|---|---|---|
| framework ถอดรหัส/จับคู่ path ไม่ตรงสเปก (`%2F`, `%FF`, `;`, ช่องว่าง `:key`, `maxParamLength`) | TypeScript, Python, Java, Rust | **สเปกเงียบเรื่อง path ที่เข้ารหัส** จนเพิ่ม BR-55 และ **contract ไม่มีกรณี "key ที่เข้ารหัสแล้วต้องเจอ flag จริง"** (mutation "ไม่ถอดรหัส key" รอดจาก contract ทั้งหมด) | `typescript.md`, `python.md` (`%2F`), `java.md`, `rust.md` |
| test ที่ผมเขียนเองผ่านแต่ไม่ได้ป้องกันอะไร: "11 variants" (น้ำหนักรวมเกิน 100 จึงถูกปฏิเสธด้วยเหตุอื่น), key ตัวพิมพ์ใหญ่ปนกลาง, oracle ที่ใช้ regex เดียวกับโค้ด | Python, Java, Rust | **ต้นเหตุคือ prompt/ขั้นตอน**: AI เขียน test จากโค้ดที่เพิ่งเขียน; mutation check จับได้ทุกครั้ง | `python.md`, `java.md`, `rust.md` ตาราง "AI พลาดอะไร" |
| ช่องว่างของ test กลางที่เจอซ้ำ: p-value ระหว่าง 0.05–0.5, `NaN` ในฟิลด์ที่ไม่รู้จัก, `%zz`, OPTIONS/TRACE//error, 500 ไม่รั่วรายละเอียด | Python, Java, Rust | **test กลางขาด** (ไม่ใช่ AI พลาด) — mutation เดียวกันรอดจาก contract ในหลายภาษา | `comparison.md` ข้อ 4 |
| ทำ background process ผิด (`A && B &` แล้ว kill ไม่ถึงโปรเซส) | TypeScript (บันทึกไว้), Python (ทำซ้ำ) | **prompt/skill ไม่มีข้อห้ามเฉพาะเจาะจง** — บันทึกบทเรียนอย่างเดียวไม่พอ AI ทำซ้ำ | `typescript.md` แถวท้าย, `python.md` แถวท้าย |
| ความต่างของ Go ที่ถูกเปิดโปงโดยภาษาอื่น: timestamp ผ่อนปรน (`4a475c1`), อ่าน body เป็น stream ไม่ตรวจ UTF-8 (commit `4a0f398`) | Go | ต้นฉบับไม่ใช่ "ความจริง": **สเปกชนะ Go** และต้นฉบับต้องผ่านการทดสอบจากภาษาที่สองเท่านั้นจึงเห็น | ข้อสังเกต `typescript.md` ข้อ 2 |

## 3. ความเสี่ยงที่ทำนายไว้ — เกิดจริง / ไม่เกิด / เกิดแต่ไม่ได้ทำนาย

| ภาษา | ทำนายแล้วเกิดจริง | ทำนายแล้วไม่เกิด | เกิดแต่ไม่ได้ทำนาย |
|---|---|---|---|
| TypeScript | `Math.imul`/UTF-8, `Date.parse` ผ่อนปรน, ชื่อ prototype, `erfc`, ความต่างของ Fastify ตามตาราง | — | `:key` ว่าง, `maxParamLength`, mock server เองผิด |
| Python | พฤติกรรม Starlette, `bool` เป็น `int`, surrogate, `compare_digest` | pydantic แปลง `"50"` เป็น `50` (ไม่ใช้ pydantic รับ body) | **`%2F`** |
| Java | HTTP stack ถอดรหัส path, Jackson เดา encoding, `getBytes` แทน surrogate, `byte` มีเครื่องหมาย | Spring ตอบ error คนละรูปแบบ (เลิกใช้ controller ก่อนถึงจุดนั้น) | OPTIONS/TRACE//error/`;` ของ Spring MVC, locale POSIX กับชื่อไฟล์ |
| Rust | `*` panic ใน debug, extractor ตอบ 400 กับ `%FF`, `u16::from_str("+80")` | borrow checker / `.clone()` ทุกที่ (ร่าง step 10 คาดไว้) | serde_json ปฏิเสธ lone surrogate (สเปกยอมอยู่) |
| SDK | — | — | CORS; คิว event ทิ้งของใหม่ (test จับ) |

ภาพรวม (สันนิษฐาน แต่สอดคล้องทุกภาษา): ความเสี่ยงที่ทำนายแม่นคือ **ตัวเลข/ข้อความ** (เพราะมี vectors และกับดักรู้จักดี) ที่ทำนายพลาดคือ **สิ่งที่ framework ทำอยู่ข้างใต้** — ซึ่งแก้ได้ด้วย "ทดลองก่อน" ไม่ใช่ "คิดให้ละเอียดขึ้น"

## 4. gate ไหนคุ้มที่สุด / ไม่เคยจับอะไร

วัดเป็นจำนวนข้อบกพร่องจริงที่แต่ละ gate เป็นตัวจับแรก (ไม่ได้บันทึกเวลา จึงเทียบ "ต่อเวลา" ไม่ได้ — ใช้ "ต่อความพยายามที่เห็นได้" แบบหยาบ):

| gate | จับอะไรได้ | ความพยายาม | หลักฐาน |
|---|---|---|---|
| **การทดลอง framework ก่อนเขียน** | เปลี่ยนการออกแบบ Java; ห้ามใช้ extractor ของ axum; `nonEmptyKey` ของ Fastify | ต่ำ (curl/สคริปต์ไม่กี่สิบบรรทัด) | analysis ข้อ 4 ของทุกภาษา — **คุ้มที่สุด** |
| **mutation check** | ช่องว่างของ test ที่เขียนเองในทุกภาษา (Python 4+, Java 6+, Rust 5, SDK 8) และของ test กลางอีก ≥ 7 จุด | กลาง (สคริปต์ ~40 บรรทัด + รายการ mutation) | `lessons/*.md` ตาราง mutation |
| vectors | hash/Unicode/ชนิดข้อมูล: จับ mutation ระดับ evaluation ได้เกือบทั้งหมดก่อนถึง HTTP | ต่ำ | mutation ของ evaluation ถูกจับครบทุกภาษา |
| contract test | ผ่านรอบแรกทุกภาษาที่แปลหลัง hardening ⇒ ค่าอยู่ที่ "ยืนยันว่าเท่ากับ Go" และตอนสร้างมัน (258→333 ข้อ) | สูง (ครั้งเดียว ใช้ซ้ำ 5 ภาษา) | `comparison.md` |
| differential test | 2 ครั้งที่ contract ไม่รู้: ขอบ 30 exposure (TS), `%2F` (Python) | ต่ำ | `typescript.md`, `python.md` |
| unit test ที่พอร์ตจาก Go | แทบไม่จับอะไรในรอบแปล (ผ่านรอบแรก) แต่กันถดถอยและเป็นที่ที่ mutation ถูกจับ | กลาง | `typescript.md` ("จับอะไรไม่ได้ในรอบนี้") |
| `-race` / lint / format | **ไม่เคยจับ bug พฤติกรรมในรอบนี้** (lint จับสไตล์; clippy/ruff/checkstyle ไม่พบ bug) — ยังคงควรมี เพราะเป็นต้นทุนต่ำ แต่ไม่ใช่ตัวป้องกันคุณภาพของ strategy นี้ (สันนิษฐาน: ถ้าตัดออกจะไม่เห็นผลต่อ 333 ข้อ) | ต่ำ | ไม่มี commit ที่ระบุว่า lint จับ bug |

## 5. ข้อเสนอ (เสนออย่างเดียว ยังไม่แก้ — รออนุมัติ)

### CONVENTIONS.md / CLAUDE.md
1. เพิ่มข้อบังคับ "**ก่อนเขียน handler ต้องทดลอง framework กับรายการ input มาตรฐาน**" (`%FF`, `%00`, `%2F`, `;`, `%zz`, `PATCH/OPTIONS/TRACE/HEAD`, header ไบต์ Latin-1, body UTF-16/invalid UTF-8/NaN/ซ้อนลึก/เลขยาว, panic ใน handler) เหตุผล: ความเสี่ยงที่ทำนายพลาดมาจากตรงนี้ทุกภาษา (ข้อ 3)
2. เพิ่ม "ห้ามใช้ `A && B &` เพื่อเปิด server; ใช้ `( … exec cmd ) &` แล้วตรวจ `/healthz` ก่อนรัน test" ลงใน `CLAUDE.md` เหตุผล: เกิดซ้ำแม้บันทึกไว้แล้ว (ข้อ 2)
3. เขียนว่า dependency ที่ framework พ่วงมา (tokio, uvicorn, Undertow ฯลฯ) ถือว่าอนุมัติแล้วหรือไม่ — ตอนนี้ทุกภาษาเป็น "ข้อสมมติที่ต้องยืนยัน"
4. ยืนยันหรือปฏิเสธ devDependencies ของ `typescript/` และ `sdk-js/`

### skills
5. `spec-ambiguity-check`: เพิ่มหัวข้อบังคับ "ตัวคั่น path ที่เข้ารหัส / escape ผิดรูป / framework ถอดรหัสก่อน routing หรือไม่" (`python.md`)
6. `port-layer`: เพิ่มขั้น "ทดลอง framework" ก่อน layer handler และ "หลัง test ผ่าน ให้รัน mutation check ของ layer นั้นก่อนไป layer ถัดไป"
7. `verify-gates`: เพิ่ม mutation check และ differential test เป็นขั้นท้าย (ตอนนี้มีแค่ build/lint/test/contract)

### prompts / กระบวนการ
8. prompt เขียน test: "**อย่าให้ test คำนวณคำตอบด้วยตรรกะเดียวกับโค้ด; ทุกกรณี 'ต้องล้ม' ต้องล้มด้วยเหตุผลเดียวที่ตั้งใจ**" (ข้อ 2 แถว 2)
9. แยก "ผู้เขียน" กับ "ผู้รีวิว" อย่างน้อยใน session คนละบทสนทนา เพื่อให้ข้อสรุปข้างบนมีน้ำหนักขึ้น — **ทำแล้ว:** skill `.claude/skills/review-port/SKILL.md` + ข้อกำหนดใน `CLAUDE.md` (ยังไม่เคยรันจริง: ต้องเปิด session ใหม่แล้วสั่ง `/review-port <ภาษา>`)

### ชุดกลาง (ต้องสั่งแก้ไฟล์ `tests/` โดยตรง จึงยังไม่ได้ทำ)
10. vectors: `rollout-targeting-hit-no-user`, `variant-targeting-hit-no-user`
11. contract: key ที่เข้ารหัสแล้วเจอ flag จริง; p-value 0.05–0.5; `NaN` ในฟิลด์ที่ไม่รู้จัก; `%zz` → 400; `OPTIONS`/`TRACE`/`/error`/`/docs` → 404; 500 ไม่รั่ว; `;`/`+` ใน query; `PATCH` ที่ path ซึ่งมี `PUT`
12. สเปก: กติกา CORS (ถ้าต้องการให้ SDK ใช้ข้าม origin) — **ทำแล้ว = BR-56** (ดูหัวข้อ "CORS" ท้ายเอกสาร)

## เกณฑ์ "strategy ได้ผล" (5 ข้อของ step 12) — ตอบด้วยข้อมูล

| # | เกณฑ์ | คำตอบ |
|---|---|---|
| 1 | ภาษาใหม่ผ่าน contract **โดยไม่แก้ test** | ใช่ ทั้ง 4 ภาษา — แต่ test ถูก**เพิ่ม**ก่อนแปลทุกภาษา (ไม่ใช่แก้เพื่อให้ผ่าน) และผ่านรอบแรกเพราะมีการทดลองก่อนเขียน |
| 2 | bug สำคัญ (integer, Unicode, ชนิด) ถูกจับโดย vectors ก่อนถึง HTTP | ใช่สำหรับ hash/bucketing/ชนิดข้อมูล (mutation ของ evaluation ถูกจับโดย vectors/unit ทุกภาษา); ไม่ใช่สำหรับ path/body/header ซึ่งอยู่ชั้น HTTP โดยธรรมชาติ — ตัวเลขเป็นเปอร์เซ็นต์ไม่ได้คำนวณ |
| 3 | ภาษา 2–4 ใช้รอบแก้น้อยลงกว่าภาษาแรก | ใช่เชิงคุณภาพ (contract ผ่านรอบแรกสามภาษาติด หลัง TypeScript ที่ต้องแก้ 3 รอบที่ handler); วัดเป็นเวลาไม่ได้ (ไม่ได้บันทึก) |
| 4 | dev คนใหม่ทำตามเอกสารแล้วถึงผลเดียวกัน | **ยังไม่ได้ทดสอบ** |
| 5 | มีสิ่งที่ผ่านทุก gate แต่ผู้ใช้เห็นว่าผิดหรือไม่ | มี 2 อย่างที่ผ่านทุก gate แต่ผิด: CORS (SDK ใช้ข้าม origin ไม่ได้) และ Go ที่ผ่านทุก test เดิมแต่ขัดสเปกเรื่อง timestamp/UTF-8 จนภาษาอื่นเปิดโปง ⇒ ควรมี gate ชนิดใหม่: "ใช้งานจริงจากเบราว์เซอร์" และ "ต้นฉบับต้องถูกทดสอบจากภาษาที่สองก่อนประกาศว่า golden" |

## ความคืบหน้าหลังสรุป: ข้อเสนอ 10–11 ทำแล้ว (ได้รับอนุมัติ)

- **vectors (ข้อ 10):** เพิ่ม `rollout-targeting-hit-no-user` และ `variant-targeting-hit-no-user` ใน `tools/genvectors/main.go` แล้วสร้างใหม่ (63 → 65 แถว) — ยืนยันว่า mutation "ข้ามตรวจ userId เมื่อมี rule" ถูกจับโดย **vectors อย่างเดียว** (Python `tests/test_vectors.py` ล้ม 2 แถว) ไม่ต้องพึ่ง unit test เฉพาะภาษา
- **contract (ข้อ 11): 333 → 354 ข้อ** เพิ่ม: key ที่เข้ารหัสแล้วเจอ flag จริง (GET/PUT/DELETE/results), `%2F` เป็นส่วนของ key, `%zz` → 400 (ตรวจเฉพาะสถานะ เพราะ Go ตอบ `text/plain`), `OPTIONS` และ `/error` `/docs` `/openapi.json` `/actuator/health` → 404, `PATCH`/`POST`/`PUT` ที่ path ซึ่งมี method อื่น → 404 ไม่แก้อะไร, `NaN`/`Infinity` ในฟิลด์ที่ไม่รู้จัก → 400, ขอบ `significant` (p = 0.099 / 0.0552 → false, 0.0405 → true), goal ใน query ถูก percent-decode
- **ไม่ได้เพิ่ม (และเหตุผล):** 500 ไม่รั่วรายละเอียด (black-box บังคับให้เกิด 500 ไม่ได้ — ยังอยู่ใน unit test ต่อภาษา), `TRACE` (`fetch` ส่งไม่ได้), `;` และ `+` ใน query (สเปกไม่ได้กำหนด เป็นพฤติกรรมของ `net/url` ของ Go — ถ้าต้องการให้เป็นกติกาต้องเขียนลงสเปกก่อน)
- **ผล:** ผ่าน 354/354 กับ mock, Go, TypeScript, Python, Java, Rust (รัน Go/TS/Python/Java/Rust ด้วยโค้ดที่ commit อยู่ ไม่ต้องแก้ implementation) mock ต้องแก้ 1 จุด: ตอบ 400 กับ `%zz`

## ความคืบหน้า: ข้อเสนอ 1–7 ทำแล้ว (ได้รับอนุมัติ)

| ข้อ | ที่แก้ |
|---|---|
| 1 ทดลอง framework ก่อนเขียน handler | `CONVENTIONS.md` หัวข้อ "ก่อนเขียน handler: ทดลอง framework (บังคับ)" พร้อมรายการ input ขั้นต่ำ |
| 2 ห้าม `A && B &` | `CLAUDE.md` หมวด "ห้าม" (พร้อมข้อห้ามใหม่เรื่อง test ที่ใช้ตรรกะเดียวกับโค้ด = ข้อเสนอ 8) |
| 3 dependency ที่ framework พ่วงมา | `CLAUDE.md` หมวด "Dependency" + `CONVENTIONS.md` หลักการข้อ 3 |
| 4 devDependencies ของ `typescript/` และ `sdk-js/` | อนุมัติใน `CONVENTIONS.md` |
| 5 `spec-ambiguity-check` | เพิ่มคำถามบังคับเรื่อง path ที่เข้ารหัส, unknown route, body, header |
| 6 `port-layer` | ขั้น "ทดลอง framework" ก่อน handler, กฎ test, และ mutation check หลัง layer ผ่าน |
| 7 `verify-gates` | เพิ่ม differential และ mutation เป็นขั้นท้าย |

หมายเหตุ: skill ที่แก้กลางบทสนทนา**ยังไม่ถูกโหลดใน session นี้** (โหลดตอนเริ่ม session) ต้องเริ่ม session ใหม่จึงจะทดสอบว่าเรียกผ่าน `/port-layer` ได้จริง ข้อ 9 และ CORS ทำแล้ว (ดูหัวข้อท้ายเอกสาร) แต่ `review-port` ก็ยังไม่ถูกโหลดใน session นี้เช่นกัน

## CORS (BR-56) และการรีวิวอิสระ (ข้อ 9)

- **สเปก:** BR-56 + `OPTIONS` ใน `openapi.yaml`; env `CORS_ORIGINS` (**ชื่อและรูปแบบเป็นข้อสมมติของเรา**: สเปกกำหนดแค่พฤติกรรม). ข้อสมมติอื่น: preflight จาก origin ที่ไม่อนุญาต/ไม่มี `Origin` ยังเป็น 404 ตาม BR-53; โหมด `*` ตอบ `*` โดยไม่ใส่ `Vary`; ไม่รับ credentials
- **contract:** +10 ข้อ (`tests/contract/cors.test.mjs`) → 364 ข้อเมื่อตั้ง `CORS_ORIGINS=https://app.example.com`, 362 เมื่อ `*`, 355 เมื่อไม่ตั้ง (ข้ามข้อที่ต้องเปิด CORS และรันข้อ "ปิดแล้วต้องไม่ตอบ CORS")
- **ผล:** ผ่านครบทั้งสามโหมดกับ mock, Go, TypeScript, Python, Java, Rust; unit test ของทุกภาษามีชุด CORS ของตัวเอง; mock bug `cors-everywhere` และ `cors-no-vary` ถูกจับ (ล้ม 2 กลุ่ม / 1 กลุ่ม)
- **ใช้งานจริงจากเบราว์เซอร์ (gate ที่ข้อ 5 ของ step 12 บอกว่าขาด):** Chromium (Playwright) โหลดหน้าจาก `http://localhost:9001` แล้วใช้ `sdk-js/dist/index.umd.js` เรียก Go service: เปิด `CORS_ORIGINS=http://localhost:9001` → `evaluate` 200 / `events` 202 และ `isEnabled` เป็น true; ปิด CORS → request ทั้งสองถูกบล็อก (`net::ERR_FAILED`) และ `isEnabled` ได้ค่า fallback. สคริปต์ยังไม่ได้ commit เพราะ Playwright ไม่อยู่ใน `CONVENTIONS.md` (**ถามก่อนว่าจะเพิ่มเป็น devDependency/เครื่องมือ gate หรือไม่**)
- **ข้อจำกัด:** ผู้เขียน CORS (และ test) คือ AI ตัวเดียวกันใน session เดียว; ยังไม่มีการรีวิวอิสระ → รัน `/review-port` ใน session ใหม่ก่อนถือว่าเสร็จ
