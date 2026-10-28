# Step 11: JavaScript SDK สำหรับ web (MVP3)

> ⏳ **ฉบับร่าง:** ยังไม่มี `sdk-js/` API ที่แสดงเป็นข้อเสนอจาก README ปรับได้ก่อนเริ่มสร้าง

**เป้าหมาย:** ไลบรารี TypeScript เล็กๆ ที่เว็บเรียกใช้ได้ เพื่อดึงผลการประเมิน flag และส่ง exposure/conversion โดย **สร้างจาก OpenAPI** ไม่ใช่แปลจาก Go
**เวลา:** 45 นาที · **ก่อนหน้า:** [Step 10](10-port-other-languages.md) · **ถัดไป:** [Step 12](12-retrospective.md)

## ต่างจาก step 9 อย่างไร

| step 9–10 (แปลภาษา) | step 11 (SDK) |
|---|---|
| ต้นฉบับคือโค้ด Go | ต้นฉบับคือ **สัญญา** (`spec/openapi.yaml`) |
| ตัดสินด้วย contract test ชุดเดียว | ตัดสินด้วย unit test + ทดสอบกับ server จริง |
| ผลลัพธ์เป็น service | ผลลัพธ์เป็น library ที่ผู้ใช้เป็น dev คนอื่น (API ต้องใช้ง่าย ขนาดต้องเล็ก) |

ฝึกทักษะอีกแบบ: AI สร้างจากสเปก ไม่ใช่เลียนแบบโค้ด

## การตัดสินใจก่อนเริ่ม (ตอบก่อนสั่ง AI)

| เรื่อง | แนะนำ | เหตุผล |
|---|---|---|
| ประเมินที่ไหน | **ฝั่ง server** ผ่าน `POST /v1/evaluate` | ไม่ต้อง bundle logic bucketing ฝั่ง browser, flag config ไม่รั่ว |
| key ใน browser | ใช้ **client key** เท่านั้น | key ใน JS ใครก็เห็น ห้ามใส่ admin key |
| อัปเดตค่า | polling (ปรับเวลาได้) | ง่ายกว่า SSE, ใช้ได้ทุก proxy |
| network ล่ม | ใช้ค่าล่าสุดใน cache แล้วค่อย fallback เป็น default ที่ผู้ใช้กำหนด | หน้าเว็บต้องไม่พังเพราะ flag |
| ขนาด | ไม่มี runtime dependency, เล็กกว่า 5 KB gzip (ตั้งเป้า) | โหลดบนทุกหน้า |

## API ที่เสนอ

```ts
const ff = new FlagClient({
  baseUrl: "https://flags.example.com",
  clientKey,
  user: { id: "u1", attributes: { country: "TH" } },
  pollIntervalMs: 30_000,
});
await ff.ready();                      // โหลดครั้งแรกเสร็จ (หรือใช้ cache/fallback)
ff.isEnabled("new-checkout", false);   // boolean (ค่าที่ 2 คือ default เมื่อไม่รู้ผล)
ff.getVariant("checkout-button", "blue"); // string
ff.track("purchase");                  // conversion event
ff.onChange(() => rerender());
ff.close();
```

## ขั้นตอน

### 11.1 สั่ง AI

```text
อ่าน spec/openapi.yaml, spec/evaluation.md (เฉพาะความหมายของ reason) แล้วสร้าง sdk-js/ เป็นไลบรารี TypeScript
ตาม API ใน docs/workshop/steps/11-js-sdk.md

ข้อกำหนด:
- ไม่มี runtime dependency ใช้ fetch ของ browser (ให้ inject fetch ได้เพื่อทดสอบ)
- type ของ request/response ให้ตรงกับ OpenAPI ทุกฟิลด์
- cache ผลล่าสุดใน memory และ localStorage (try/catch เพราะ localStorage อาจใช้ไม่ได้) ใช้เมื่อ network ล่ม
- exposure: ส่งเมื่อมีการอ่านค่า variant ครั้งแรกของ flag นั้นต่อ user (dedupe) แล้วรวม batch ส่ง
  POST /v1/events ไม่เกิน 100 event ต่อครั้ง
- ห้ามโยน exception ออกจาก isEnabled/getVariant/track ไม่ว่ากรณีใด (หน้าเว็บต้องไม่พัง)
- build เป็น ESM และ UMD ด้วย esbuild (dev dependency เท่านั้น)
- unit test (node:test) ด้วย fake fetch ครอบคลุม: ค่าปกติ, network ล่ม, cache, dedupe exposure, batch, polling เปลี่ยนค่า
เสร็จเมื่อ: build, lint, test ผ่าน และบอกขนาดไฟล์ gzip
```

### 11.2 ทดสอบกับ server จริง

ใช้ mock หรือ service ของภาษาใดก็ได้ที่ผ่าน contract test แล้ว:

```bash
PORT=8080 node tools/mock-server/server.mjs & MOCK_PID=$!
```

```text
เขียน sdk-js/test/integration.test.mjs ที่:
1. สร้าง flag ผ่าน admin API (key ตรงกับ mock: test-admin-key / test-client-key)
2. ให้ SDK อ่านผลแล้วตรวจ isEnabled/getVariant
3. เรียกหลาย user ตรวจว่า variant แจกตามสัดส่วนคร่าวๆ (ใช้ user 1000 คน, ยอมคลาดเคลื่อน 5%)
4. เรียก track แล้วตรวจผ่าน GET /v1/flags/{key}/results
```

```bash
kill $MOCK_PID
```

### 11.3 ตรวจขนาดและความทนทาน

```bash
cd sdk-js && npm run build
gzip -c dist/index.min.js | wc -c        # ตั้งเป้า < 5120 ไบต์
```

```text
ลองทำให้ SDK พัง: server ตอบ 500, ตอบ JSON เสีย, timeout, localStorage โยน exception, user ไม่มี id
ยืนยันด้วย test ว่าไม่มีกรณีใดทำให้ isEnabled/getVariant/track โยน exception และทุกกรณีคืนค่า default
```

## ตรวจผล

| คำสั่ง | ผลที่ถูกต้อง |
|---|---|
| `cd sdk-js && npm run build && npm run lint && npm test` | ผ่าน |
| integration test กับ mock/server จริง | ผ่าน |
| `gzip -c dist/index.min.js \| wc -c` | น้อยกว่าเป้าที่ตั้งไว้ |
| ค้นหา `throw` ใน `src/` ของ API สาธารณะ | ไม่มี (โยนได้เฉพาะตอนสร้าง client ที่ config ผิดชัดเจน) |

## ข้อควรระวัง

- AI มักแถม feature (retry แบบซับซ้อน, event emitter เต็มรูปแบบ, React hook) ที่ไม่ได้ขอ ให้ตัดออก SDK ที่เล็กและทำน้อยแต่ไม่พัง ดีกว่า
- ถ้า SDK ต้องรู้ "ความหมายของ reason" เพื่อตัดสินใจเอง แปลว่า logic รั่วมาฝั่ง client ให้ทบทวนว่า server ควรคืนค่าที่ใช้ได้เลย
- ห้ามใส่ admin key ในตัวอย่างหรือใน test ที่ build ไปรวมกับ SDK
