# Step 5: Contract tests (ทดสอบผ่าน HTTP ใช้ได้กับทุกภาษา)

**เป้าหมาย:** ชุด test ที่ยิง HTTP ไปยัง service ใดก็ได้ ถ้า service ผ่าน แปลว่าทำตามสเปก ไม่ว่าเขียนด้วยภาษาอะไร
**เวลา:** 45 นาที · **ก่อนหน้า:** [Step 4](04-test-vectors.md) · **ถัดไป:** [Step 6](06-golden-go.md)

## หลักคิด

- Contract test เป็น **black-box**: รู้แค่ URL, header, body ไม่รู้ว่า service เขียนด้วยอะไร จึงเป็นตัวตัดสินกลางของทุกภาษา
- เขียนด้วย Node (`node:test` + `fetch` ในตัว) เพราะไม่ต้องติดตั้งอะไร ไม่ได้แปลว่า service ต้องเป็น Node
- test ต้อง **เขียนก่อน** มี implementation (TDD) แต่ test ที่ไม่เคยรันกับของจริงอาจมี bug เอง วิธีแก้คือเขียน **mock server** เล็กๆ ไว้พิสูจน์ test (ไม่ใช่ของที่ต้องส่งมอบ)

## ขั้นตอน

### 5.1 ให้ AI เขียน contract test

```text
อ่าน spec/openapi.yaml, spec/business-rules.md, spec/evaluation.md แล้วเขียน contract test ใน tests/contract/
(Node 22: node:test + fetch ไม่มี dependency) แบ่งไฟล์: lib.mjs, flags.test.mjs, evaluate.test.mjs,
variants.test.mjs, events.test.mjs

กติกา:
- ตั้งค่าผ่าน env: BASE_URL (default http://localhost:8080), ADMIN_KEY, CLIENT_KEY
- ตรวจ "status code" และ "error.code" เท่านั้น ห้ามตรวจข้อความ message
- ทุก test ใช้ flag key ที่ไม่ซ้ำ (มี helper uniqueKey) และห้ามสมมติว่า database ว่าง: รันซ้ำบน server เดิมได้
  และรันขนานกันได้ ลบ flag ที่สร้างหลังจบ (after hook)
- ใส่รหัสกฎ BR-xx ไว้ในชื่อ describe/test ที่ทดสอบกฎนั้น (ระบุทีละ ID ไม่เขียนเป็นช่วง)
- เล่นซ้ำ tests/vectors/evaluation.json ทั้งหมดผ่าน HTTP: สร้าง flag ตาม vector, เรียก evaluate, เทียบ expected
- แยก test ของ MVP2 ด้วย env CONTRACT_MVP (1 = ข้าม variants/rules/rollout/events)
- ครอบคลุมทั้งทางที่ถูกและทางที่ผิด: auth (ไม่มี key / key ผิด / client key เรียก admin), validation ทุกฟิลด์,
  404/409, PUT แบบ replace, ลำดับ variants, audit log, description ยาวสุด 500 code point (ลอง emoji 500 ตัว)
- ห้ามเดาพฤติกรรมที่สเปกไม่ได้ระบุ ถ้าเจอจุดกำกวม ให้หยุดแล้วลิสต์มาถามฉัน
```

### 5.2 ให้ AI เขียน mock server เพื่อทดสอบ test

```text
ยังไม่มี implementation จริง เขียน tools/mock-server/server.mjs (Node ไม่มี dependency) ที่ทำตามสเปกครบ
เก็บข้อมูลใน memory เพื่อใช้พิสูจน์ว่า tests/contract/ ถูกต้อง ไม่ใช่งานที่ต้องส่งมอบ

เพิ่มกลไกใส่ bug จำลองผ่าน env MOCK_BUG=<ชื่อ> อย่างน้อย 6 แบบ ที่ตรงกับกฎสำคัญ เช่น
นับความยาว description เป็น UTF-16, ไม่เขียน audit ตอนลบ, PUT แบบ merge แทน replace,
exposure หลังทับ exposure แรก, ไม่ตรวจผลรวม weight, client key เรียก admin แล้วได้ 401 แทน 403
```

### 5.3 รัน test กับ mock

```bash
PORT=8080 node tools/mock-server/server.mjs & MOCK_PID=$!
sleep 1
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
kill $MOCK_PID
```

ผลที่ถูกต้อง: `# pass 260` และ `# fail 0` (จำนวน test ของคุณอาจต่าง)

ถ้ามี test fail ให้ถามตัวเองก่อนว่า **ใครผิด**: test, mock หรือสเปก แล้วแก้ที่ต้นเหตุ อย่าแก้ที่ปลายทาง

> **บทเรียนจากการทำจริง (bug ของ test ที่เจอจากการรันกับ mock):**
> 1. conversion เก็บตาม `(goal, userId)` ทั่วระบบ แต่ test ใช้ goal `"buy"` และ user `u1` ซ้ำกันหลายข้อ ผลของ test หนึ่งรั่วเข้าไปอีกข้อ แก้โดยให้แต่ละ test ใช้ goal ที่ไม่ซ้ำ
> 2. test แบ่งหน้า (pagination) เทียบ `total` ข้ามหลาย request แต่ไฟล์ test อื่นสร้าง/ลบ flag พร้อมกัน แก้โดยเทียบเฉพาะ snapshot ที่นิ่ง และถ้าข้อมูลเปลี่ยนไม่หยุดจนหา snapshot ไม่ได้ ให้รายงานเป็น **skipped** พร้อมเหตุผล (ไม่ fail ลวง ไม่ pass ลวง) โหมด `--test-concurrency=1` รันข้อนี้เต็มทุกครั้ง
> 3. `node --test tests/contract/` (ส่งชื่อโฟลเดอร์) รันไม่ได้ ต้องใช้ glob `"tests/contract/*.test.mjs"`
>
> ทั้งสามข้อ test ผ่านบน server เปล่าหนึ่งรอบ จะไม่เห็น ต้องรัน **ซ้ำ** และ **ขนาน** จึงเจอ

### 5.4 Mutation check: ใส่ bug แล้วดูว่า test จับได้

```bash
for bug in utf16-description put-merges offset-ignored; do
  PORT=8090 MOCK_BUG=$bug node tools/mock-server/server.mjs & BUG_PID=$!
  sleep 1
  echo "== $bug"
  BASE_URL=http://localhost:8090 node --test --test-concurrency=1 "tests/contract/*.test.mjs" | grep -E "^# (pass|fail)"
  kill $BUG_PID
done
```

ผลที่ถูกต้อง: ทุก bug มี `# fail` มากกว่า 0 (รอบ `utf16-description` fail ที่ test "500 emoji", `put-merges` fail ที่ "omitted optional fields reset to defaults", `offset-ignored` fail ที่ test paging) ถ้า bug ไหน **ไม่ถูกจับ** แปลว่า test ยังไม่ครอบคลุมกฎนั้น ให้สั่ง AI เพิ่ม test

### 5.5 ตรวจว่าทุกกฎในสเปกถูกอ้างถึง

```bash
comm -23 \
  <(grep -oE '^\| BR-[0-9]+' spec/business-rules.md | grep -oE 'BR-[0-9]+' | sort -u) \
  <(cat tests/contract/*.mjs | grep -oE 'BR-[0-9]+' | sort -u)
```

ผลที่ถูกต้อง: ไม่มีบรรทัดใดแสดง (ทุกกฎมี test อ้างอิง) คำสั่งนี้ดูแค่ว่า **ถูกกล่าวถึง** ไม่ได้รับประกันว่าทดสอบครบ ใช้หาช่องโหว่ชัดๆ ก่อน ส่วนความครบจริงตรวจด้วย mutation check ข้อ 5.4

### 5.6 commit

```bash
git add -A && git commit -m "Add contract tests and mock server"
```

## ตรวจผล (สรุป)

| คำสั่ง | ผลที่ถูกต้อง |
|---|---|
| รัน test กับ mock (5.3) | `fail 0` |
| รันซ้ำอีกรอบบน server เดิม | `fail 0` เหมือนเดิม |
| รันแบบขนาน (ตัด `--test-concurrency=1`) | `fail 0` (บางรอบ `skipped 1` คือข้อ pagination ตามที่อธิบายด้านบน) |
| mutation check (5.4) | ทุก bug ถูกจับ |
| ตรวจกฎที่ไม่ถูกอ้างถึง (5.5) | ไม่มีผลลัพธ์ |
| `CONTRACT_MVP=1 node --test ...` | ผ่าน และข้าม test ของ MVP2 |

## เฉลย/อ้างอิงในรีโปนี้

- [`tests/contract/`](../../../tests/contract/README.md) (260 test, คู่มือการรัน, ตาราง mutation)
- [`tools/mock-server/server.mjs`](../../../tools/mock-server/server.mjs)

## ข้อควรระวัง

- **ห้ามปรับ test ให้ตรงกับ mock** ถ้าไม่ตรงกัน ให้กลับไปดูสเปกว่าข้อใดกำกวม แล้วแก้สเปก (รอบนี้ทำให้เราเติม BR-09, BR-40–46, BR-50–52 ในสเปก)
- ปิด mock ด้วย `kill $MOCK_PID` ที่จดไว้ตอนเปิด อย่าใช้ `pkill node` ซึ่งปิดโปรเซส node ทุกตัวในเครื่อง รวมถึงที่ไม่ใช่ของคุณ
- จำนวน test ที่เยอะไม่ได้แปลว่าดี ดูว่า test แต่ละข้อ "จับ bug อะไรได้" ถ้าตอบไม่ได้ ให้ลบ
- AI มักเขียน test ที่ตรวจข้อความ error ตรงๆ ซึ่งทำให้ทุกภาษาต้องเขียน message เหมือนกันทุกตัวอักษร ให้ตรวจเฉพาะ `error.code`
