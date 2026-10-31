# Module 08: รีวิวอิสระและสิ่งที่ยังเหลือ

**เป้าหมาย:** เข้าใจว่าทำไม "ผู้เขียนรีวิวงานตัวเองไม่นับ", ฝึกสั่ง `/review-port` ใน session ใหม่, ฝึกตรวจความตามรอย BR → โค้ด → test ด้วยมือ และรู้ว่าอะไรในโปรเจกต์นี้ยัง **ไม่ได้ยืนยัน**
**เวลา:** ประมาณ 20 นาที · **ระดับ:** ง่าย · **ค่าใช้จ่าย:** 0 บาท, รันในเครื่อง (ส่วน AI อาจใช้โควตาตามแพลนของคุณ) · **ใช้ AI:** prompt รีวิว (ต้อง session ใหม่)
**ก่อนหน้า:** [Module 07](07-sdk-cors.md) · **กลับไปที่:** [README](README.md) · [Cheat sheet](cheatsheet.md)

![ลำดับความจริง spec มาก่อน tests มาก่อนโค้ด](images/pyramid.svg)

## ค่าที่ใช้ในแลบ

| รายการ | ค่า |
|---|---|
| ข้อกำหนด (CLAUDE.md "ทำเสร็จเมื่อ") | ก่อนเรียก port/งานใหญ่ว่า "เสร็จ" ต้องมีรีวิวโดย session อื่นที่ไม่ได้เขียนงานนั้น (`/review-port`); ถ้ายังไม่มีให้รายงาน "ยังไม่ได้รีวิวอิสระ" |
| ภาษาที่รีวิว | `python` (ตัวอย่าง; เปลี่ยนเป็นภาษาที่คุณมี gate ผ่านแล้ว) |
| อ่านเฉพาะ | `spec/`, `tests/`, `CONVENTIONS.md`, `CLAUDE.md` และโค้ดที่รีวิว; **ห้ามอ่านก่อน:** `lessons/`, `docs/porting/`, commit message, PR |
| BR ตัวอย่างสำหรับฝึกด้วยมือ | BR-31 (ผลรวม weight = 100) |

## Prerequisites

Module 04 (รู้ว่า gate คืออะไร) · สำหรับ prompt: **session ใหม่** ที่ไม่เคยเห็นงานที่รีวิว (ปิด session เดิมหรือเปิดหน้าต่างใหม่)

## ขั้นตอน

**1. ฝึกตามรอย BR-31 ด้วยมือ: หาโค้ดที่ทำให้เป็นจริงในทุกภาษา**

```bash
grep -rIn "weights must add up to 100" go typescript/src python/app rust/src java/src | cut -c1-140
```

Expected output (ผลจริง):

```text
go/internal/service/parse.go:228:		return nil, variantsError("weights must add up to 100, got %d", sum)
typescript/src/service/parse.ts:114:  if (sum !== 100) throw variantsError(`weights must add up to 100, got ${sum}`);
python/app/parse.py:165:        raise variants_error(f"weights must add up to 100, got {total}")
rust/src/parse.rs:182:        return Err(ServiceError::variants(format!("weights must add up to 100, got {total}")));
java/src/main/java/ffservice/service/Parse.java:187:      throw ServiceError.variants("weights must add up to 100, got " + total);
```

**2. หา test ที่จะล้มถ้ากฎนี้ผิด**

```bash
grep -rIn "sum 99" go typescript/src python/tests rust/src java/src | cut -c1-120
```

Expected output (ผลจริง):

```text
go/internal/service/service_test.go:388:		"sum 99 (BR-31)":            `[{"key":"a","weight":50},{"key":"b","weight":49}
typescript/src/service/service.test.ts:206:      "sum 99 (BR-31)": two(50, 49), "sum 101 (BR-31)": two(51, 50),
```

อ่านผล: Go และ TypeScript มีชื่อ test ที่อ้าง BR-31; Python, Rust, Java **ไม่พบด้วยคำค้นนี้** นี่ไม่ได้แปลว่าไม่มี test (contract test กลางมี "weights sum to 99 -> 400 INVALID_VARIANTS" ในข้อ 2 ของ module 03 และ test หน่วยอาจใช้ชื่ออื่น) แต่แสดงว่า **ความตามรอย BR → test ของภาษาเหล่านั้นต้องไล่หาเอง**: นี่คือสิ่งที่ข้อ 1 ของ `/review-port` ให้ผู้รีวิวทำ

**3. ลองให้ session ใหม่รีวิว** (ต้องมี Claude Code: ถ้าไม่มีให้ส่ง prompt ด้านล่างให้ AI ตัวใดก็ได้ใน session ใหม่)

## Prompt สำหรับ AI: รีวิวอิสระ

ใน Claude Code (session ใหม่): `/review-port python` ตาม skill `.claude/skills/review-port/SKILL.md` หรือใช้ prompt ด้านล่าง:

```text
คุณคือผู้รีวิว ไม่ใช่ผู้เขียน และ session นี้ต้องไม่เคยเห็นการทำงานของโค้ดที่รีวิว
ถ้าในบทสนทนานี้มีงานที่คุณหรือใครเขียนมาก่อน ให้บอกแล้วหยุด: ผลรีวิวจากบริบทของผู้เขียนไม่มีค่า
อ่านเฉพาะ spec/, tests/, CONVENTIONS.md, CLAUDE.md และโค้ดของ [python/] ห้ามอ่าน lessons/, docs/porting/, commit message ก่อน (เปิดทีหลังเพื่อเทียบเท่านั้น)
1. สำหรับทุก BR-xx ใน spec/business-rules.md: หาโค้ดที่ทำให้เป็นจริง และ test ที่จะล้มถ้าโค้ดผิด
   ติดป้าย: implemented and tested / implemented, not tested / not found
2. หาพฤติกรรมที่สเปกไม่ได้บอกแต่โค้ดตัดสินใจเอง (default, ลำดับ error, Unicode, ช่วงของ integer, ลำดับ, การจัดการ header และ path)
   แต่ละอย่างคือ finding: สเปกต้องมีกฎ หรือโค้ดกำลังเดา
3. อ่าน test แบบจับผิด: ค่าที่คาดมาจากตรรกะเดียวกับโค้ดหรือไม่ กรณี "ต้องล้ม" ล้มด้วยเหตุผลมากกว่าหนึ่งอย่างหรือไม่ บอกชื่อ bug ที่น่าจะลอดผ่าน test ได้
4. ตรวจกติกา CLAUDE.md: ไม่มี dependency นอก CONVENTIONS.md โดยไม่มีบันทึกใน docs/porting/[python]-analysis.md, ไม่มีการแก้ spec/ tests/contract/ tests/vectors/, ไม่มี test ที่ถูกข้าม
5. ห้ามแก้ไฟล์ใดๆ และห้ามรันอะไรที่เขียนนอกโฟลเดอร์ชั่วคราว (รัน gate ได้)
รายงานสั้นๆ: finding เรียงตามผลกระทบ แต่ละข้อมีไฟล์:บรรทัด กฎที่ขัด (BR-xx หรือ CLAUDE.md) และ input/test ที่แสดงปัญหาได้จริง
ต่อด้วยตาราง BR จากข้อ 1 แล้วหัวข้อ "สิ่งที่ฉันตรวจไม่ได้" ถ้าไม่มี finding ให้เขียน "no findings" ได้เฉพาะเมื่อดูทุก BR แล้วเท่านั้น ห้ามเติมรายการให้ยาว
```

**ทำไม prompt นี้ได้ผล:** ข้อห้ามอ่าน `lessons/` และ `docs/porting/` ก่อนกันไม่ให้ผู้รีวิวเชื่อข้อสรุปของผู้เขียน (นั่นคือสิ่งที่กำลังตรวจ); ข้อ 1 บังคับให้ไล่ BR ทั้งหมดแทนที่จะสุ่มอ่าน; ข้อ 2-3 มาจากสิ่งที่ผู้รีวิวพบจริงในรอบแรก (mock ที่ตรงแค่ origin ตัวแรกผ่านทั้ง 10 ข้อ CORS: `lessons/summary.md` หัวข้อรีวิวอิสระรอบ 1); "ห้ามเติมรายการ" กัน finding ปลอม

**สิ่งที่ต้องตรวจจากคำตอบของ AI:**

- [ ] AI ยืนยันว่าไม่เคยเห็นงานนี้มาก่อน (หรือหยุดตามข้อกำหนด)
- [ ] ตาราง BR ครบทุกข้อ (`grep -c '^| BR-' spec/business-rules.md` = 38 ในรีโปปัจจุบัน) ไม่ใช่เฉพาะที่ AI สนใจ
- [ ] ทุก finding มีไฟล์:บรรทัดที่เปิดแล้วเห็นจริง และ input/test ที่ลองรันได้
- [ ] ไม่มีไฟล์ถูกแก้ (`git status`)
- [ ] ถ้าตอบ "no findings" ต้องมีตาราง BR ครบ

**ตัวอย่างรูปแบบคำตอบ** (รูปแบบที่ skill กำหนด; ตัวอย่างประกอบ ไม่ได้บันทึกจาก AI):

```text
Findings
1. [กลาง] python/app/parse.py:165 BR-31 ... input ที่แสดงปัญหา: {...}
BR table
| BR-31 | python/app/parse.py:165 | contract "weights sum to 99 -> 400" | implemented and tested |
What I could not check: Java/Rust ไม่ได้อยู่ในขอบเขต
```

**ถ้า AI ตอบผิดแบบนี้ ให้ทำ…**

| อาการ | ทำอะไร | ที่มา |
|---|---|---|
| รีวิวใน session เดียวกับที่เขียนแล้วบอก "ไม่พบปัญหา" | ไม่นับ: เปิด session ใหม่ | CLAUDE.md "ทำเสร็จเมื่อ" |
| รีวิวโดยอ่าน `lessons/` ก่อนแล้วสรุปตามนั้น | ให้ทำใหม่โดยอ่านลำดับที่กำหนด | `.claude/skills/review-port/SKILL.md` |
| ตาราง BR ขาด (ไม่ครบ 38) | ขอใหม่: "no findings" ใช้ไม่ได้เมื่อยังไม่ครบ | skill |
| เสนอ "แก้ test ให้ผ่าน" | ปฏิเสธ: ผู้รีวิวไม่แก้ไฟล์ และห้ามแก้ test เพื่อให้ผ่าน | CLAUDE.md |
| finding เป็นการเดาโดยไม่มี input ที่รันได้ | ขอ input จริง หรือถอด finding | skill |

## สิ่งที่ **ยังไม่ได้ยืนยัน** (อ่านก่อนนำแลบนี้ไปสอนจริง)

| เรื่อง | สถานะ | ที่มา |
|---|---|---|
| รีวิวอิสระของโปรเจกต์นี้ | **ยังไม่ได้รีวิวอิสระ** แบบเต็ม: มีรอบ 1 (CORS) โดย agent ใหม่แต่เป็นโมเดลเดียวกัน; skill `/review-port` ยังไม่เคยรันจริง | `lessons/summary.md` |
| แลบนี้เอง | เขียนและรันโดย agent ที่ไม่ใช่ผู้เรียน: **ยังไม่มีผู้เรียนจริงทดลองทำตาม** (เกณฑ์ข้อ 4 ยังเปิด) และ prompt ทุกกล่อง **ยังไม่ได้ทดสอบกับ AI จริง** | README ของแลบ |
| คนอ่านโค้ด | ไม่มีคนอ่านโค้ดของภาษาใดนอกจาก AI: ไม่รู้ว่า gate ปัจจุบันปล่อยโค้ดที่ผ่านทุก test แต่ไม่ idiomatic ไว้แค่ไหน | `lessons/summary.md` ข้อ 1 |
| 5xx | ทดสอบจากภายนอกไม่ได้ (ไม่มีทาง provoke 500) ครอบคลุมด้วย unit test ต่อภาษาเท่านั้น | `lessons/summary.md` |
| ช่องว่างที่ตั้งใจไม่ทำ | `TRACE` (`fetch` ส่งไม่ได้), `;` และ `+` ใน query (สเปกไม่ได้กำหนด) | `lessons/summary.md` |
| Java และ Rust ในแลบนี้ | ไม่ได้รัน gate/contract/differential ในแลบนี้ (รายงานผ่านใน `lessons/`) | README ของแลบ |
| ขอบเขตของข้อสรุป | "สเปก + test กลางใช้ได้จริงในโปรเจกต์นี้" ไม่ใช่ "ได้ผลกับ AI/ทีม/โปรเจกต์อื่น" | `lessons/summary.md` |

## Checkpoint

1. ทำไมการรีวิวโดย agent ใหม่ของโมเดลเดียวกันยังไม่ใช่ความเห็นอิสระเต็มที่?
2. ผล `grep "sum 99"` ไม่พบใน Python: สรุปได้ไหมว่าไม่มี test?
3. สามอย่างที่ผ่านทุก gate แต่ผู้ใช้เห็นว่าผิดในโปรเจกต์นี้คืออะไร?

<details>
<summary>เฉลย</summary>

1. ผู้เขียนกับผู้รีวิวมีจุดบอดชุดเดียวกัน (`lessons/summary.md`: "โมเดลเดียวกัน จึงไม่ใช่ความเห็นอิสระเต็มที่") รอบถัดไปควรให้คน หรือโมเดล/เครื่องมืออื่น เปิด session ใหม่แล้วรัน `/review-port` เอง
2. ไม่ได้: ชื่อ test ไม่ได้อ้าง BR-31 ต้องไล่อ่านด้วยมือ และ contract กลางครอบคลุมกฎนี้ผ่าน HTTP อยู่แล้ว
3. CORS (SDK ใช้ข้าม origin ไม่ได้), Go ที่ผ่าน test เดิมแต่ขัดสเปกเรื่อง timestamp และ UTF-8 จนภาษาอื่นเปิดโปง (`lessons/summary.md` เกณฑ์ข้อ 5) และ BR-57 ที่ Go/TypeScript/Python ล้ม 21 ข้อเมื่อมี test ใหม่

</details>

## Troubleshooting

| อาการ | แก้ |
|---|---|
| `/review-port` ไม่รู้จัก | skill โหลดตอนเริ่ม session: เปิด session ใหม่หลังสร้าง/แก้ skill (`lessons/typescript.md`); ถ้าไม่ได้ใช้ Claude Code ให้ใช้ prompt ด้านบน |
| AI อ่าน `lessons/` ก่อน | ย้ำลำดับการอ่านและให้เริ่มรีวิวใหม่ |
| grep แสดง `binary file matches` | ใช้ `-I` ตามคำสั่งในข้อ 1 |

## Clean up

ไม่มีอะไรต้องล้างใน module นี้ ล้างทั้งแลบตามหัวข้อ "Clean up ทั้งแลบ" ใน [README](README.md): ตรวจโปรเซสค้างด้วย `ps`, ปิดด้วย PID, แล้ว `rm -rf "$LAB"`
