# Module 04: แปลหนึ่ง layer ด้วย port-layer

**เป้าหมาย:** ฝึกแปล layer `evaluation` จาก Go เป็นภาษาอื่นด้วย AI อย่างมีวินัย: รู้ว่าต้องสั่งอะไร, ตรวจอะไรจากคำตอบ, และ gate ไหนตัดสินว่าแปลถูก
**เวลา:** ประมาณ 45 นาที (ส่วนที่ไม่ใช้ AI ~15 นาที; ส่วน AI ขึ้นกับเครื่องมือและโควตาของคุณ) · **ระดับ:** กลาง · **ค่าใช้จ่าย:** 0 บาท, รันในเครื่อง (การเรียก AI อาจใช้โควตา/โทเค็นตามแพลนของคุณ) · **ใช้ AI:** ใช่ แต่ขั้นตรวจทำได้โดยไม่ต้องมี AI
**ก่อนหน้า:** [Module 03](03-break-it.md) · **ถัดไป:** [Module 05](05-framework-experiments.md)

> **ถ้าคุณไม่มี Claude Code:** อ่านขั้นที่ 1-4 และ 6-7 ได้ครบ และส่ง prompt ในกล่อง "Prompt สำหรับ AI" ให้ AI ตัวใดก็ได้ที่เขียนไฟล์ในเครื่องคุณได้ หรือเขียน `index.ts` เองแล้วใช้ gate เดียวกัน (มีเฉลยให้ดูหลังลองเอง) skill `/port-layer` ใช้ได้เฉพาะใน Claude Code เท่านั้น

![สถาปัตยกรรม 4 ชั้น: แปลทีละ layer จาก model ไปถึง main](images/arch-layers.svg)

## ค่าที่ใช้ในแลบ

| รายการ | ค่า |
|---|---|
| ภาษาเป้าหมาย / layer | `typescript` / `evaluation` (pure function จึงตัดสินด้วย vectors ได้ทันที) |
| ลำดับ layer ของ skill | model → evaluation → repository → service → handler → main |
| ไฟล์ที่ AI ต้องเขียน | `typescript/src/evaluation/index.ts` (ของจริงยาว 82 บรรทัด; Go ต้นฉบับ `go/internal/evaluation/evaluation.go` 132 บรรทัด; Python `python/app/evaluation.py` 105 บรรทัด) |
| test ที่ให้ (ตัวตัดสิน) | `typescript/src/evaluation/evaluation.test.ts` (อ่าน `tests/vectors/*.json` ครบทุกแถว) |
| ผลที่ต้องได้ | `# tests 83`, `# pass 83`, `# fail 0` สำหรับ test ของ layer นี้ |
| Gate ทั้งภาษา | TypeScript: `npm run build` · `npm run lint` · `npm test` (176 ข้อ) |
| ที่ทำงาน | สำเนาใน `$LAB/lab/typescript` (ไม่แตะโค้ดในรีโป) |

## Prerequisites

Module 00-03 · `typescript/node_modules` มีอยู่ (`cd typescript && npm ci`: ยังไม่ได้ทดสอบ `npm ci` ในแลบนี้)

## ขั้นตอน

**1. เทียบขนาดของ layer ในสามภาษา**

```bash
wc -l go/internal/evaluation/evaluation.go typescript/src/evaluation/index.ts python/app/evaluation.py
```

Expected output:

```text
  132 go/internal/evaluation/evaluation.go
   82 typescript/src/evaluation/index.ts
  105 python/app/evaluation.py
  319 total
```

**2. อ่านวิธี skill ทำงาน** (ไม่ต้องมี Claude Code ก็อ่านได้)

```bash
sed -n 1,40p .claude/skills/port-layer/SKILL.md
```

สิ่งที่ต้องสังเกต: ก่อนเขียนต้องอ่าน `CONVENTIONS.md`, spec, `docs/porting/<lang>-analysis.md` และโค้ด Go ตามลำดับ; ถ้า layer ที่ต้องพึ่งยังไม่มีให้หยุด; ห้ามแก้ `spec/`, `tests/contract/`, `tests/vectors/`; ล้มสามรอบให้หยุดและรายงาน

**3. สร้างสำเนาที่ layer evaluation หายไป**

```bash
mkdir -p "$LAB/lab/typescript"
```

```bash
cp -r typescript/src typescript/package.json typescript/tsconfig.json "$LAB/lab/typescript/"
```

```bash
ln -s "$REPO/typescript/node_modules" "$LAB/lab/typescript/node_modules"
```

```bash
ln -s "$REPO/tests" "$LAB/lab/tests"
```

(test ของ layer อ่าน `../tests/vectors` แบบ relative จากไฟล์ที่ build แล้ว จึงต้องมี `lab/tests`)

```bash
rm "$LAB/lab/typescript/src/evaluation/index.ts"
```

**4. ยืนยันว่า "ล้มก่อน" (test ต้องแดงก่อนจึงมีความหมายตอนเขียว)**

```bash
( cd "$LAB/lab/typescript" && npx tsc -p tsconfig.json )
```

Expected output (exit code 2):

```text
src/evaluation/evaluation.test.ts(5,43): error TS2307: Cannot find module './index.js' or its corresponding type declarations.
src/service/service.ts(3,26): error TS2307: Cannot find module '../evaluation/index.js' or its corresponding type declarations.
```

## Prompt สำหรับ AI: แปลหนึ่ง layer

ถ้ามี Claude Code และ skill: เปิด session ใหม่ในรีโป แล้วพิมพ์ `/port-layer typescript evaluation` (skill จะเขียนลง `typescript/` ในรีโปจริง: ทำบน branch ใหม่และทิ้งทีหลัง; ส่วนนี้ **ยังไม่ได้ทดสอบ**) สำหรับการฝึกในสำเนา ใช้ prompt ด้านล่าง (แก้ `[LAB]` เป็นพาธจริงของ `$LAB` ด้วย `echo "$LAB"`)

```text
Role: senior TypeScript engineer.
อ่านตามลำดับ: CONVENTIONS.md, spec/business-rules.md, spec/evaluation.md, docs/porting/typescript-analysis.md, go/internal/evaluation/evaluation.go
Task: แปลเฉพาะ layer evaluation ไปเป็น [LAB]/lab/typescript/src/evaluation/index.ts ให้ผ่าน [LAB]/lab/typescript/src/evaluation/evaluation.test.ts
กติกา:
- พฤติกรรมต้องตรงกับ Go แต่ถ้า Go ขัดกับ spec ให้ยึด spec และรายงาน
- ใช้เฉพาะ library ที่อยู่ใน CONVENTIONS.md (evaluation เป็น pure function: ห้าม import อะไรนอก layer model)
- เขียนเป็น TypeScript ที่เป็น idiom ไม่ใช่แปลทีละบรรทัด
- ห้ามแก้ spec/, tests/ และห้ามแก้ไฟล์ test เพื่อให้ผ่าน
- ห้ามเขียนไฟล์ใดนอก [LAB]/lab/typescript/src/evaluation/
Done when: ในโฟลเดอร์ [LAB]/lab/typescript คำสั่ง npx tsc -p tsconfig.json และ node --test "dist/evaluation/*.test.js" ผ่านทั้งหมด และแสดงผลให้เห็น
Output: โค้ด + รายการ "ความต่างของพฤติกรรมจาก Go" + "ข้อสมมติทุกข้อที่ใช้" + "สิ่งในเอกสาร analysis ที่ผิด (ถ้ามี)"
```

**ทำไม prompt นี้ได้ผล:** โครงเดียวกับ prompt template ใน `README.md` (Role / Input / Rules / Done when / Output) ซึ่งปรับหลังบทเรียน TypeScript; "Done when" เป็นคำสั่งที่รันได้ ไม่ใช่ความรู้สึก; ข้อกำหนด "รายงานความต่างและข้อสมมติ" มาจากข้อ "ทำเสร็จเมื่อ" ใน CLAUDE.md; ข้อจำกัดการเขียนไฟล์กัน AI ลามไปแก้ที่อื่น

**5. ให้ AI (หรือคุณ) เขียน แล้วรัน gate ของ layer**

```bash
( cd "$LAB/lab/typescript" && npx tsc -p tsconfig.json && node --test "dist/evaluation/*.test.js" 2>&1 | grep -E '^# (tests|pass|fail)' )
```

Expected output เมื่อถูกต้อง (ผลที่ได้จริงเมื่อใช้ไฟล์เฉลยของรีโป):

```text
# tests 83
# pass 83
# fail 0
```

**เฉลย (ดูหลังลองเอง):** ไฟล์อ้างอิงที่ผ่านคือ `typescript/src/evaluation/index.ts` ในรีโป ถ้าไม่ได้ใช้ AI และอยากตรวจว่าชุดคำสั่งทำงาน:

```bash
cp "$REPO/typescript/src/evaluation/index.ts" "$LAB/lab/typescript/src/evaluation/index.ts"
```

แล้วรันคำสั่งในข้อ 5 ซ้ำ ต้องได้ 83 ผ่าน

**6. ตรวจสิ่งที่ AI ส่งมา (อย่าหยุดแค่ test ผ่าน)**

```bash
diff "$REPO/typescript/src/evaluation/index.ts" "$LAB/lab/typescript/src/evaluation/index.ts" | head -40
```

(ใช้เมื่อ AI เขียนไฟล์ของมัน: ความต่างจากเฉลยไม่ผิดโดยตัวมันเอง แต่ทุกจุดที่ต่างต้องอธิบายได้ว่าเหตุใดยังผ่าน vectors)

**สิ่งที่ต้องตรวจจากคำตอบของ AI:**

- [ ] hash ใช้ `Math.imul(h, 16777619) >>> 0` และแปลง string เป็น UTF-8 byte (`Buffer.from(s, "utf8")`) ไม่ใช่ `charCodeAt` (CONVENTIONS.md ตารางกับดัก)
- [ ] เทียบค่าใน rule ตรวจ **ชนิดก่อนค่า** (`"1" != 1`, `true != 1`) และ attribute ที่ไม่มี = rule ไม่ผ่านทุก operator รวม `neq`/`not_in`
- [ ] ชื่อ attribute อย่าง `constructor`, `toString`, `__proto__` ถือเป็นชื่อธรรมดา (ไม่ดึงจาก prototype)
- [ ] ตรวจ `userId` ว่างหลัง targeting ผ่าน (ลำดับ: not found → disabled → targeting → bucketing)
- [ ] ไม่มี import ใหม่; ไม่มีไฟล์นอก `src/evaluation/` ถูกแก้; test ไม่ถูกแก้ (`diff` กับ `$REPO/typescript/src/evaluation/evaluation.test.ts`)
- [ ] รายงานท้ายคำตอบมีครบ 3 ส่วน: ความต่างจาก Go, ข้อสมมติ, จุดที่ analysis ผิด

```bash
diff "$REPO/typescript/src/evaluation/evaluation.test.ts" "$LAB/lab/typescript/src/evaluation/evaluation.test.ts" && echo "test ไม่ถูกแก้"
```

Expected output: `test ไม่ถูกแก้`

**ตัวอย่างรูปแบบรายงานที่ skill กำหนด** (หัวข้อตาม `.claude/skills/port-layer/SKILL.md`; เนื้อหาเป็นตัวอย่างประกอบ ไม่ได้บันทึกจาก AI):

```text
Files created or changed: typescript/src/evaluation/index.ts
Gate results: tsc pass; node --test dist/evaluation: 83 pass, 0 fail
Behavior differences from the Go reference: ไม่มี (หรือ: Go รับ ... แต่ spec ข้อ 3.1 ระบุ ... ยึด spec)
Assumptions made: ...
Anything in the analysis document that turned out to be wrong: ไม่มี
```

**ถ้า AI ตอบผิดแบบนี้ ให้ทำ…**

| อาการ | ทำอะไร | ที่มา |
|---|---|---|
| ใช้ `h * 16777619` หรือ `charCodeAt` | ส่งชื่อ vector ที่ล้มกลับให้ AI (ไม่ใช่แค่ "ผิด"); ผล mutation เดียวกันล้ม 20 ข้อในข้อ 4 ของ module 03 | `CONVENTIONS.md`, module 03 |
| Python: เทียบ `True == 1` ผ่าน | ชี้ว่า boolean ไม่ใช่ number ตาม spec 3.1 (vector `target-eq-bool-vs-number`) | `CONVENTIONS.md`, `lessons/python.md` |
| Rust: `*` ธรรมดาใน hash แล้ว panic ตอน debug | ให้ใช้ `wrapping_mul` | `lessons/summary.md` ข้อ 3 |
| Java: `byte` มีเครื่องหมาย hash ผิด | ใช้ `& 0xFF` / `Integer.toUnsignedLong` | `CONVENTIONS.md` |
| แก้ไฟล์ test หรือ vectors ให้ผ่าน | หยุด ยกเลิกการแก้ แล้วสั่งซ้ำพร้อมบอกว่าห้าม | CLAUDE.md "ห้าม" |
| วนแก้เกิน 3 รอบ | หยุดให้คนตัดสิน (ตามข้อ 8 ของ skill) | `.claude/skills/port-layer/SKILL.md` |
| รายงานไม่มี "ความต่าง/ข้อสมมติ" | ขอใหม่: เป็นข้อบังคับของ "ทำเสร็จเมื่อ" | CLAUDE.md |
| test ที่ AI เขียนเองใช้ฟังก์ชันของโค้ดมาคำนวณค่าที่คาด | ให้เปลี่ยนเป็นค่าตายตัว (ดู module 03) | `lessons/java.md` |

**7. รัน gate เต็มของภาษา (กับโค้ดจริงในรีโป ตาม `CONVENTIONS.md`)**

```bash
( cd typescript && npm run build )
```

```bash
( cd typescript && npm run lint )
```

Expected output: ข้อความของ npm 3 บรรทัด ไม่มี error/warning ของ eslint

```bash
( cd typescript && npm test 2>&1 | grep -E '^# (tests|pass|fail)' )
```

Expected output (ผลจริง):

```text
# tests 176
# pass 176
# fail 0
```

ภาษาอื่น (ผลจริงจากเครื่องผู้เขียน):

```bash
( cd go && go vet ./... && test -z "$(gofmt -l .)" && go test -count=1 -race ./... )
```

Expected output: `ok` ทุก package ที่มี test (`cmd/server`, `internal/evaluation`, `internal/handler`, `internal/repository`, `internal/service`) และ `internal/model` ขึ้น `[no test files]`

```bash
( cd python && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/python -m compileall -q app tests && .venv/bin/pytest -q 2>&1 | tail -1 )
```

Expected output:

```text
All checks passed!
20 files already formatted
347 passed in 1.29s
```

(เวลาต่างกันตามเครื่อง) Java (`mvn -q -DskipTests package`, `mvn -q checkstyle:check`, `mvn -q test`) และ Rust (`cargo build`, `cargo fmt --check && cargo clippy --all-targets -- -D warnings`, `cargo test`): **ยังไม่ได้ทดสอบในแลบนี้**

**8. mutation check หลัง layer ผ่าน** ทำตามข้อ 4 ของ [Module 03](03-break-it.md) กับ `evaluation/index.ts`: ต้องได้ `killed` ทั้งสามข้อ นี่คือข้อ 9 ของ skill (ต้อง mutation อย่างน้อย 5 ข้อ: ขอบเขต, การเทียบชนิด, ลำดับ, ลำดับ error, การคืนทรัพยากร)

## Checkpoint

1. ทำไมแปล `evaluation` ก่อน `repository`/`service`?
2. test ที่เขียวหลัง AI ส่งงาน พิสูจน์อะไร และไม่พิสูจน์อะไร?
3. ถ้า Go กับ spec ขัดกัน AI ต้องทำอย่างไร?

<details>
<summary>เฉลย</summary>

1. เป็น pure function ไม่แตะ DB/เวลา/network จึงตัดสินด้วย `tests/vectors/` ได้ทันทีโดยไม่ต้องมี HTTP (CONVENTIONS.md "ลำดับ layer")
2. พิสูจน์ว่าตรงกับตัวอย่างใน vectors (11 + 300 + 65 แถว) ไม่พิสูจน์ว่า test ที่ AI เขียนเองกันได้ทุก bug (ต้อง mutation) และไม่พิสูจน์ว่าโค้ด idiomatic (ต้องมีคนอ่าน: `lessons/summary.md` ข้อ 1 บันทึกว่ายังไม่มีคนอ่านโค้ดนอกจาก AI)
3. ยึด spec และรายงานความต่าง (CLAUDE.md "ลำดับความจริง"; ตัวอย่างจริง: Go ยอมรับ timestamp ผ่อนปรนจนถูกแก้ตามสเปก, `lessons/summary.md` ตารางข้อ 2)

</details>

## Troubleshooting

| อาการ | แก้ |
|---|---|
| `Cannot find module 'typescript'` / `npx` ติดตั้งใหม่ | `typescript/node_modules` ไม่มี: `cd typescript && npm ci` (ยังไม่ได้ทดสอบ) |
| test หา `tests/vectors` ไม่เจอ | ลืม `ln -s "$REPO/tests" "$LAB/lab/tests"` (ข้อ 3) |
| `ln: ... File exists` | รันข้อ 3 ซ้ำ: ลบ `$LAB/lab` แล้วทำใหม่ |
| ข้อ 7 `npm test` ล้มทั้งที่ไม่ได้แก้อะไร | อย่าลืม `npm run build` ถูกเรียกใน `npm test` อยู่แล้ว; ถ้ายังล้ม ให้ดูข้อความแรกที่ `not ok` |

## Clean up

```bash
rm -rf "$LAB/lab"
```

ถ้าใช้ `/port-layer` ในรีโปจริง: `git status` ต้องดูให้แน่ใจว่าไฟล์ที่เปลี่ยนมีแค่ `typescript/src/evaluation/`; ทิ้งด้วย `git restore typescript/src/evaluation` (หรือลบ branch ฝึก)
