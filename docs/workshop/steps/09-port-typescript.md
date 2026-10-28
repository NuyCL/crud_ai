# Step 9: แปลเป็น TypeScript (ทีละ layer พร้อม quality gates)

> ⏳ **ฉบับร่าง:** ยังไม่มี `typescript/` ให้เทียบ คำสั่งของ npm/Fastify เป็นข้อเสนอเริ่มต้นตาม `CONVENTIONS.md` ที่ยังไม่ได้ลองรันกับโค้ดจริง

**เป้าหมาย:** service เวอร์ชัน TypeScript ที่ผ่าน unit test, vectors และ contract test **ชุดเดียวกับ Go โดยไม่แก้ test**
**เวลา:** 60 นาที · **ก่อนหน้า:** [Step 8](08-pre-port-analysis.md) · **ถัดไป:** [Step 10](10-port-other-languages.md)

## หลักคิด

ขั้นนี้คือหัวใจของ workshop: ใช้ **วงจรเดิมซ้ำกับทุก layer** และทุกภาษาต่อจากนี้ (step 10) จะใช้วงจรเดียวกันนี้

```
/port-layer typescript <layer> ──▶ gates ผ่าน? ──▶ commit ──▶ layer ถัดไป
                                       │ ไม่ผ่าน (ไม่เกิน 3 รอบ) ──▶ ให้ AI แก้ ──▶ รัน gates ใหม่
                                       └ ยังไม่ผ่านรอบที่ 3 ──▶ คนอ่านเอง
```

ลำดับ layer: `model → evaluation → repository → service → handler → main`

## เตรียมโครงโปรเจกต์ (ครั้งเดียว)

```text
อ่าน CONVENTIONS.md และ docs/porting/typescript-analysis.md แล้วสร้างโครง typescript/ เท่านั้น (ยังไม่แปล layer ใด):
package.json (type: module), tsconfig.json (strict), eslint, scripts: build, lint, test
ใช้ node:test สำหรับ unit test, Fastify, better-sqlite3 ตามที่ CONVENTIONS ระบุ
เสร็จเมื่อ: cd typescript && npm install && npm run build && npm run lint && npm test ผ่านโดยยังไม่มีโค้ด
```

## ขั้นตอน (ทำซ้ำสำหรับแต่ละ layer)

### 9.1 แปล layer

ถ้ามี skill จาก step 7:

```text
/port-layer typescript model
```

ถ้าไม่มี skill ให้วาง prompt นี้:

```text
แปล layer <layer> ของ go/internal/<layer>/ เป็น typescript/src/<layer>/
อ่านก่อน: CONVENTIONS.md, spec/, docs/porting/typescript-analysis.md และโค้ด Go ของ layer นี้
- เขียนแบบ idiomatic TypeScript ไม่ใช่แปลทีละบรรทัด ใช้เฉพาะ library ใน CONVENTIONS.md
- unit test อยู่ข้างโค้ด; layer evaluation ต้องอ่าน tests/vectors/*.json ทุกแถว
- ห้ามแก้ spec/, tests/contract/, tests/vectors/ และห้ามข้ามหรือแก้ test เพื่อให้ผ่าน
- รัน gate: cd typescript && npm run build && npm run lint && npm test
- ถ้า gate fail แก้โค้ดแล้วรันใหม่ ไม่เกิน 3 รอบ แล้วรายงาน
รายงานท้ายงาน: ไฟล์ที่เปลี่ยน, ผล gate, ความต่างของพฤติกรรมจาก Go, ข้อสมมติ
```

### 9.2 อ่านรายงานของ AI ก่อน commit

ถามตัวเอง 3 ข้อ:

1. "ความต่างของพฤติกรรม" ว่างเปล่าหรือไม่? ถ้าว่าง ให้สงสัย ภาษาต่างกันย่อมมีอะไรต่างบ้าง
2. gate ผ่านจริงหรือ AI แค่บอก? รัน `npm test` ซ้ำเองหนึ่งครั้ง
3. มีไฟล์ใน `spec/` หรือ `tests/` ถูกแก้ไหม?

```bash
git status --short -- spec tests      # ต้องไม่แสดงอะไร ถ้ามีรายการ แปลว่า AI แตะไฟล์ที่ห้ามแก้
git add -A && git commit -m "Port <layer> to TypeScript"
```

### 9.3 ทำครบทุก layer แล้วรัน contract test

```bash
cd typescript && npm run build && cd ..
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH=$(mktemp -u).db node typescript/dist/server.js & SVC_PID=$!
sleep 1
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
kill $SVC_PID
```

หรือใช้ `/verify-gates typescript` (step 7)

ส่งผลที่ fail กลับให้ AI ด้วยรูปแบบเดียวกับ step 6.6 (วิเคราะห์ก่อนว่าโค้ด/test/สเปกผิด) ไม่เกิน 3 รอบต่อกลุ่มปัญหา

### 9.4 Idiomatic pass (หลัง test ผ่านแล้วเท่านั้น)

```text
test ทั้งหมดผ่านแล้ว ทบทวน typescript/src ให้เป็นสไตล์ TypeScript ที่ dev ภาษานี้คุ้นเคย:
ใช้ type/discriminated union แทนที่ที่แปลมาจาก pattern ของ Go ตรงๆ, ลบโค้ดที่เหลือจากการแปล,
ตั้งชื่อตามธรรมเนียม เปลี่ยนทีละเรื่อง แล้วรัน gate ทุกครั้ง ห้ามเปลี่ยนพฤติกรรม
```

รัน gate ซ้ำทั้งหมดหลังขั้นนี้ ถ้ามี test ที่เคยผ่านแล้ว fail แปลว่า refactor เปลี่ยนพฤติกรรม ให้ย้อนกลับ (`git checkout .`)

### 9.5 Diff review: เทียบพฤติกรรมกับ Go

```text
เทียบ go/ กับ typescript/ ในแง่ "พฤติกรรมที่ test ไม่ครอบคลุม" ลิสต์เป็นตาราง:
(1) ลำดับการตรวจ validation (2) รูปแบบ response ของ error ที่ไม่มี test (3) การจัดการ concurrency/transaction
(4) ค่า default (5) การเรียง/การแบ่งหน้า พร้อม file:line ทั้งสองฝั่ง อย่าแก้โค้ด
```

ทุกช่องว่างที่เจอ: ตัดสินว่า (ก) สเปกควรระบุ → แก้สเปก, (ข) test ควรครอบคลุม → เพิ่ม contract test แล้วรันกับ **ทั้ง Go และ TypeScript**, หรือ (ค) ไม่สำคัญ → จดใน `lessons/typescript.md`

### 9.6 (ทางเลือก) Differential test

ยิง request ชุดเดียวกัน (สุ่มจาก seed คงที่) ไปทั้ง Go และ TypeScript แล้วเทียบ response ทั้งก้อน ช่วยจับความต่างที่ไม่มีใครคิดจะเขียน test ไว้:

```text
เขียน tools/diff-servers/diff.mjs (Node ไม่มี dependency) รับ 2 base URL แล้วยิง request ที่สุ่มจาก seed คงที่
(เรียง create/update/delete/evaluate ผสม key, userId, attribute แปลกๆ รวมถึง Unicode) ไปยังทั้งสอง server
เทียบ status และ body (ยกเว้น createdAt/updatedAt) พิมพ์ request แรกที่ต่างกัน
```

(ยังไม่ได้สร้างในรีโปนี้)

### 9.7 สรุปบทเรียน

```bash
git add -A && git commit -m "TypeScript port: idiomatic pass and review"
```

จด `lessons/typescript.md` ตามแม่แบบใน [Step 12](12-retrospective.md) ขณะที่ยังจำได้

## ตรวจผล (สรุป)

| คำสั่ง | ผลที่ถูกต้อง |
|---|---|
| `cd typescript && npm run build && npm run lint && npm test` | ผ่านทั้งหมด รวม vectors ทุกแถว |
| contract test กับ TypeScript server | `fail 0` เหมือน Go |
| `git diff golden-v1 --stat -- spec tests` | ไม่มีการเปลี่ยนไฟล์ (ยกเว้นที่ตั้งใจเพิ่มจาก 9.5) |

## ข้อควรระวัง

- **อย่าให้ AI แปลทั้ง service ในครั้งเดียว** ถ้า fail จะไม่รู้ว่าชั้นไหนผิด และคุณจะเสียหลักการ "gate ต่อ layer"
- AI มักแก้ปัญหาโดย "ปรับ test ให้ตรง" เมื่อเจอ fail ซ้ำๆ เช็ก `git diff` ของ `tests/` ทุก commit
- framework มักทำสิ่งที่ขัดสเปกโดยอัตโนมัติ (เช่น ตอบ 422, แปลง `"50"` เป็น `50`) ถ้า contract test ตรงนี้ fail ให้ไล่ที่ framework ก่อน ไม่ใช่ logic ของเรา
- bug ที่เกี่ยวกับตัวเลข/Unicode จะโผล่จาก `fnv1a32.json` และ `bucketing.json` ตั้งแต่ layer `evaluation` ไม่ต้องรอถึง HTTP
