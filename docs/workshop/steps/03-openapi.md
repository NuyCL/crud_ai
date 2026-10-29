# Step 3: สร้าง `openapi.yaml`

**เป้าหมาย:** สัญญา API ที่ไม่ผูกกับภาษา: endpoint, request/response, error, วิธี auth ทุก implementation และ SDK จะอ้างอิงไฟล์นี้
**เวลา:** 20 นาที · **ก่อนหน้า:** [Step 2](02-spec-rules.md) · **ถัดไป:** [Step 4](04-test-vectors.md)

## หลักคิด

OpenAPI อธิบาย "รูปร่าง" ของ API ได้ดี (path, ชนิดข้อมูล, status code) แต่ **อธิบายพฤติกรรมไม่ได้** เช่น ลำดับการประเมิน หรือ PUT เป็น replace ดังนั้นต้องคู่กับ `spec/business-rules.md` เสมอ และ OpenAPI ต้องอ้าง `BR-xx` ใน description เพื่อให้คนอ่านรู้ว่ากฎอยู่ที่ไหน

## ขั้นตอน

### 3.1 รัน prompt

```text
อ่าน spec/business-rules.md และ spec/evaluation.md แล้วสร้าง spec/openapi.yaml (OpenAPI 3.0.3)

ข้อกำหนด:
- ครอบคลุม: healthz, CRUD ของ flag, audit log, POST /v1/evaluate, (MVP2) POST /v1/events และ GET /v1/flags/{key}/results
- security scheme 2 แบบ: AdminKey (header X-Admin-Key) และ ClientKey (header X-Client-Key)
  /healthz ต้องไม่ใช้ auth
- ทุก error ใช้ schema เดียวกัน {"error":{"code","message"}} โดย code เป็น enum ตามที่ business-rules ระบุ
- ใช้ $ref สำหรับ schema/response ที่ซ้ำ ห้ามเขียนซ้ำ
- ระบุ BR-xx ที่เกี่ยวข้องใน summary หรือ description ของแต่ละ operation
- operation ของ MVP2 ใส่ x-mvp: 2
- ห้ามเพิ่ม endpoint หรือฟิลด์ที่ไม่มีใน spec/ ถ้าคิดว่าขาดอะไร ให้ถามก่อน
- ค่า default ของฟิลด์ต้องตรงกับ BR-08

เมื่อเสร็จ ให้ลิสต์ "สิ่งที่ OpenAPI อธิบายไม่ได้" (กฎที่ผู้อ่านต้องไปดู business-rules.md)
```

### 3.2 รันตัวตรวจ

ตัวตรวจในรีโปนี้ (`tools/check-openapi/check.py`) ตรวจโครงสร้างโดยไม่ต้องต่อเน็ต:

```bash
python3 tools/check-openapi/check.py spec/openapi.yaml
```

ผลที่ถูกต้อง: `spec/openapi.yaml: ok (7 paths, 10 operations, 10 unique operationIds)` (ตัวเลขของคุณอาจต่างได้ถ้าออกแบบ endpoint ต่างกัน)

ตัวตรวจจับอะไรได้:

| ปัญหา | ข้อความที่จะเห็น |
|---|---|
| `$ref` ชี้ไปที่ไม่มี | `unresolved $ref #/components/schemas/...` |
| `operationId` ซ้ำ | `operationId 'x' also used by ...` |
| ใช้ `{key}` ใน path แต่ไม่ประกาศ parameter | `path parameter 'key' is not declared` |
| ชื่อ security scheme ไม่มีอยู่ | `unknown security scheme '...'` |
| operation ไม่มี response 2xx | `no 2xx response` |

ถ้ามีเครื่องมือเต็มรูปแบบและต่อเน็ตได้ ใช้เสริมได้ (ไม่บังคับ):

```bash
npx @redocly/cli lint spec/openapi.yaml
```

### 3.3 รีวิวด้วยเช็กลิสต์

- [ ] ทุก endpoint ที่ `business-rules.md` พูดถึงมีอยู่ใน OpenAPI และไม่มี endpoint เกินมา
- [ ] status code ตรงกับกฎ (เช่น สร้างสำเร็จ 201, ลบสำเร็จ 204, events 202)
- [ ] error code ใน enum ครบตามที่กฎใช้จริง (`FLAG_EXISTS`, `KEY_IMMUTABLE`, `INVALID_VARIANTS` ฯลฯ)
- [ ] pattern ของ `key` ตรงกับ BR-01 ตัวอักษรต่อตัวอักษร
- [ ] ฟิลด์ที่มีค่า default ระบุ `default:` ไว้ และ response ของ flag ระบุ `required` ครบ

```bash
git add -A && git commit -m "Add OpenAPI contract"
```

## เฉลย/อ้างอิงในรีโปนี้

- [`spec/openapi.yaml`](../../../spec/openapi.yaml)
- ตัวตรวจ: [`tools/check-openapi/check.py`](../../../tools/check-openapi/check.py)

## ข้อควรระวัง

- AI ชอบ "ช่วย" เพิ่ม endpoint (เช่น `PATCH`, `/v1/flags/{key}/toggle`) ที่ไม่ได้ขอ ถ้าเพิ่ม contract test ก็ต้องเพิ่ม ทุกภาษาก็ต้องแปลเพิ่ม ให้ลบทิ้ง
- ตัวตรวจนี้ **ไม่เทียบกับ business-rules** มันตรวจแค่โครงสร้างไฟล์ ความถูกต้องของเนื้อหาต้องรีวิวด้วยตา (และ contract test ใน step 5 จะเป็นตัวจับต่อ)
- เมื่อแก้ OpenAPI ภายหลัง ให้รันตัวตรวจทุกครั้ง และอย่าลืมแก้ business-rules ให้ตรงกัน
