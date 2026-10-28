# crud_ai — Feature Flag Service + AI Code Conversion Workshop

โปรเจกต์ฝึกเขียนโค้ดหลายภาษาและฝึกใช้ AI แปลโค้ดอย่างมีขั้นตอน โดยใช้โจทย์เป็น **microservice สำหรับ feature flag** ที่ต่อยอดไปเป็น **A/B testing** ได้

> **สถานะ:** มีสเปกและ test vectors แล้ว ยังไม่มี implementation (`go/` เป็นขั้นถัดไป) หัวข้อที่ระบุ **TODO** จะเติมเมื่อมีโค้ด

| เอกสาร | เนื้อหา |
|---|---|
| [`spec/openapi.yaml`](spec/openapi.yaml) | สัญญา API (admin, evaluate, events) |
| [`spec/evaluation.md`](spec/evaluation.md) | ลำดับและอัลกอริทึมการประเมิน flag รวม bucketing |
| [`spec/business-rules.md`](spec/business-rules.md) | กฎ BR-xx และรูปแบบ error |
| [`tests/vectors/`](tests/vectors/README.md) | ข้อมูลทดสอบกลาง (fnv1a32 / bucketing / evaluation) |
| [`tests/contract/`](tests/contract/README.md) | contract test ผ่าน HTTP (258 ข้อ) ใช้กับทุกภาษา |
| [`docs/workshop/`](docs/workshop/README.md) | **คู่มือ workshop แบบ step-by-step** (ภาพรวม + เอกสารละเอียด 13 step) |
| [`CONVENTIONS.md`](CONVENTIONS.md) | โครงสร้าง layer, library ต่อภาษา, กับดักต่อภาษา |

## วัตถุประสงค์

1. ฝึก coding หลายภาษา: เริ่มจาก **Go** แล้วแปลเป็น **TypeScript, Rust, Java, Python**
2. สร้างขั้นตอนและแผนการใช้ AI แปลโค้ดที่ทำซ้ำได้
3. หา strategy การแปลจากโค้ดต้นฉบับไปภาษาอื่นที่ **รับประกันคุณภาพได้** และใช้เป็นเนื้อหา workshop ให้ dev ได้

## Scope ของ service

| MVP | ขอบเขต | สถานะ |
|---|---|---|
| MVP1 | Feature flag เปิด/ปิด (on/off) | Planned |
| MVP2 | A/B testing: variants, targeting, rollout %, exposure/conversion | Planned |
| MVP3 | JavaScript/TypeScript library สำหรับ web | Planned |

### MVP1: On/Off
- Admin API: สร้าง/แก้/ลบ/ดู flag (`key`, `enabled`, `description`)
- Evaluate API: `POST /v1/evaluate` ส่ง context (`userId`, attributes) ได้ผลของทุก flag ในครั้งเดียว
- Auth 2 แบบ: admin key (เขียนได้) และ client key (evaluate เท่านั้น)
- Flag ที่ไม่มีอยู่ตอบ default ที่กำหนด ไม่ error
- `key` ใช้ `[a-z0-9-_]` และเปลี่ยนไม่ได้หลังสร้าง
- บันทึก audit log ทุกการแก้ไข

### MVP2: A/B testing
- Variants พร้อม weight (รวม 100%)
- Targeting rule แบบง่าย เช่น `country == "TH"`
- Rollout เป็นเปอร์เซ็นต์
- Sticky assignment: user คนเดิมได้ variant เดิมเสมอ
- Exposure event (dedupe) และ conversion event
- รายงานผลเบาๆ: อัตรา conversion ต่อ variant และ two-proportion z-test

### MVP3: JavaScript library
```js
const ff = new FlagClient({ clientKey, user: { id: "u1", country: "TH" } });
await ff.ready();
ff.isEnabled("new-checkout");     // boolean
ff.getVariant("checkout-button"); // variant name
ff.track("purchase");             // conversion event
```
Cache (memory + localStorage), polling/SSE, ส่ง exposure แบบ batch, build เป็น ESM + UMD ไม่มี dependency

## Decisions เบื้องต้น (ยืนยันหรือเปลี่ยนได้)

- Storage: **SQLite** (ง่ายสุดสำหรับ workshop)
- Evaluate ที่ **ฝั่ง server** เท่านั้น (client-side evaluation ไว้ภายหลัง)
- มีแค่ API (ไม่มี admin UI)
- ออกแบบ naming ให้สอดคล้องกับ [OpenFeature](https://openfeature.dev)

## กลยุทธ์คุณภาพของการแปลโค้ด

โค้ดต้นฉบับ Go ไม่ใช่ตัวตัดสิน **สเปกและชุด test ที่ไม่ผูกกับภาษา** ต่างหากที่เป็นตัวตัดสิน ภาษาไหนผ่านชุดเดียวกันถือว่าแปลถูก

| ชั้น | ใช้ทำอะไร |
|---|---|
| `spec/openapi.yaml` | สัญญา API กลาง |
| `spec/evaluation.md` | ลำดับการประเมิน: flag ปิด → targeting → rollout → bucketing → variant |
| `tests/contract/` | black-box HTTP test ชุดเดียวใช้กับทุกภาษา (read-only สำหรับ AI) |
| `tests/vectors/` | ตารางค่าคาดหวังของ bucketing และ evaluation |

### Bucketing: จุดที่แปลพลาดง่ายที่สุด

```
bucket = fnv1a32(flagKey + ":" + salt + ":" + userId) mod 10000    // salt = "rollout" | "variant"
```

ทุกภาษาต้องได้ hash/bucket เท่ากันทุกแถวใน `tests/vectors/` (สร้างจาก Go และตรวจซ้ำด้วย Node) รายละเอียดอยู่ที่ [`spec/evaluation.md`](spec/evaluation.md) กับดักเรื่อง integer ของแต่ละภาษา:

| ภาษา | กับดัก |
|---|---|
| Go | `uint32` overflow วนกลับเอง |
| TypeScript | ตัวเลขเป็น double ต้องใช้ `Math.imul` และ `>>> 0` |
| Java | `int` มีเครื่องหมาย ค่าอาจติดลบ |
| Python | int ไม่ล้น ต้อง mask `& 0xFFFFFFFF` |
| Rust | ใช้ `wrapping_mul` ไม่งั้น panic ตอน debug |

## Pipeline การใช้ AI

**Phase A: สร้างต้นฉบับ Go**
1. AI ร่างสเปก (OpenAPI + business rules) → คนรีวิว
2. AI เขียน contract test จากสเปก **ก่อนมีโค้ด**
3. AI เขียน Go ทีละ layer จน test ผ่านทั้งหมด
4. AI review ตัวเอง + คนรีวิว → ได้ golden implementation

**Phase B: แปลเป็นภาษาอื่น (ทำทีละภาษา)**
1. วิเคราะห์ก่อนแปล: AI รายงานจุดที่แปลตรงๆ ไม่ได้ (error handling, concurrency, null, integer, JSON, DB driver)
2. คนอนุมัติแผน library และโครงสร้าง
3. แปลทีละ layer: model → evaluation → repository → service → handler → main (compile ผ่านก่อนไป layer ถัดไป)
4. Quality gates: build, lint/format, unit test, **contract test + vectors ชุดเดียวกับ Go**
5. ไม่ผ่าน: ส่งผล test กลับให้ AI แก้ (จำกัดจำนวนรอบ แล้วให้คนเข้ามา)
6. Idiomatic pass: รีแฟกเตอร์ให้เป็นสไตล์ภาษานั้น แล้วรัน test ซ้ำ
7. Diff review: เทียบ error response, status code, edge case กับ Go
8. บันทึกบทเรียนใน `lessons/<lang>.md`

### Prompt template (ขั้นแปล)

```
Role: senior <TARGET> engineer.
Input: spec/openapi.yaml, spec/evaluation.md, ./go/ (reference), CONVENTIONS.md
Task: port the <layer> layer to <TARGET>.
Rules:
- Behavior must match the Go reference; the spec wins if they disagree.
- Use only libraries listed in CONVENTIONS.md.
- Idiomatic <TARGET>, not line-by-line translation.
- Do not modify spec/ or tests/contract/ or tests/vectors/.
Done when: the build, lint and test commands for <lang> in CONVENTIONS.md pass with no new warnings.
Output: the code, plus a list of behavior differences or assumptions.
```

### ข้อควรระวัง
- ห้ามให้ AI แก้ test เพื่อให้ผ่าน
- แปลทีละภาษา เอาบทเรียนไปปรับ prompt ของภาษาถัดไป
- Rust (ownership) ห่างจาก Go สุด เก็บไว้ท้ายสุด
- ผ่าน test อย่างเดียวไม่พอ ต้องมีคนอ่านโค้ด เพราะเป้าหมายคือการเรียนรู้ภาษา

## แผน Workshop

| รอบ | เนื้อหา | จุดเรียนรู้เรื่อง AI |
|---|---|---|
| 1 | MVP1 ใน Go → TypeScript | pipeline: สเปก → test → โค้ด → แปล |
| 2 | MVP2 ใน Go → Python, Java | bucketing vectors จับ bug เรื่อง integer |
| 3 | MVP2 → Rust | ภาษาที่ห่างจาก Go สุด |
| 4 | MVP3 JS lib จาก OpenAPI | AI สร้างจากสัญญา ไม่ใช่การแปล |

## โครงสร้างโปรเจกต์ (planned)

```
docs/workshop/   คู่มือ workshop: README.md (ภาพรวม) + steps/NN-*.md (ละเอียด) ✅
spec/            openapi.yaml, evaluation.md, business-rules.md          ✅
tests/
  contract/      black-box HTTP tests (Node, ไม่ต้องติดตั้งอะไร)         ✅
  vectors/       fnv1a32.json, bucketing.json, evaluation.json          ✅
tools/
  genvectors/    Go generator ของ vectors                               ✅
  verify-vectors/ ตัวตรวจอิสระด้วย Node                                  ✅
  mock-server/   mock ในหน่วยความจำ ไว้พิสูจน์ว่า contract test ถูก     ✅
  check-openapi/ ตัวตรวจโครงสร้าง openapi.yaml (Python)                  ✅
go/              original implementation
typescript/      port
rust/            port
java/            port
python/          port
sdk-js/          MVP3 JavaScript library
prompts/         prompt templates
lessons/         บทเรียนต่อภาษา
CONVENTIONS.md   โครงสร้างและ library ที่ใช้ต่อภาษา
Makefile         make test-<lang>, make build-<lang>
```

## Getting started

ตรวจ test vectors (ต้องมี Go 1.22+ และ Node 22+):

```bash
cd tools/genvectors && go run . ../../tests/vectors   # สร้าง vectors ใหม่
node tools/verify-vectors/verify.mjs                  # ตรวจด้วย implementation อิสระ
```

รัน contract test กับ service (ตอนนี้ใช้ mock แทนจนกว่าจะมี `go/`):

```bash
PORT=8080 node tools/mock-server/server.mjs &
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
```

รายละเอียดและตัวแปรที่ปรับได้อยู่ใน [`tests/contract/README.md`](tests/contract/README.md)

ส่วนการรัน service จริง: **TODO** เติมเมื่อมีโค้ด

## Roadmap

1. ~~เขียน `spec/`, test vectors และ contract test~~ เสร็จแล้ว
2. MVP1 ใน Go
3. แปล MVP1 เป็น TypeScript และบันทึกบทเรียน
4. MVP2 ใน Go (variants, bucketing, events) แล้วแปลเป็น Python, Java, Rust
5. MVP3 JavaScript library
6. จัดทำเอกสารและสไลด์ workshop

## License

**TODO:** เลือก license
