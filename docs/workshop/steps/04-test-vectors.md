# Step 4: Test vectors (ข้อมูลทดสอบกลางที่ไม่ผูกกับภาษา)

**เป้าหมาย:** ตารางค่าคาดหวังที่ทุกภาษาต้องทำให้ตรงทุกแถว โดยเฉพาะการ hash/bucket ที่เป็นจุดแปลพลาดง่ายที่สุด
**เวลา:** 40 นาที · **ก่อนหน้า:** [Step 3](03-openapi.md) · **ถัดไป:** [Step 5](05-contract-tests.md)

## หลักคิด

โค้ด 5 ภาษาจะ "เห็นด้วยกัน" ได้ก็ต่อเมื่อมีข้อมูลกลางให้เทียบ vectors เป็นข้อมูล (JSON) ไม่ใช่โค้ด จึงอ่านได้จากทุกภาษา มี 3 ไฟล์ เรียงจากลึกไปตื้น เพื่อให้รู้ว่า bug อยู่ชั้นไหน:

| ไฟล์ | ทดสอบ | ถ้า fail แปลว่า |
|---|---|---|
| `fnv1a32.json` | ฟังก์ชัน hash เดี่ยวๆ | integer overflow หรือ encoding ผิด |
| `bucketing.json` | `hash(flagKey:salt:userId) mod 10000` | ต่อ string ผิด หรือ mod ผิด |
| `evaluation.json` | ลำดับการประเมินทั้งหมด | ตรรกะผิด |

ปัญหาที่ต้องระวัง: AI เขียนทั้งโค้ดและค่าคาดหวัง ถ้าแค่รันโค้ดแล้วจดผลเป็น "ค่าคาดหวัง" คุณกำลังทดสอบว่า "โค้ดเท่ากับตัวเอง" ซึ่งจริงเสมอ ขั้นนี้จึงมี **การตรวจ 3 ชั้น**:

1. generator ต้องประกาศ "ผลที่ตั้งใจ" ล่วงหน้า แล้ว fail ถ้าคำนวณได้ไม่ตรง
2. เทียบกับค่าอ้างอิงภายนอก (ค่า FNV ที่เผยแพร่ทั่วไป + `hash/fnv` ของ Go)
3. **ตัวตรวจอิสระ** ที่เขียนจากสเปกในอีกภาษา

## ขั้นตอน

### 4.1 ให้ AI เขียน generator (Go)

```text
เขียน tools/genvectors/main.go (Go ไม่มี dependency) ที่สร้าง tests/vectors/fnv1a32.json,
bucketing.json และ evaluation.json ตาม spec/evaluation.md

กติกา:
1. implement FNV-1a 32-bit เองตามสเปก และ assert ว่าผลเท่ากับ hash/fnv ของ stdlib ทุกอินพุต
2. ทุก evaluation case ต้องระบุผลที่ "ตั้งใจ" (reason, variant) ไว้ในโค้ดล่วงหน้า แล้ว panic ถ้าผลที่คำนวณได้
   ไม่ตรง ห้ามเอาผลที่คำนวณได้ไปเป็นค่าคาดหวังโดยไม่ตรวจ
3. ครอบคลุม: ทุกลำดับของการประเมิน (DISABLED, TARGETING_MISS, MISSING_USER_ID, NOT_IN_ROLLOUT, ON, VARIANT),
   ทุก operator, เทียบชนิดผิด ("1" กับ 1, true กับ "true"), attribute ที่ไม่มี
4. ขอบเขต bucket: ค้นหา userId ที่ได้ bucket พอดี 0, 999, 1000, 4999, 5000, 7999, 8000, 9999 แล้วทำเป็น case
5. userId พิเศษ: ภาษาไทย, ญี่ปุ่น, emoji, มีเครื่องหมาย ':', ยาว 200 ตัวอักษร
6. ผลลัพธ์ deterministic: รันซ้ำแล้วไฟล์ต้องเหมือนเดิมทุกไบต์
7. case เรื่องลำดับ variants: userId คนเดียวกันต้องได้ variant ต่างกันเมื่อสลับลำดับ

รันด้วย: cd tools/genvectors && go run . ../../tests/vectors
```

```bash
cd tools/genvectors && go run . ../../tests/vectors
```

ผลที่ถูกต้อง: `wrote 57 evaluation cases` (จำนวนอาจต่างตามที่ AI ออกแบบ; เฉลยมี 51 ตอนจบ step 4 และเพิ่มเป็น 57 ใน step 8 เมื่อพบว่าต้องมี case ของชื่อ attribute ที่ชนกับ `Object.prototype`) และมี 3 ไฟล์ใน `tests/vectors/` (ไฟล์ที่ 4 `erfc.json` เพิ่มใน step 8 เมื่อรู้ว่า JavaScript กับ Rust ไม่มี `erfc` ในตัว ดู [`tests/vectors/README.md`](../../../tests/vectors/README.md))

> **บทเรียนจากการทำจริง:** ตอนรันครั้งแรก generator หยุดด้วย `panic: case rollout-unicode-user: intended ON/"", computed {Enabled:false Variant:<nil> Reason:NOT_IN_ROLLOUT}` ผมเดาผลของ userId ภาษาไทยผิด ถ้าไม่มีกติกาข้อ 2 ค่าที่ผิดจะถูกบันทึกเป็น "คำตอบที่ถูก" เงียบๆ และทุกภาษาจะถูกบังคับให้ผิดตาม การแก้ที่ถูกคือแก้ **ค่าคาดหวังให้ตรงสเปก** ไม่ใช่ปรับ generator ให้ตามผล

### 4.2 ให้ AI เขียนตัวตรวจอิสระ (คนละภาษา คนละบทสนทนา)

เปิดบทสนทนาใหม่ และ **ห้ามให้ดู `tools/genvectors/`**:

```text
อ่าน spec/evaluation.md เท่านั้น (ห้ามเปิด tools/genvectors) แล้วเขียน tools/verify-vectors/verify.mjs
(Node ไม่มี dependency) ที่โหลด tests/vectors/*.json แล้วตรวจทุกแถวด้วยการ implement ตามสเปกเอง
- FNV-1a: ใช้ Math.imul และ >>> 0 และ hash บนไบต์ UTF-8 (Buffer.from)
- ออกเป็น exit code 1 ถ้ามีแถวใดไม่ตรง พร้อมบอกว่าแถวไหน
- ท้ายสุดพิมพ์จำนวนแถวที่ตรวจและจำนวนที่ fail
```

```bash
node tools/verify-vectors/verify.mjs
```

ผลที่ถูกต้อง: `fnv1a32: 11, bucketing: 300, evaluation: 57, failures: 0` (เฉลยตอนจบ step 4 คือ `evaluation: 51`)

ถ้าตัวตรวจอิสระกับ generator ไม่ตรงกัน แปลว่า **สเปกกำกวม** หรือฝั่งใดฝั่งหนึ่งผิด กลับไปอ่านสเปกก่อนแก้โค้ดทั้งสองฝั่ง

### 4.3 Mutation check: พิสูจน์ว่าชุดข้อมูลจับ bug ได้จริง

ใส่ bug ลงในสำเนาของตัวตรวจ (ไม่แตะไฟล์จริง) แล้วดูว่า fail:

```bash
T=$(mktemp -d)

# bug 1: คูณด้วย float แทน Math.imul (ผลเกิน 32 บิตจึงเพี้ยน)
sed 's/h = Math.imul(h, 0x01000193) >>> 0;/h = (h * 0x01000193) >>> 0;/' tools/verify-vectors/verify.mjs > $T/bug_float.mjs
node $T/bug_float.mjs "$PWD/tests/vectors"; echo "exit=$?"

# bug 2: hash ทีละ UTF-16 unit ตัดเหลือ 8 บิต แทนที่จะเป็นไบต์ UTF-8
sed 's/Buffer.from(input, "utf8")/Array.from(input, (c) => c.charCodeAt(0) \& 0xff)/' tools/verify-vectors/verify.mjs > $T/bug_utf16.mjs
node $T/bug_utf16.mjs "$PWD/tests/vectors"; echo "exit=$?"
```

ผลที่ถูกต้อง: ทั้งสองครั้ง `exit=1` และมี `FAIL ...` หลายบรรทัด (ในรีโปนี้ bug 1 พลาด 319 แถว, bug 2 พลาด 44 แถว) ถ้า `exit=0` แปลว่าชุดข้อมูลของคุณอ่อนเกินไป ให้สั่ง AI เพิ่ม case

### 4.4 ตรวจว่า deterministic แล้ว commit

```bash
sha256sum tests/vectors/*.json > /tmp/before.sum
(cd tools/genvectors && go run . ../../tests/vectors > /dev/null)
sha256sum -c /tmp/before.sum        # ทุกไฟล์ต้อง OK
git add -A && git commit -m "Add test vectors, generator and independent verifier"
```

## ตรวจผล (สรุป)

| คำสั่ง | ผลที่ถูกต้อง |
|---|---|
| `cd tools/genvectors && go run . ../../tests/vectors` | เขียนไฟล์ได้ ไม่ panic |
| `node tools/verify-vectors/verify.mjs` | `failures: 0` |
| mutation 2 แบบ | `exit=1` ทั้งคู่ |
| `sha256sum -c` | `OK` ทุกไฟล์ |

## เฉลย/อ้างอิงในรีโปนี้

- [`tests/vectors/`](../../../tests/vectors/README.md) (3 ไฟล์ + คู่มือรูปแบบ)
- [`tools/genvectors/main.go`](../../../tools/genvectors/main.go)
- [`tools/verify-vectors/verify.mjs`](../../../tools/verify-vectors/verify.mjs)

## ข้อควรระวัง

- **อย่าให้ AI แก้ vectors ด้วยมือ** แก้ที่ generator แล้วสร้างใหม่ เพื่อให้ทุกครั้งที่สเปกเปลี่ยน vectors เปลี่ยนตามอย่างตรวจสอบได้
- ค่า hash ของ `""`, `"a"`, `"foobar"` ควรเป็น `0x811c9dc5`, `0xe40c292c`, `0xbf9cf968` ตรงกับค่า FNV-1a ที่เผยแพร่ทั่วไป ถ้า AI ให้ค่าอื่น ผิดที่ AI
- ตัวอย่าง userId ภาษาไทย/emoji ไม่ได้มีไว้โชว์ มันคือสิ่งเดียวที่จับ bug ประเภท "hash ทีละ UTF-16 unit" ได้
