# Test Vectors

ข้อมูลทดสอบที่ **ไม่ผูกกับภาษา** ทุก implementation ต้องอ่านไฟล์เหล่านี้และให้ผลตรงทุกแถว **ห้ามแก้ไฟล์ในโฟลเดอร์นี้ด้วยมือ และห้ามให้ AI แก้** (สร้างจาก `tools/genvectors` เท่านั้น)

| ไฟล์ | จำนวน | ใช้ทดสอบ |
|---|---|---|
| `fnv1a32.json` | 11 | ฟังก์ชัน hash เดี่ยวๆ (มีค่าอ้างอิงที่เผยแพร่ทั่วไป: `""`, `a`, `foobar`) |
| `bucketing.json` | 300 | `bucket = fnv1a32(flagKey:salt:userId) mod 10000` รวม userId ภาษาไทย/จีน/emoji, มี `:` ในชื่อ, ยาว 200 ตัว |
| `evaluation.json` | 57 | การประเมินทั้งลำดับตาม `spec/evaluation.md` (targeting, rollout, variants, ขอบเขต bucket, attribute ชื่อ `constructor`/`__proto__`) |
| `erfc.json` | 37 | ค่า `erfc(x)` อ้างอิงจาก Go และตรวจกับ `math.erfc` ของ Python (ต่างกัน ≤ 3e-16) ภาษาที่ไม่มี `erfc` ในตัว (JavaScript, Rust) ต้องเขียนเองและแม่นตาม `absoluteTolerance` / `relativeTolerance` ในไฟล์ เพราะ p-value ของ BR-42 คือ `erfc(\|z\|/√2)` |

## รูปแบบ

**fnv1a32.json** — `{ "cases": [{ "input", "hash", "hex" }] }`

**bucketing.json** — `{ "cases": [{ "flagKey", "salt", "userId", "input", "hash", "bucket" }] }`
`input` คือ string ที่นำไป hash จริง (`flagKey:salt:userId`) ช่วยแยกว่าพลาดที่การต่อ string หรือที่ hash

**erfc.json** — `{ "absoluteTolerance", "relativeTolerance", "cases": [{ "x", "erfc" }] }`

**evaluation.json** — `{ "cases": [{ "id", "description", "flagKey", "flag", "context", "expected", "debug?" }] }`
- `flag` เป็น `null` = flag ไม่มีในระบบ
- `expected` เทียบแบบตรงทุกฟิลด์: `{ enabled, variant, reason }`
- `debug` ให้ค่า bucket เพื่อใช้ debug เท่านั้น ไม่ต้องเทียบ

## วิธีใช้ใน implementation

1. Unit test ของแต่ละภาษาอ่าน JSON ทั้ง 3 ไฟล์แล้ววนทุก case
2. ทำให้ `fnv1a32.json` ผ่านก่อน, ต่อด้วย `bucketing.json`, แล้วค่อย `evaluation.json` (เรียงตามความลึกของ bug)
3. ถ้าแถวใดไม่ผ่าน ให้ดู `input` กับ `debug` เทียบกับค่าที่ implementation คำนวณได้

## สร้างใหม่และตรวจสอบ

```bash
cd tools/genvectors && go run . ../../tests/vectors   # สร้างใหม่ (generator จะ panic ถ้าผลไม่ตรงกับเจตนาของ case)
node tools/verify-vectors/verify.mjs                  # ตรวจด้วย implementation อิสระ (Node)
```

เมื่อแก้ `spec/evaluation.md` ให้แก้ generator แล้วสร้างใหม่ จากนั้น diff ผลก่อน commit
เมื่อมี `go/` ที่เป็น golden implementation แล้ว ให้ย้ายตรรกะของ generator ไปใช้ package จริงของ `go/`
