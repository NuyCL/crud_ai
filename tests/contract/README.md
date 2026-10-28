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

`--test-concurrency=1` แนะนำสำหรับผลที่อ่านง่าย แต่ไม่จำเป็น: test ทุกข้อใช้ key ที่ไม่ซ้ำและรันซ้ำบน server เดิมได้ (ผ่านทั้งแบบขนานและแบบเรียง)

`CONTRACT_MVP=1` ข้าม test ของ variants, targeting rules, rollout, events (ใช้ตอนทำ MVP1 อยู่) vector ที่เป็น flag แบบ on/off ธรรมดายังรันอยู่

## โครงสร้าง

| ไฟล์ | ทดสอบอะไร | กฎที่ครอบคลุม |
|---|---|---|
| `flags.test.mjs` | auth, CRUD, validation, pagination, audit log, `description` นับเป็น code point | BR-01..13, 50..52 |
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

เมื่อมี `go/` แล้ว ให้ใช้ Go เป็น golden implementation และเก็บ mock ไว้เป็นตัวอ้างอิงตอนสงสัยว่า test หรือ implementation ผิด
