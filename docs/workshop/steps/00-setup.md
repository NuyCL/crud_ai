# Step 0: เตรียมเครื่อง

**เป้าหมาย:** มีเครื่องมือครบ มีรีโปเปล่าที่โครงสร้างพร้อม และมีกติกาที่ AI ต้องทำตามทุกครั้ง (`CLAUDE.md`)
**เวลา:** 15 นาที · **ถัดไป:** [Step 1](01-plan-with-ai.md)

## สิ่งที่ต้องมี

| เครื่องมือ | เวอร์ชัน | ใช้ทำอะไร |
|---|---|---|
| Go | 1.22+ | ต้นฉบับ (golden implementation) และ generator ของ vectors |
| Node.js | 22+ | contract test, ตัวตรวจ vectors, mock server |
| Python | 3.10+ และ `pip install pyyaml` | ตัวตรวจ OpenAPI (step 3) |
| Git | ล่าสุด | commit ทุก step |
| Claude Code | ล่าสุด (หรือ AI อื่นที่อ่าน/เขียนไฟล์ในโปรเจกต์ได้) | ตัวทำงานหลัก |

ตรวจว่าพร้อม:

```bash
go version && node --version && python3 --version && git --version
python3 -c "import yaml; print('pyyaml ok')"
```

ผลที่ถูกต้อง: ทุกบรรทัดแสดงเวอร์ชัน ไม่มี `command not found` หรือ `ModuleNotFoundError`

## ขั้นตอน

### 0.1 สร้างรีโปและโครงสร้างโฟลเดอร์

```bash
mkdir -p ff-workshop/{spec,tests/contract,tests/vectors,tools,docs/porting,lessons}
cd ff-workshop
git init
printf 'node_modules/\n*.db\n.env\n' > .gitignore
```

### 0.2 เขียน `CLAUDE.md` (กติกาที่ AI อ่านทุกครั้งที่เริ่มทำงาน)

สร้างไฟล์ `CLAUDE.md` ที่ root:

```markdown
# กติกาของโปรเจกต์

## ลำดับความจริง
spec/ > tests/ > โค้ด ถ้าโค้ดขัดกับสเปก สเปกถูก

## ห้าม
- ห้ามแก้ spec/, tests/contract/, tests/vectors/ เว้นแต่งานนั้นสั่งให้แก้ไฟล์นั้นโดยตรง
- ห้ามข้าม ปิด หรือแก้ test เพื่อให้ผ่าน
- ห้ามเพิ่ม dependency ที่ไม่อยู่ใน CONVENTIONS.md โดยไม่ถามก่อน
- ห้ามเดากติกาที่สเปกไม่ได้บอก ให้ถามหรือระบุเป็นข้อสมมติ

## ทำเสร็จเมื่อ
- คำสั่งตรวจ (build, lint, test) ของงานนั้นผ่านทั้งหมด และแสดงผลให้เห็น
- รายงานความต่างของพฤติกรรมและข้อสมมติทุกข้อที่ใช้

## วิธีตอบ
- ตอบสั้น บอกว่าทำอะไร ผลตรวจเป็นอย่างไร ยังเหลืออะไร
```

**ทำไมต้องมี:** AI ไม่จำบทสนทนาก่อนหน้า `CLAUDE.md` คือที่เดียวที่กติกาอยู่ถาวร ถ้าไม่เขียนไว้ ทุกครั้งที่เริ่มงานใหม่ AI จะกลับไปใช้นิสัยเดิม เช่น แก้ test ให้ผ่าน

### 0.3 commit แรก

```bash
git add -A && git commit -m "Initial structure and CLAUDE.md"
```

## ตรวจผล

```bash
ls -d spec tests/contract tests/vectors tools docs/porting lessons && test -f CLAUDE.md && git log --oneline
```

ผลที่ถูกต้อง: เห็นทุกโฟลเดอร์ และเห็น commit 1 รายการ

## เฉลย/อ้างอิงในรีโปนี้

- โครงสร้างเต็ม: [`README.md`](../../../README.md) หัวข้อ "โครงสร้างโปรเจกต์"
- กติกาต่อภาษา: [`CONVENTIONS.md`](../../../CONVENTIONS.md) (จะใช้ใน step 6 เป็นต้นไป)

## ข้อควรระวัง

- ถ้าใช้ AI ตัวอื่นที่ไม่อ่าน `CLAUDE.md` ให้วางข้อความเดียวกันไว้ต้น prompt แรกของทุกงาน
- อย่าใส่รายละเอียดสเปกใน `CLAUDE.md` มันมีไว้เก็บ "กติกาการทำงาน" ส่วนสเปกอยู่ใน `spec/`
