# Contract Tests

ชุดทดสอบ black-box ที่ **ยิง HTTP ไปยัง service** ทุก implementation (Go, TypeScript, Java, Python, Rust) ต้องผ่านชุดเดียวกันนี้โดยไม่แก้ไฟล์ในโฟลเดอร์นี้ (ห้ามแก้ test เพื่อให้โค้ดผ่าน ไม่ว่าคนหรือ AI)

เขียนด้วย Node 22+ (`node:test` + `fetch` ในตัว) **ไม่ต้อง `npm install`** ใช้ Node เป็นแค่ตัวยิง request ไม่เกี่ยวกับภาษาของ service ที่ทดสอบ

## วิธีรัน

1. เปิด service ที่ต้องการทดสอบ (ต้องฟังที่พอร์ตที่กำหนดและใช้คีย์ตามนี้):

   | env ของ service | ค่าที่ test ใช้ (default) |
   |---|---|
   | `PORT` | `8080` |
   | `ADMIN_KEY` | `test-admin-key` |
   | `CLIENT_KEY` | `test-client-key` |

2. รัน test:

```bash
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
```

> ต้องใช้รูป glob `"tests/contract/*.test.mjs"` เท่านั้น: `node --test tests/contract/` (ส่งชื่อโฟลเดอร์) ใช้ไม่ได้

| ตัวแปร | ความหมาย | Default |
|---|---|---|
| `BASE_URL` | ที่อยู่ของ service | `http://localhost:8080` |
| `ADMIN_KEY` / `CLIENT_KEY` | คีย์ที่ test ส่งไป | ดูตารางบน |
| `CONTRACT_MVP` | `1` = ทดสอบเฉพาะ MVP1 (on/off), `2` = ทั้งหมด | `2` |

test ทุกข้อใช้ key ที่ไม่ซ้ำและรันซ้ำบน server เดิมได้ แนะนำให้ใช้ `--test-concurrency=1` เพื่อผลที่แน่นอน: ถ้ารันขนาน ไฟล์อื่นสร้าง/ลบ flag ตลอดเวลา จนข้อทดสอบการแบ่งหน้า ("limit and offset page through the same ordering") หา snapshot ที่นิ่งไม่ได้ ข้อนั้นจะถูกรายงานเป็น **skipped** (ไม่ใช่ pass หรือ fail) ส่วนโหมดเรียงรันครบทุกข้อ

`CONTRACT_MVP=1` ข้าม test ของ variants, targeting rules, rollout, events (ใช้ตอนทำ MVP1 อยู่) vector ที่เป็น flag แบบ on/off ธรรมดายังรันอยู่

## โครงสร้าง

| ไฟล์ | ทดสอบอะไร | กฎที่ครอบคลุม |
|---|---|---|
| `flags.test.mjs` | auth, CRUD, validation, pagination, audit log, `description` นับเป็น code point | BR-01..13, 50..53 |
| `evaluate.test.mjs` | auth, validation ของ request, รูปแบบผล, ไม่มี side effect, **เล่นซ้ำ `tests/vectors/evaluation.json` ทั้ง 51 case ผ่าน HTTP** | BR-11, 20..23 |
| `variants.test.mjs` | validation ของ `rolloutPercent`, `variants`, `rules` (MVP2) | BR-30..35 |
| `events.test.mjs` | exposure/conversion, dedupe, รายงานผลและ z-test (MVP2) | BR-40..46 |
| `lib.mjs` | helper: `call`, `fixture`, `assertError`, `uniqueKey` | — |

Contract test **ตรวจ status code และ `error.code` เท่านั้น** ไม่ตรวจข้อความ `message` ตามที่ระบุใน `spec/business-rules.md`

## ข้อกำหนดที่ implementation ต้องรู้ (ที่ test บังคับจริง)

- `description` ยาวได้ 500 **code point**: emoji 500 ตัว (4 ไบต์, 2 UTF-16 unit ต่อตัว) ต้องผ่าน ส่วน 501 ตัวต้องไม่ผ่าน
- `PUT` เป็น full replace: ฟิลด์ที่ไม่ส่งกลับเป็นค่า default
- ลำดับ `variants` ต้องคงเดิมตามที่ส่งมา
- Error ทุกตัวเป็น `application/json` ในรูป `{"error":{"code","message"}}`
- ทุก write ที่สำเร็จเขียน audit log; request ที่ถูกปฏิเสธไม่เขียน
- Events: batch เป็น all-or-nothing, อ่านผลได้ทันทีหลังได้ 202
- **ไม่ตรวจ `Content-Type`**: body ถูกอ่านเป็น JSON เสมอ (form / text/plain / ไม่มีเลย ก็ต้องใช้ได้) และใหญ่ได้ไม่เกิน 1 MiB พอดี; เกินแล้วเป็น 400 (ไม่ใช่ 413) (BR-52)
- `timestamp` ของ event ต้องเป็น RFC 3339 ที่ถูกต้องตามปฏิทินทุกตัวอักษร: `Date.parse` ของ JavaScript และ `time.Parse` ของ Go ผ่อนปรนเกินไป (BR-43)
- `10.0` นับเป็นจำนวนเต็ม; ชื่อ attribute/flag อย่าง `constructor` และ `__proto__` เป็นชื่อธรรมดา (BR-30, evaluation.md 3.1)
- route/method ที่ไม่มีตอบ 404 รูปแบบ error ของเรา โดยไม่ต้อง auth; key ยาวเท่าไรก็ 404 ไม่ใช่ 400 (BR-53, BR-05)
- พารามิเตอร์ query ที่ซ้ำใช้ค่าแรก (BR-50); เกณฑ์ตัวอย่างขั้นต่ำของ p-value คือ 30 พอดี (BR-42)
- ค่า `pValue` ต้องตรงกับสูตรใน BR-42 (ทดสอบที่ความคลาดเคลื่อน 1e-4 จึงใช้ `erfc` ของภาษาหรือ approximation ที่แม่นระดับ 1e-7 ได้)

## ทดสอบตัว test เอง

ยังไม่มี implementation จริง จึงมี mock ที่ทำตามสเปก (`tools/mock-server/server.mjs`, เก็บใน memory) เอาไว้พิสูจน์ว่าชุด test ถูกต้องและ **ล้มเหลวได้จริง** ไม่ใช่ implementation ที่จะส่งมอบ:

```bash
PORT=8080 node tools/mock-server/server.mjs
```

```bash
node --test --test-concurrency=1 "tests/contract/*.test.mjs"     # ต้องผ่านทั้งหมด
```

ใส่ bug ลงใน mock ด้วย `MOCK_BUG=<ชื่อ>` เพื่อดูว่า test จับได้:

| `MOCK_BUG` | bug ที่จำลอง | test ที่ควรล้ม |
|---|---|---|
| `utf16-description` | นับความยาว description เป็น UTF-16 unit | 500 emoji |
| `no-audit-on-delete` | ไม่เขียน audit ตอนลบ | audit log |
| `put-merges` | PUT merge แทน replace | PUT reset defaults |
| `exposure-last-wins` | exposure หลังทับ exposure แรก | dedupe BR-40 |
| `weights-not-checked` | ไม่ตรวจผลรวม weight | INVALID_VARIANTS |
| `client-gets-401` | client key เรียก admin API ได้ 401 แทน 403 | auth BR-12 |
| `offset-ignored` | list ไม่สนใจ `offset` | paging (BR-50) |

## รันกับ implementation จริง

`go/` และ `typescript/` ผ่านชุดนี้ทั้งหมด (313 ข้อ ทั้งแบบเรียง แบบขนาน และ Go build ด้วย `-race`) วิธีรัน: [`../../go/README.md`](../../go/README.md), [`../../typescript/README.md`](../../typescript/README.md) หรือหัวข้อ "Getting started" ใน [`README.md`](../../README.md) เก็บ mock ไว้เป็นตัวอ้างอิงตอนสงสัยว่า test หรือ implementation ผิด: ถ้า mock ผ่านแต่ implementation ไม่ผ่าน มักผิดที่ implementation; ถ้าทั้งคู่ไม่ผ่าน มักผิดที่ test หรือสเปก
