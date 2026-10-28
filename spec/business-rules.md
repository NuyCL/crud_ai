# Business Rules

กฎที่ OpenAPI ไม่ครอบคลุม แต่ละข้อมี ID ให้ contract test อ้างอิง (`BR-xx`) กฎการประเมินอยู่ใน `evaluation.md`

## Flag (MVP1)

| ID | กฎ | ผลเมื่อฝ่าฝืน |
|---|---|---|
| BR-01 | `key` ต้องตรงกับ `^[a-z0-9][a-z0-9_-]{0,63}$` (ไม่ส่งมา/ไม่ใช่ string = `VALIDATION_ERROR`) | 400 `INVALID_KEY` |
| BR-02 | `key` ต้องไม่ซ้ำ | 409 `FLAG_EXISTS` |
| BR-03 | `key` เปลี่ยนไม่ได้หลังสร้าง (PUT ที่ส่ง `key` ต่างจาก path) | 400 `KEY_IMMUTABLE` |
| BR-04 | `description` เป็น string ยาวได้ไม่เกิน 500 **Unicode code point** (ไม่ใช่ UTF-16 unit หรือ byte); `enabled` ต้องเป็น boolean | 400 `VALIDATION_ERROR` |
| BR-05 | GET/PUT/DELETE flag ที่ไม่มี | 404 `FLAG_NOT_FOUND` |
| BR-06 | DELETE สำเร็จตอบ 204 ไม่มี body และ evaluate หลังลบต้องไม่พัง (ได้ reason `FLAG_NOT_FOUND`) | — |
| BR-07 | ทุก create/update/delete **ที่สำเร็จ** บันทึก audit log 1 รายการ (request ที่ถูกปฏิเสธไม่บันทึก) ดูรายละเอียดด้านล่าง | — |
| BR-08 | ไม่ส่งฟิลด์ตอนสร้าง = ค่า default: `description:""`, `enabled:false`, `rules:[]`, `rolloutPercent:100`, `variants:[]` | — |
| BR-09 | PUT เป็น **full replace**: ฟิลด์ optional ที่ไม่ส่งกลับเป็นค่า default ตาม BR-08; `createdAt` ไม่เปลี่ยน, `updatedAt` เปลี่ยน (ไม่น้อยกว่าเดิม) | — |

**Audit log (BR-07):** `action` เป็น `create` | `update` | `delete`; `before`/`after` คือ Flag ทั้งก้อน (รูปแบบเดียวกับ response):

| action | before | after |
|---|---|---|
| create | `null` | flag ที่สร้าง |
| update | flag เดิม | flag ใหม่ |
| delete | flag ที่ลบ | `null` |

รายการเรียงใหม่สุดก่อน (`id` มากไปน้อย) และยังอยู่หลัง flag ถูกลบ

## Auth

| ID | กฎ | ผล |
|---|---|---|
| BR-10 | Admin API ต้องมี header `X-Admin-Key` ที่ถูกต้อง | ไม่มี key หรือ key ผิด → 401 `UNAUTHORIZED` |
| BR-11 | `POST /v1/evaluate` และ `POST /v1/events` ใช้ `X-Client-Key` (หรือ admin key ก็ได้) | ไม่มี/ผิด → 401 `UNAUTHORIZED` |
| BR-12 | client key ที่ถูกต้อง แต่เรียก Admin API → ปฏิเสธ | 403 `FORBIDDEN` |
| BR-13 | `/healthz` ไม่ต้อง auth | — |

## Evaluate

| ID | กฎ | ผล |
|---|---|---|
| BR-20 | body ต้องเป็น JSON object; `context` (ไม่ส่ง = `{}`) ต้องเป็น object; `context.userId` เป็น string; ค่าใน `context.attributes` ต้องเป็น string/number/boolean เท่านั้น (ห้าม null/object/array); `flags` (ถ้าส่ง) เป็น array ของ string | 400 `VALIDATION_ERROR` |
| BR-21 | flag ที่ไม่มีอยู่ ต้องไม่ทำให้ request ล้มเหลว | ตอบ `FLAG_NOT_FOUND` ในผล |
| BR-22 | evaluate ต้องไม่มี side effect (ไม่เขียน DB ไม่เพิ่ม audit ไม่เปลี่ยน `updatedAt`) | — |
| BR-23 | ไม่ส่ง `flags` = ประเมินทุก flag; `flags: []` = ไม่ประเมินอะไร (`results` เป็น `{}`) | — |

## Variants / Rollout / Rules (MVP2)

| ID | กฎ | ผลเมื่อฝ่าฝืน |
|---|---|---|
| BR-30 | `rolloutPercent` เป็นจำนวนเต็ม 0–100 (default 100) ค่าที่เป็นจำนวนเต็มทางคณิตศาสตร์รับได้ไม่ว่าเขียนอย่างไร (`10`, `10.0`, `1e1`) ส่วน `10.5` ไม่รับ เพราะบางภาษา (เช่น JavaScript) แยก `10` กับ `10.0` ไม่ได้ | 400 `VALIDATION_ERROR` |
| BR-31 | ผลรวม `weight` ของ variants ต้องเท่ากับ 100 | 400 `INVALID_VARIANTS` |
| BR-32 | variant `key` ต้องไม่ซ้ำใน flag เดียวกัน และตรงกับ `^[a-z0-9][a-z0-9_-]{0,31}$` | 400 `INVALID_VARIANTS` |
| BR-33 | variants มีได้ 2–10 รายการ (หรือว่างทั้งหมด) | 400 `INVALID_VARIANTS` |
| BR-34 | `weight` เป็นจำนวนเต็ม 1–100 (ต้องมีทุก variant) | 400 `INVALID_VARIANTS` |
| BR-35 | rule: `attribute` เป็น string ไม่ว่าง, `operator` ∈ {eq,neq,in,not_in}, `value` ต้องมีและไม่เป็น null; `in`/`not_in` ต้องเป็น array ไม่ว่างของ scalar; `eq`/`neq` ต้องเป็น scalar | 400 `VALIDATION_ERROR` |

ลำดับ variants ที่ส่งมาต้องถูกเก็บและส่งกลับตามเดิม (มีผลต่อการเลือก variant)

## Events (MVP2)

| ID | กฎ | ผล |
|---|---|---|
| BR-40 | Exposure dedupe: `(flagKey, userId)` ซ้ำนับครั้งเดียว — **exposure แรกชนะ** (variant ของ exposure ถัดๆ ไปถูกเมิน) | — |
| BR-41 | Conversion `(goal, userId)` ซ้ำนับครั้งเดียว; นับในรายงานของ flag ก็ต่อเมื่อ user นั้นมี exposure ของ flag นั้น มิฉะนั้นยอมรับ event แต่ไม่นับ | — |
| BR-42 | รายงานผล: ต่อ variant (ตามลำดับที่ประกาศ) ให้ `exposures`, `conversions` (จำนวน user ที่ exposed ใน variant นั้นและมี conversion ของ goal), `rate = conversions/exposures` (0 ถ้า exposures = 0). `pValue` เทียบกับ variant แรก (control) ด้วย **pooled two-proportion z-test แบบ two-sided**: `p̂ = (x1+x2)/(n1+n2)`, `se = √(p̂(1−p̂)(1/n1+1/n2))`, `z = (p2−p1)/se`, `pValue = erfc(|z|/√2)`. `pValue = null` สำหรับ control เอง, เมื่อ variant ใดมี exposures < 30, หรือ `se = 0`. `significant = (pValue != null && pValue < 0.05)` | — |
| BR-43 | `events` ต้องมี 1–100 รายการ; `type` ∈ {exposure, conversion}; `userId` string ไม่ว่าง; exposure ต้องมี `flagKey` และ `variant` (string ไม่ว่าง); conversion ต้องมี `goal` (string ไม่ว่าง); `timestamp` (ถ้ามี) เป็น RFC 3339 ที่ **ถูกต้องตามปฏิทินและมีเวลากับโซนเวลาครบ** เช่น `2026-01-31T08:00:00Z` หรือ `2026-01-31T15:00:00.250+07:00`; รูปแบบตาม RFC 3339 ทุกตัวอักษร: `YYYY-MM-DDThh:mm:ss[.ffff](Z|±hh:mm)` โดยปี/เดือน/วัน/ชั่วโมง/นาที/วินาทีและ offset ต้องเป็นเลข ASCII ครบ 2 หลัก (ปี 4 หลัก), เศษวินาทีขั้นด้วย `.` เท่านั้น (ไม่ใช่ `,`), ชั่วโมง 00–23, นาทีและวินาที 00–59, offset ชั่วโมง 00–23 และนาที 00–59, `T` และ `Z` เป็นตัวพิมพ์ใหญ่; วันที่ที่ไม่มีจริง (`2026-02-30`, `2027-02-29`), ชั่วโมง 24, นาทีหรือวินาที 60, วันที่ล้วนๆ (`2026-01-31`), เวลาที่ไม่มีโซน (`2026-01-31T08:00:00`), ชั่วโมงหลักเดียว (`T8:00:00Z`), offset ที่ไม่มีโคลอน (`+0700`) หรือเกินช่วง (`+24:00`, `+07:60`) เป็นค่าผิด | 400 `VALIDATION_ERROR` |
| BR-44 | Batch เป็น all-or-nothing: มี event ผิดแม้รายการเดียว → ปฏิเสธทั้งชุด ไม่บันทึกอะไร; สำเร็จ → 202 `accepted` = จำนวน event ในชุด (รวมที่ซ้ำ/ไม่นับ) | — |
| BR-45 | Event ที่ตอบ 202 แล้วต้องปรากฏในรายงานทันที (read-your-writes) | — |
| BR-46 | `GET /v1/flags/{key}/results` ต้องมี `goal` (ไม่ส่ง/ว่าง = `VALIDATION_ERROR`); flag ไม่มี = 404 `FLAG_NOT_FOUND`; flag ที่ไม่มี variants ได้ `variants: []` | — |

## ทั่วไป

| ID | กฎ | ผล |
|---|---|---|
| BR-50 | `limit` เป็นจำนวนเต็ม 1–100 (default 20), `offset` เป็นจำนวนเต็ม ≥ 0 (default 0); `total` คือจำนวนทั้งหมดก่อนแบ่งหน้า | ผิด → 400 `VALIDATION_ERROR` |
| BR-51 | ลำดับการตรวจ: auth (401/403) → validation (400) → existence/conflict (404/409) | — |
| BR-53 | route หรือ method ที่ไม่มีอยู่ → 404 `FLAG_NOT_FOUND` ในรูปแบบ error มาตรฐาน (ไม่ใช่หน้า 404 ของ framework) โดย **ไม่ต้อง auth** (ใช้ code เดิมเพื่อไม่ต้องเพิ่ม code ใหม่) | — |
| BR-52 | request body ต้องเป็น JSON 1 ค่าพอดีที่ parse ได้ (ไม่มีข้อมูลเกินตามหลัง) และ **ไม่ใหญ่กว่า 1 MiB (1,048,576 ไบต์)** มิฉะนั้น 400 `VALIDATION_ERROR` (ไม่ใช่ 413); **ไม่ตรวจ `Content-Type`** body ถูกอ่านเป็น JSON เสมอ (เช่น `curl -d` ที่ส่ง `application/x-www-form-urlencoded` ต้องใช้ได้) | 400 `VALIDATION_ERROR` |

## รูปแบบ Error

ทุก error ใช้ JSON ตามนี้ (ดู `components/schemas/Error` ใน OpenAPI) พร้อม `Content-Type: application/json`:

```json
{ "error": { "code": "INVALID_KEY", "message": "key must match ^[a-z0-9][a-z0-9_-]{0,63}$" } }
```

ความผิดพลาดที่ไม่คาดคิดของ server ตอบ 500 `INTERNAL_ERROR` (ข้อความต้องไม่เปิดเผยรายละเอียดภายใน) กรณีนี้ไม่มี contract test เพราะสั่งให้เกิดผ่าน HTTP ไม่ได้

contract test ตรวจ **status code และ `error.code`** เท่านั้น ไม่ตรวจข้อความ `message` (แต่ต้องเป็น string)
