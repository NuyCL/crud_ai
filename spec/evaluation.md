# Evaluation Specification

เอกสารนี้เป็น **แหล่งความจริงเดียว** ของวิธีประเมิน flag ทุก implementation (Go, TypeScript, Java, Python, Rust) ต้องให้ผลตรงกับ `tests/vectors/` ทุกแถว ถ้าโค้ดกับเอกสารนี้ขัดกัน **เอกสารนี้ถูกเสมอ**

## 1. Flag model (ส่วนที่เกี่ยวกับการประเมิน)

| ฟิลด์ | ชนิด | ความหมาย |
|---|---|---|
| `key` | string | ตรงกับ `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `enabled` | bool | สวิตช์หลัก |
| `rules` | array of Rule | targeting; ว่าง = ทุกคนผ่าน |
| `rolloutPercent` | integer 0–100 | สัดส่วน user ที่ได้เห็น flag (MVP2; ค่า default = 100) |
| `variants` | array of Variant | ว่าง = flag แบบ boolean (MVP2) |

**Rule:** `{ "attribute": string, "operator": "eq" | "neq" | "in" | "not_in", "value": scalar | array }`

**Variant:** `{ "key": string, "weight": integer }` — ผลรวม `weight` ของทุก variant ต้องเท่ากับ 100

**Context:** `{ "userId": string (optional), "attributes": { string: string | number | bool } }`

## 2. ผลลัพธ์

```json
{ "enabled": true, "variant": "blue", "reason": "VARIANT" }
```

- `variant` เป็น `null` เมื่อ flag ไม่มี variants หรือ `enabled` เป็น false
- `reason` เป็นหนึ่งใน:

| reason | เมื่อไร |
|---|---|
| `FLAG_NOT_FOUND` | ไม่มี flag นี้ในระบบ |
| `DISABLED` | `flag.enabled == false` |
| `TARGETING_MISS` | มี rule ที่ไม่ผ่านอย่างน้อยหนึ่งข้อ |
| `MISSING_USER_ID` | ต้องใช้ bucketing แต่ context ไม่มี `userId` |
| `NOT_IN_ROLLOUT` | bucket ของ user อยู่นอกสัดส่วน rollout |
| `ON` | ผ่านทุกขั้น และ flag ไม่มี variants |
| `VARIANT` | ผ่านทุกขั้น และเลือก variant ได้ |

## 3. ลำดับการประเมิน (ห้ามสลับ)

```
1. flag ไม่มี           → { enabled:false, variant:null, reason:FLAG_NOT_FOUND }
2. flag.enabled == false → { enabled:false, variant:null, reason:DISABLED }
3. targeting             → ทุก rule ต้องผ่าน (AND) ไม่งั้น TARGETING_MISS
4. rollout               → ดูข้อ 5; ไม่ผ่านได้ NOT_IN_ROLLOUT
5. variants              → ว่าง = ON; ไม่ว่าง = เลือกตามข้อ 6
```

ผลที่ `enabled:false` ทุกกรณีมี `variant:null`

### 3.1 Targeting

| operator | ผ่านเมื่อ |
|---|---|
| `eq` | attribute มีอยู่ และ `==` value |
| `neq` | attribute มีอยู่ และ `!=` value |
| `in` | attribute มีอยู่ และเท่ากับสมาชิกใดสมาชิกหนึ่งของ value (array) |
| `not_in` | attribute มีอยู่ และไม่เท่ากับสมาชิกใดเลย |

- **attribute ที่ไม่มีใน context = rule ไม่ผ่าน** ทุก operator (รวม `neq` และ `not_in`)
- เทียบเท่ากันต้อง **ชนิดเดียวกัน**: `"1"` (string) ไม่เท่ากับ `1` (number) ไม่มีการแปลงชนิด
- string เทียบแบบ case-sensitive เทียบ byte ต่อ byte (ไม่ normalize Unicode)
- `userId` **ไม่ใช่** attribute (ใช้ rule กับ userId ไม่ได้)
- ชื่อ attribute เป็น string ธรรมดาทุกชื่อ ชื่อที่ตรงกับสมาชิกสำเร็จรูปของ object ในบางภาษา (`constructor`, `toString`, `__proto__`) ก็ไม่ใช่ข้อยกเว้น: ถ้า context ไม่ได้ส่งมาจริง ถือว่า **ไม่มี** (rule ไม่ผ่าน) และถ้าส่งมา ก็เทียบค่าตามปกติ

### 3.2 ต้องใช้ bucketing เมื่อไร

ต้องใช้ bucketing เมื่อ `rolloutPercent < 100` **หรือ** `variants` ไม่ว่าง
ถ้าต้องใช้ bucketing แต่ `userId` ว่างหรือไม่มี → `MISSING_USER_ID` (ตรวจหลัง targeting ผ่านแล้ว)

## 4. Bucketing

### 4.1 Hash: FNV-1a 32-bit

```
hash = 2166136261                    // offset basis (0x811C9DC5)
for each byte b of UTF-8(input):
    hash = hash XOR b
    hash = (hash * 16777619) mod 2^32   // prime (0x01000193)
return hash                          // unsigned 32-bit
```

- input คือ **ไบต์ UTF-8** ของ string (ไม่ใช่ UTF-16 code unit ไม่ใช่ rune)
- การคูณต้อง wrap ที่ 32 บิตแบบ unsigned เสมอ (ดูตารางกับดักใน README)

### 4.2 Bucket

```
bucket(flagKey, salt, userId) = fnv1a32( flagKey + ":" + salt + ":" + userId ) mod 10000
```

ได้ค่า `0..9999` มี salt สองค่าคือ `"rollout"` และ `"variant"` — แยก salt เพื่อไม่ให้ rollout bucket กับ variant bucket สัมพันธ์กัน

## 5. Rollout

```
if rolloutPercent == 100:                skip (ผ่าน ไม่ต้องใช้ userId)
else if userId ว่าง:                      MISSING_USER_ID
else if bucket(flagKey,"rollout",userId) >= rolloutPercent * 100:
                                         NOT_IN_ROLLOUT
```

ตัวอย่าง `rolloutPercent = 10` → ผ่านเมื่อ bucket อยู่ใน `0..999`
`rolloutPercent = 0` → ไม่มีใครผ่าน (ได้ `NOT_IN_ROLLOUT` หรือ `MISSING_USER_ID` ถ้าไม่มี userId)

## 6. เลือก Variant

```
b = bucket(flagKey, "variant", userId)
threshold = 0
for v in variants (ตามลำดับที่ประกาศ):
    threshold += v.weight * 100
    if b < threshold: return v.key
```

ตัวอย่าง `[blue 50, green 30, red 20]` → blue: `0..4999`, green: `5000..7999`, red: `8000..9999`

- **ลำดับของ variants มีผล** — implementation ต้องรักษาลำดับตามที่เก็บ/ส่งมา
- ถ้าปรับ weight ในภายหลัง user บางส่วนจะย้าย variant ได้ (sticky เฉพาะตอน weight ไม่เปลี่ยน) การรักษา assignment ข้ามการปรับ weight เป็นหัวข้อของ MVP2 ขั้นถัดไป

## 7. Evaluate หลาย flag

`POST /v1/evaluate` ประเมินทุก flag ด้วย context เดียวกัน แต่ละ flag เป็นอิสระต่อกัน ผลเป็น map `flagKey → result` ถ้าระบุ `flags: [...]` ให้ประเมินเฉพาะที่ขอ (`[]` = ไม่ประเมินอะไร ได้ `results: {}`) และ key ที่ไม่มีให้ตอบ `FLAG_NOT_FOUND`
