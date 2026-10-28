# Step 7: สร้าง Skill (ทำให้ขั้นตอนที่ใช้ซ้ำเป็นคำสั่งเดียว)

> ⏳ **ฉบับร่าง:** เนื้อหา skill เขียนจากบทเรียน step 1–6 แต่ยังไม่ได้ใช้กับการแปลจริง ให้ทดลองกับ layer เล็กๆ (ข้อ 7.4) แล้วปรับ

**เป้าหมาย:** แปลงขั้นตอนที่จะทำซ้ำหลายสิบครั้ง (แปลทีละ layer, รัน gate, หาจุดกำกวมของสเปก) ให้เป็น skill เพื่อให้ทุกภาษาและทุกคนทำตามขั้นตอนเดียวกัน
**เวลา:** 20 นาที · **ก่อนหน้า:** [Step 6](06-golden-go.md) · **ถัดไป:** [Step 8](08-pre-port-analysis.md)

## Skill คืออะไร และต่างจาก `CLAUDE.md` อย่างไร

| | `CLAUDE.md` | Skill |
|---|---|---|
| โหลดเมื่อไร | ทุกครั้งที่เริ่มงาน | เมื่อเรียก (`/ชื่อ`) หรือเมื่องานตรงกับ `description` |
| เก็บอะไร | กติกาทั่วไป ("ห้ามแก้ test") | ขั้นตอนของงานแบบเฉพาะ ("แปล 1 layer ทำ 7 ข้อนี้") |
| ที่อยู่ | `CLAUDE.md` ที่ root | `.claude/skills/<ชื่อ>/SKILL.md` |

Skill ดีเมื่อ: งานเดิมเกิดซ้ำ, ขั้นตอนต้องเหมือนกันทุกครั้ง, และเราเคยเห็น AI ข้ามขั้นตอนหากสั่งด้วยปากเปล่า

## ขั้นตอน

### 7.1 เพิ่มตาราง "คำสั่ง gate ต่อภาษา" ใน `CONVENTIONS.md`

Skill จะอ้างตารางนี้ (เก็บคำสั่งไว้ที่เดียว ไม่ต้องแก้ทุก skill เมื่อคำสั่งเปลี่ยน) ในรีโปนี้เพิ่มไว้แล้ว ดู [`CONVENTIONS.md`](../../../CONVENTIONS.md) หัวข้อ "คำสั่ง gate ต่อภาษา"

### 7.2 สร้าง skill `port-layer`

```bash
mkdir -p .claude/skills/port-layer
```

สร้าง `.claude/skills/port-layer/SKILL.md`:

````markdown
---
name: port-layer
description: Port one layer (model, evaluation, repository, service, handler, main) of the feature flag service from the Go reference to typescript, python, java or rust, then run the quality gates. Use when asked to port, translate or convert a layer to another language.
---

# Port one layer

Usage: `/port-layer <language> <layer>`

## Before writing code
1. Read, in order: CONVENTIONS.md, spec/business-rules.md, spec/evaluation.md (evaluation and
   service layers), docs/porting/<language>-analysis.md, then the Go source in go/internal/<layer>/.
2. Check that the layers this one depends on already exist in <language>/ and pass their gates.
   If not, stop and say which are missing.

## Write
3. Write idiomatic <language>, not a line-by-line translation. Use only libraries listed in CONVENTIONS.md.
4. Put unit tests beside the code. The evaluation layer must read tests/vectors/*.json and check every row.
5. Do not modify spec/, tests/contract/ or tests/vectors/.

## Verify
6. Run this layer's gates from the "คำสั่ง gate ต่อภาษา" table in CONVENTIONS.md.
7. If a gate fails, fix the code and rerun. After 3 failed rounds stop and report.
   Never weaken, skip or edit a test to make it pass.

## Report (always, in this shape)
- Files created or changed
- Gate results (command, pass or fail)
- Behavior differences from the Go reference
- Assumptions made
- Anything in the analysis document that turned out to be wrong
````

### 7.3 สร้าง skill `verify-gates` และ `spec-ambiguity-check`

`.claude/skills/verify-gates/SKILL.md`:

````markdown
---
name: verify-gates
description: Run every quality gate (build, lint, unit tests, contract tests) for one language implementation of the feature flag service and summarise the result by business rule. Use before committing a port or when asked whether a language implementation is done.
---

# Verify all gates

Usage: `/verify-gates <language>`

1. Read the "คำสั่ง gate ต่อภาษา" table in CONVENTIONS.md for <language>.
2. Run build, lint and unit tests in that order. Stop at the first failing gate and report it.
3. Start the service with ADMIN_KEY=test-admin-key, CLIENT_KEY=test-client-key, PORT=8080 and a fresh
   temporary DB_PATH. Remember the PID of the process you started.
4. Run: node --test --test-concurrency=1 "tests/contract/*.test.mjs"
5. Stop only the process you started, using its PID. Never use pkill or killall.
6. Report a table of gate and result. Group contract failures by the BR-xx in the test name.
   For each failure say whether you think the fault is in the code, the test or the spec, with evidence.
7. Do not change any file.
````

`.claude/skills/spec-ambiguity-check/SKILL.md`:

````markdown
---
name: spec-ambiguity-check
description: Read spec/ as an implementer in a given language and list every point that can be interpreted more than one way, with a recommended answer and a deciding test case. Use after editing the spec and before writing tests or code.
---

# Spec ambiguity check

Usage: `/spec-ambiguity-check <language>`

1. Read all of spec/ as a developer who must implement it in <language> and cannot ask anyone.
2. List every point open to more than one interpretation (not just the top five), ordered by impact.
3. For each: the ambiguous text (file and rule), the competing readings, a recommended answer,
   and one concrete test case that would decide it.
4. Pay particular attention to: integer overflow, Unicode, missing versus null versus zero,
   type comparison, ordering, defaults and error precedence.
5. Do not edit any file. Output the list only.
````

### 7.4 ทดลองใช้และปรับ

```text
/spec-ambiguity-check rust
```

ตรวจว่า AI ทำตามรูปแบบที่กำหนด (ลิสต์ครบ มี test case ชี้ขาด ไม่แก้ไฟล์) ถ้าไม่ทำตาม ให้ปรับ **ข้อความใน skill** ไม่ใช่สั่งปากเปล่าเพิ่ม เพราะรอบหน้าจะเหมือนเดิม

จากนั้นทดลอง `/port-layer typescript model` (หลังทำ step 8) แล้วดูว่ารายงานครบ 5 หัวข้อ

### 7.5 ตรวจโครงสร้างไฟล์

```bash
for f in .claude/skills/*/SKILL.md; do
  head -4 "$f" | grep -q '^name: ' && head -4 "$f" | grep -q '^description: ' && echo "ok   $f" || echo "BAD  $f"
done
```

ผลที่ถูกต้อง: `ok` ทั้ง 3 ไฟล์ และ `name:` ตรงกับชื่อโฟลเดอร์

```bash
git add -A && git commit -m "Add port-layer, verify-gates and spec-ambiguity-check skills"
```

## ข้อควรระวัง

- `description` คือสิ่งที่ AI ใช้ตัดสินว่าจะใช้ skill หรือไม่ ต้องบอกทั้ง **ทำอะไร** และ **ใช้เมื่อไร**
- skill ที่ยาวเกินไปจะถูกอ่านแบบข้ามๆ ถ้ากติกาข้อไหนสำคัญมาก (เช่น "ห้ามแก้ test") ให้ใส่ใน `CLAUDE.md` ด้วย
- อย่าใส่คำสั่งที่เปลี่ยนบ่อยลงใน skill ตรงๆ ให้ชี้ไปที่ `CONVENTIONS.md`
- skill ไม่ทำให้ AI ทำตามเสมอ ยังต้องดูรายงานท้ายงานทุกครั้ง ถ้ารายงานไม่ครบ แปลว่าขั้นตอนถูกข้าม
- ใช้ AI ตัวที่ไม่รองรับ skill: คัดเนื้อหาในกรอบด้านบนไปวางต้น prompt ได้เลย ใช้ได้เหมือนกัน
