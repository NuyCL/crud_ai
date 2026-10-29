# TypeScript implementation

พอร์ตจากต้นฉบับ Go ([`../go`](../go/README.md)) ผ่านสเปกเดียวกัน ([`../spec`](../spec)), vectors และ contract test ชุดเดียวกัน โดยไม่แก้ test ใดๆ เพื่อให้ผ่าน เหตุผลของการออกแบบอยู่ใน [`../docs/porting/typescript-analysis.md`](../docs/porting/typescript-analysis.md) และสิ่งที่เรียนรู้ใน [`../lessons/typescript.md`](../lessons/typescript.md)

## โครงสร้าง

```
src/
  model/        ชนิดข้อมูลที่ใช้ร่วมกัน (interface ตาม OpenAPI)
  evaluation/   pure function ประเมิน flag + FNV-1a (Math.imul, UTF-8) + bucket
  repository/   interface + better-sqlite3 (synchronous) ; tx() ย้อนกลับเมื่อมี throw และปฏิเสธ callback แบบ async
  service/      กฎ BR-xx, parser ของ body, erfc, รายงานผลการทดลอง
  handler/      Fastify: routing, auth (onRequest), แปลง error -> status
  config.ts     อ่านตัวแปร env
  server.ts     จุดเริ่มต้น + graceful shutdown
```

dependency ไปทางเดียว: `handler → service → repository` และ `service → evaluation → model`

## รัน

| ตัวแปร | ความหมาย | Default |
|---|---|---|
| `PORT` | พอร์ต HTTP | `8080` |
| `DB_PATH` | ไฟล์ SQLite | `./flags.db` |
| `ADMIN_KEY` | key ของ admin API (**จำเป็น**) | — |
| `CLIENT_KEY` | key ของ evaluate/events (**จำเป็น**) | — |

```bash
cd typescript
npm install
npm run build
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key npm start
```

## ตรวจคุณภาพ (gates)

```bash
cd typescript && npm run build && npm run lint && npm test
```

- `lint` ใช้ `typescript-eslint` ชุด **strict + stylistic** และ `eqeqeq` (`"1" == 1` คือบั๊กที่ service นี้ห้ามมี)
- `test` build ก่อนแล้วรัน `node --test` บนไฟล์ที่ compile แล้ว; test อ่าน `../tests/vectors/*.json` ตรงๆ
- Contract test (ต้องเปิด server ก่อน) ดู [`../tests/contract/README.md`](../tests/contract/README.md)

## จุดที่ออกแบบไว้โดยเจตนา (กับดักของ JavaScript/Fastify)

- **hash:** `Math.imul(h, 16777619) >>> 0` และ `Buffer.from(s, "utf8")` (ตัวเลขเป็น double และ `charCodeAt` ให้ UTF-16)
- **ชื่อ attribute/flag ที่ชนกับ `Object.prototype`:** อ่านด้วย `Object.hasOwn`, สร้าง attributes ด้วย `Object.create(null)`, เก็บผล evaluate ใน `Map` แล้วค่อย `Object.fromEntries` (`obj["__proto__"] = x` เปลี่ยน prototype แทนที่จะเพิ่ม key)
- **JSON:** parser ของเราเอง (`JSON.parse`) แทนของ Fastify (ที่ตอบ 415 กับ form content-type, ส่ง `text/plain` เป็นสตริงดิบ และปฏิเสธ key `__proto__`)
- **error จาก framework:** `setErrorHandler` (413 -> 400), `setNotFoundHandler`, `frameworkErrors` (URL escape ผิด) และ `maxParamLength` ยกเป็น 16 KiB; route `/v1/flags/` ที่ Fastify จับคู่กับ `:key` ว่างต้องตอบ 404
- **timestamp:** ตรวจเองตามปฏิทิน (`Date.parse` ยอมรับ 30 ก.พ., ชั่วโมง 24, วันที่ล้วนๆ)
- **`erfc`:** JavaScript ไม่มี เขียนเอง แม่นกว่า 1.3e-13 สัมพัทธ์ และผ่าน `tests/vectors/erfc.json`
- **auth** เป็น hook `onRequest` เพื่อให้ตัดสินก่อนอ่าน body (BR-51)

## ข้อจำกัดที่รู้อยู่

- sync ทั้งหมดบน connection เดียว เหมาะกับ workshop ไม่ใช่โหลดสูง
- ความต่างที่ยอมรับจาก Go (ไม่มี test บังคับ): lone surrogate, header ซ้ำ, path ที่ไม่สะอาด (`//`, `/./`), รูปแบบ timestamp ใน response (ดู analysis ข้อ 6)
