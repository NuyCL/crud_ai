# Lessons: JavaScript SDK (Step 11)

บันทึกหลังสร้าง `sdk-js/` จาก `spec/openapi.yaml` (ไม่ใช่การแปลโค้ด) ตัวเลขทุกตัวมาจากการรันจริง เวลาไม่ได้บันทึก

## ตัวเลข

| ขั้น | รอบ | gate ที่จับได้ | หมายเหตุ |
|---|---|---|---|
| ออกแบบ API + types จาก OpenAPI | 1 | `tsc --strict` + `exactOptionalPropertyTypes` | |
| โค้ด (`src/client.ts` ~280 บรรทัด) | 1 | build, eslint (strict + stylistic) | ผ่านรอบแรก |
| unit test (fake fetch + เวลาปลอม) | 2 | `node --test` | ล้ม 1 ข้อ: **test เจอ bug จริงของ SDK** — เมื่อคิวเกิน 1000 ตอนส่งไม่สำเร็จ โค้ดทิ้งของ *ใหม่* แทนของเก่า (สองจุดทิ้งคนละฝั่ง) → รวมเป็นฟังก์ชัน `#trim()` ทิ้งของเก่าเสมอ |
| integration (mock → Go → Rust) | 1 | `FF_BASE_URL` | 7/7 ผ่านทั้งสามเซิร์ฟเวอร์ |
| ขนาด | 1 | `npm run size` | **1,589 ไบต์ gzip** (เป้า < 5,120) |
| mutation | 2 รอบ | `tools/mutation-check/sdk.sh` | ดูข้างล่าง |

## AI พลาดอะไร

| อาการ | สาเหตุจริง | แก้อย่างไร | ควรป้องกันที่ไหน |
|---|---|---|---|
| คิว event ทิ้งของใหม่เมื่อส่งไม่สำเร็จ | เขียน cap สองที่ต่างกัน | `#trim()` ที่เดียว | test ที่ตรวจ "ใหม่ชนะ" เขียนได้ก็ต่อเมื่อคิดถึง ลำดับของเหตุการณ์ (คิวเต็มระหว่างส่งอยู่) |
| 8 mutation จาก 43 รอดรอบแรก | test ขาดกรณี: ส่งเมื่อครบ 100 ทันที, goal ว่างไม่ใช่ event, poll ไม่ทับกัน, ตอบ 202 แต่ body ไม่ใช่ JSON ต้องนับว่าส่งแล้ว, ตอบ 500 พร้อม body ที่หน้าตาเหมือนผลลัพธ์ต้องไม่ถูกใช้, `isEnabled` ต้องไม่ส่ง exposure, `{results: []}` ต้องไม่ล้างค่าที่มี, retry อัตโนมัติหลังล้มเหลว | เพิ่ม 8 test | mutation check ใช้ได้ผลกับ SDK เท่ากับกับ service: หา test ที่ขาดเร็วกว่าอ่านโค้ด |
| 5 mutation compile ไม่ผ่าน (strict TS) | mutation ที่ออกแบบแย่ (type ไม่ลงรอย) | เขียนใหม่ให้ compile | — |
| "no timeout" mutation ดูเหมือนรอด | test ที่ค้างไม่มี fail แต่ถูก runner นับเป็น `cancelled` สคริปต์นับแต่ `fail` | สคริปต์นับ `cancelled` ด้วย | เครื่องมือต้องนับ "ไม่จบ" เป็นการจับได้ |

## สถิติ mutation

| ชุด | จำนวน | ผล |
|---|---|---|
| รอบแรก | 43 | killed 30; **รอด 8** (ทั้งหมดเป็นช่องว่างของ test จริง); compile ไม่ผ่าน 5 |
| หลังเพิ่ม 8 test และเขียน 5 ข้อที่ compile ไม่ผ่านใหม่ | 13 | killed 13 |
| เพิ่ม | 1 | รอด 1 (equivalent: เก็บ object ของ server ตรงๆ แทนการคัดลอกสามฟิลด์) |

รวม 44 distinct: killed 43, equivalent 1

## เรื่องที่ไม่ได้ทำนายไว้

1. **CORS (แก้แล้วเป็น BR-56 ดู `lessons/summary.md`):** ตอนนั้น service ตอบ `OPTIONS` เป็น 404 (BR-53) และสเปกไม่มีกติกา CORS; header `X-Client-Key` ทำให้ทุก request ข้าม origin ต้อง preflight → SDK ใช้ข้าม origin ในเบราว์เซอร์ไม่ได้จนกว่าจะมีกติกาในสเปก (หรือใช้ reverse proxy origin เดียวกัน) ตรวจพบตอนออกแบบ ไม่ใช่ตอนรัน (Node ไม่มี CORS) **ต้องให้เจ้าของโปรเจกต์ตัดสินใจ**
2. **ชุด contract ช่วย SDK ไม่ได้ตรงๆ**: SDK ไม่ใช่ service; ตัวตัดสินคือ unit (fake fetch), spec test (hard-code ตรงกับ OpenAPI) และ integration กับ service จริง
3. `Response` ใน Node อ่าน body ได้ครั้งเดียว: test ที่ใช้ `Response` ซ้ำข้ามรอบ poll ต้องสร้างใหม่ทุกครั้ง (ล้มรอบแรกจากเหตุนี้)

## สิ่งที่จะเปลี่ยน

- **CONVENTIONS.md:** เพิ่มหัวข้อ SDK (build/lint/test, devDependencies: `esbuild`, `typescript`, `eslint`, `typescript-eslint` — **ข้อสมมติที่ต้องยืนยัน** เหมือน `typescript/`)
- **สเปก (ทำแล้ว = BR-56):** กติกา CORS (`Access-Control-Allow-Origin`/`Headers` + `OPTIONS` ตอบ 204) ถ้าต้องการให้ SDK ใช้ข้าม origin ได้
