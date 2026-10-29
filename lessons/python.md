# Lessons: Python

บันทึกหลังแปล Go → Python (Step 10) ตามแม่แบบของ [Step 12](../docs/workshop/steps/12-retrospective.md) ตัวเลขทุกตัวมาจากการรันจริงใน session ที่สร้าง เวลาไม่ได้บันทึก "รอบ" = จำนวนครั้งที่รัน gate ของ layer จนผ่าน

> **ข้อควรทราบ:** AI ตัวเดียวกันเขียนทั้งรายงานก่อนแปลและโค้ด (ไม่ใช่คนเขียน/คนรีวิวแยกกัน) เช่นเดียวกับ [`typescript.md`](typescript.md) และไม่ได้ทดสอบ prompt ในเอกสารกับ AI ตัวอื่น

## ตัวเลข

| ขั้น | รอบ | gate ที่จับได้ | หมายเหตุ |
|---|---|---|---|
| ก่อนแปล: สเปก + test | 1 | `spec-ambiguity-check python` | แก้สเปก 4 จุด, เพิ่ม contract 20 ข้อ (313 → 333) และ vectors 6 แถว; Go/TS/mock ล้มตามที่คาด 3 จุดและถูกแก้ในคอมมิตเดียวกัน |
| model, evaluation, errors | 1 | vectors (57+6 evaluation, 300 bucketing, 11 fnv, 37 erfc) | ผ่านรอบแรก |
| parse, repository, service, handler, config, main | 1 | ruff + pytest + contract | **contract 333/333 ผ่านรอบแรก** กับ server จริง (รันทีละตัว) |
| unit test (พอร์ตจาก Go + เพิ่ม) | 4 | pytest, ruff | ล้ม 3 รอบด้วยเหตุผลของ test/config ไม่ใช่โค้ด: `pythonpath` ของ pytest ยังไม่ตั้ง, helper ส่ง event เกิน 100 ต่อ request, ruff (assert, บรรทัดยาว) |
| mutation | — | 64 mutation ที่ใช้ได้: 61 killed (3 ข้อหลังเพิ่ม test), 3 ไม่ถูก kill เพราะเป็น equivalent | ดู "สถิติ mutation" |
| differential vs Go | 2 | `diff-servers` | **พบ 1 ความต่างจริง (`%2F`)** แก้แล้ว จากนั้น 0 ความต่าง: seed 1–4 (3,000), 11–12 (8,000) และ TS↔Python seed 21 |

ผลสำคัญ: **contract test ที่เขียนก่อนแปลทำงานได้ทันที** แต่ **differential test พบสิ่งที่ contract test ไม่มี** (`%2F`) ตรงกับบทเรียนของ TypeScript ที่ differential จับขอบ 30 exposure

## ความเสี่ยงที่ทำนายไว้ ([`python-analysis.md`](../docs/porting/python-analysis.md) ข้อ 5)

| ความเสี่ยง | เกิดจริงไหม | จับได้ด้วย |
|---|---|---|
| 1. พฤติกรรม Starlette ต่อ query/path/body/error | เกิดจริงทุกข้อ (query ค่าสุดท้าย, redirect 307, `/docs` เปิด, 405, handler `Exception` raise ซ้ำ) และ **`%2F` ที่ไม่ได้ทำนาย** | ทำนายได้เพราะทดลองก่อน (ยืนยันซ้ำด้วยสคริปต์ก่อนเขียนเอกสาร); `%2F` จับได้ด้วย differential |
| 2. `bool`/`int`/`float` ปะปน | ป้องกันตั้งแต่ต้น | vectors bool-vs-number (mutation: ลบการตรวจ bool ถูกจับ 8 ข้อ) |
| 3. lone surrogate / invalid UTF-8 → 500 | ป้องกันตั้งแต่ต้น | contract + unit (mutation: ไม่ล้าง surrogate ถูกจับ 2 ข้อ; `errors="replace"` ถูกจับ) |
| 4. `compare_digest` กับ header non-ASCII | ป้องกันตั้งแต่ต้น | contract non-ASCII header |
| 5. recursion limit | ป้องกันตั้งแต่ต้น | contract deep nesting (mutation: ไม่จับ `RecursionError` ถูกจับ) |

## AI พลาดอะไร

| อาการ | สาเหตุจริง | แก้อย่างไร | ควรป้องกันที่ไหน |
|---|---|---|---|
| `GET /v1/flags/a%2Fb` ตอบ 404 (Go: 401/400/404 ตามลำดับ auth → body → key) | uvicorn แปลง `%2F` เป็น `/` ก่อน routing; ผมทดลอง `unquote` แต่ไม่ได้ทดลอง **การ routing ของ path ที่มี `%2F`** | `_route_path` เก็บ `%2F` ไว้เป็นอักขระแทน แล้ว `_key()` แปลงกลับ | เพิ่ม `%2F` เป็นหนึ่งใน input ที่ skill `spec-ambiguity-check` ต้องถาม ("ตัวคั่น path ที่เข้ารหัส") |
| helper `record` ใน test ส่ง event > 100 ต่อ request | ผมพอร์ต test จาก Go โดยลืมว่า helper ของ Go แบ่งชุดให้ | แก้ helper ให้แบ่งชุดละ 100 | — (test ถูกต้องที่ปฏิเสธ) |
| `ruff` บ่น `assert` ใน repository | ผมใช้ `assert x is not None` เพื่อ type checker | เปลี่ยนเป็นฟังก์ชัน `_stamp()` ที่ raise `ValueError` | — |
| mutation `significant: 0.05 → 0.5` รอดจาก **contract** | contract test ไม่มีกรณีที่ p อยู่ระหว่าง 0.05–0.5 | เพิ่ม unit test 2 กรณี (p = 0.0552 ไม่ significant, 0.0405 significant) ใน Python | **ช่องว่างของ contract ที่ใช้ร่วมกันทุกภาษา** — ดู "เรื่องที่ไม่ได้ทำ" |
| ผม launch Python ใน subshell `cd … && python … &` แล้ว `kill $!` ไม่ฆ่า python | `$!` เป็น PID ของ subshell | `( cd … && exec python … ) &` | ข้อเดียวกับบทเรียน TypeScript (อย่าใช้ `A && B &`) — **ผมทำผิดซ้ำ** ทั้งที่เขียนไว้แล้ว; ตรวจด้วย `ps` ก่อนรันถัดไป |

## เรื่องที่ไม่ได้ทำนายไว้

1. **`%2F`** (ตารางด้านบน)
2. **Go ตอบ 400 แบบ `text/plain` สำหรับ `%zz`** (net/http ปฏิเสธก่อนถึง handler) ขัดกับกติกา "error ทุกตัวเป็น JSON" แต่สเปกไม่ได้พูดถึง escape ผิดรูป — จดเป็นความต่างที่ยอมรับ ไม่แก้ Go/สเปก ณ ตอนนี้
3. mutation "NaN/Infinity ถูกรับ" รอดจาก **contract** เพราะ test ที่มีวางค่า NaN ไว้ในฟิลด์ที่ต้องเป็นตัวเลขอยู่แล้ว (ถูกปฏิเสธด้วยเหตุผลอื่น) ไม่มี test ที่วางไว้ในฟิลด์ที่ไม่รู้จัก → เพิ่ม unit test ใน Python

## สถิติ mutation

ใช้ [`tools/mutation-check/py.sh`](../tools/mutation-check/py.sh) (`unit` = pytest, `http` = contract กับ server ที่ถูกแก้)

| ประเภท | ที่รัน | ผล |
|---|---|---|
| evaluation (hash, bucket, ขอบ rollout/variant, bool, attribute ที่หายไป) | 9 | killed 9 (unit/vectors) |
| parse (regex, ตัวเลข, bool, timestamp, paging, variants, rules, surrogate) | 17 | killed 16; 1 equivalent (`^…$` + `fullmatch` ไม่ต่างจาก `fullmatch` เฉยๆ) |
| service + repository (สถิติ, audit, transaction, events) | 22 | เดิม killed 20, **รอด 2**: `0.05 → 0.5` (แก้โดยเพิ่ม unit test 2 กรณี → killed) และ `< → <=` (ไม่ถูก kill: ต้องการ p = 0.05 พอดีซึ่งไม่เกิดจากข้อมูลจริง ถือว่า equivalent) |
| handler (รันแบบ `http` = contract เท่านั้น) | 16 | killed โดย contract 11; **contract ไม่ kill 5**: `NaN` ในฟิลด์ที่ไม่รู้จัก, `%zz`, เปิด `/docs`, 500 รั่วรายละเอียด (4 ข้อนี้ถูก **unit kill**) และ `str == str` แทน `compare_digest` (equivalent: ไม่ crash กับ non-ASCII) |
| auth non-ASCII: เปลี่ยนเป็น `compare_digest(str, str)` | 2 | ใช้ไม่ได้ — mutation ทำให้ key ถูกทุกครั้งผิด จึงล้ม 242+ ข้อด้วยเหตุผลอื่น ไม่ให้ข้อมูลว่า test non-ASCII ป้องกันอะไร จึงไม่นับ |

รวม 64 = 9 + 17 + 22 + 16; killed 61, equivalent 3 (`^…$`, `<=`, `str ==`)

## สิ่งที่จะเปลี่ยน

- **CONVENTIONS.md:** gate Python ใช้ `python -m compileall -q app tests` (ไม่ใช่ `.`) เพราะ `.venv` อยู่ในโฟลเดอร์; อธิบาย uvicorn/ruff เป็นข้อสมมติที่ต้องยืนยัน
- **skill `spec-ambiguity-check`:** เพิ่มรายการ "ตัวคั่น path ที่เข้ารหัส (`%2F`), escape ผิดรูป (`%zz`)" และ "framework ถอดรหัส path ก่อน routing หรือไม่"
- **สิ่งที่ยังไม่ได้ทำ (ต้องตัดสินใจ):** เพิ่ม contract test สำหรับ p-value ระหว่าง 0.05–0.5, `NaN` ในฟิลด์ที่ไม่รู้จัก, `/docs`, `%2F` — เป็นไฟล์ใน `tests/contract/` ซึ่ง `CLAUDE.md` ห้ามแก้เว้นแต่งานสั่ง จึงเสนอไว้ ณ ที่นี้ ยังไม่ได้ทำ
