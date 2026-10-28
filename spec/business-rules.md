# Business Rules

กฎที่ OpenAPI ไม่ครอบคลุม แต่ละข้อมี ID ให้ contract test อ้างอิง (`BR-xx`) กฎการประเมินอยู่ใน `evaluation.md`

## Flag (MVP1)

| ID | กฎ | ผลเมื่อฝ่าฝืน |
|---|---|---|
| BR-01 | `key` ต้องตรงกับ `^[a-z0-9][a-z0-9_-]{0,63}$` | 400 `INVALID_KEY` |
| BR-02 | `key` ต้องไม่ซ้ำ | 409 `FLAG_EXISTS` |
| BR-03 | `key` เปลี่ยนไม่ได้หลังสร้าง (PUT ที่ส่ง `key` ต่างจาก path) | 400 `KEY_IMMUTABLE` |
| BR-04 | `description` ยาวได้ไม่เกิน 500 ตัวอักษร (นับ Unicode code point) | 400 `VALIDATION_ERROR` |
| BR-05 | GET/PUT/DELETE flag ที่ไม่มี | 404 `FLAG_NOT_FOUND` |
| BR-06 | DELETE สำเร็จตอบ 204 และ evaluate หลังลบต้องไม่พัง (ได้ `FLAG_NOT_FOUND` reason) | — |
| BR-07 | ทุก create/update/delete บันทึก audit log 1 รายการ | — |
| BR-08 | `enabled` ไม่ส่งตอนสร้าง = `false` | — |

## Auth

| ID | กฎ | ผล |
|---|---|---|
| BR-10 | Admin API ต้องมี header `X-Admin-Key` ที่ถูกต้อง | ไม่มี/ผิด → 401 `UNAUTHORIZED` |
| BR-11 | `POST /v1/evaluate` ใช้ `X-Client-Key` (หรือ admin key ก็ได้) | ไม่มี/ผิด → 401 `UNAUTHORIZED` |
| BR-12 | client key เรียก Admin API ไม่ได้ | 403 `FORBIDDEN` |
| BR-13 | `/healthz` ไม่ต้อง auth | — |

## Evaluate

| ID | กฎ | ผล |
|---|---|---|
| BR-20 | `context` ต้องเป็น object (ไม่ส่ง = `{}`) | อื่นๆ → 400 `VALIDATION_ERROR` |
| BR-21 | flag ที่ไม่มีอยู่ ต้องไม่ทำให้ request ล้มเหลว | ตอบ `FLAG_NOT_FOUND` ในผล |
| BR-22 | evaluate ต้องไม่มี side effect (ไม่เขียน DB) | — |

## Variants / Rollout (MVP2)

| ID | กฎ | ผลเมื่อฝ่าฝืน |
|---|---|---|
| BR-30 | `rolloutPercent` เป็นจำนวนเต็ม 0–100 (default 100) | 400 `VALIDATION_ERROR` |
| BR-31 | ผลรวม `weight` ของ variants ต้องเท่ากับ 100 | 400 `INVALID_VARIANTS` |
| BR-32 | variant `key` ต้องไม่ซ้ำใน flag เดียวกัน และตรงกับ `^[a-z0-9][a-z0-9_-]{0,31}$` | 400 `INVALID_VARIANTS` |
| BR-33 | variants มีได้ 2–10 รายการ (หรือว่างทั้งหมด) | 400 `INVALID_VARIANTS` |
| BR-34 | `weight` เป็นจำนวนเต็ม 1–100 | 400 `INVALID_VARIANTS` |
| BR-35 | rule `in`/`not_in` ต้องมี `value` เป็น array ไม่ว่าง; `eq`/`neq` ต้องเป็น scalar | 400 `VALIDATION_ERROR` |

## Events (MVP2)

| ID | กฎ | ผล |
|---|---|---|
| BR-40 | Exposure dedupe: `(flagKey, userId)` ซ้ำนับครั้งเดียวต่อการทดลอง | — |
| BR-41 | Conversion ต้องอ้างถึง user ที่มี exposure แล้ว มิฉะนั้นไม่นับในรายงาน | ยอมรับ event แต่ไม่นับ |
| BR-42 | รายงานผลคำนวณ two-proportion z-test; ถ้า sample ต่อ variant < 30 ให้ `significant:false` | — |

## รูปแบบ Error

ทุก error ใช้ JSON ตามนี้ (ดู `components/schemas/Error` ใน OpenAPI):

```json
{ "error": { "code": "INVALID_KEY", "message": "key must match ^[a-z0-9][a-z0-9_-]{0,63}$" } }
```

contract test ตรวจ **status code และ `error.code`** เท่านั้น ไม่ตรวจข้อความ `message`
