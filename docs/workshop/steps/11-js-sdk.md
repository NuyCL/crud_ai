# Step 11: JavaScript SDK สำหรับ web (MVP3)

> ✅ **ทดสอบแล้ว:** ทำจริงที่ [`sdk-js/`](../../../sdk-js/README.md) ผลและบทเรียนใน [`lessons/sdk-js.md`](../../../lessons/sdk-js.md) (ข้อจำกัด: AI ตัวเดียวกันเขียน SDK และ test; เวลาไม่ได้บันทึก; **ข้อค้นพบสำคัญ: service ไม่รองรับ CORS ตอนแรก → แก้แล้วเป็น BR-56 ดูท้ายเอกสาร**)

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
| ขนาด | ไม่มี runtime dependency, เล็กกว่า 5 KB gzip (ตั้งเป้า) | โหลดบนทุกหน้า — **ได้ 1,589 ไบต์ gzip** |

## API (ตรงกับที่สร้างจริง ยกเว้นที่ระบุ)

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
const stop = ff.onChange(() => rerender());  // คืนฟังก์ชันเลิกฟัง
await ff.flush();                      // (เพิ่มจากข้อเสนอเดิม) ส่ง event ที่ค้างอยู่ตอนนี้เลย
ff.close();
```

`flush()` เพิ่มจากข้อเสนอเดิมเพราะจำเป็นต่อการทดสอบและต่อ "ส่งก่อนปิดหน้า" ส่วน `onChange` คืนฟังก์ชัน unsubscribe

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

```text
เขียน sdk-js/test/integration.test.mjs ที่:
1. เปิด tools/mock-server บนพอร์ตว่างเอง (หรือใช้ FF_BASE_URL ถ้ามี) และสร้าง flag ผ่าน admin API
   (key: test-admin-key / test-client-key)
2. ให้ SDK อ่านผลแล้วตรวจ isEnabled/getVariant (รวม rule และ flag ที่ปิด/ไม่มี)
3. เรียกหลาย user ตรวจว่า variant แจกตามสัดส่วนคร่าวๆ (ใช้ user 1000 คน, ยอมคลาดเคลื่อน 5%)
4. เรียก track แล้วตรวจผ่าน GET /v1/flags/{key}/results ว่า exposure และ conversion ตรงกับที่ส่ง
5. ตรวจ poll เห็นการแก้ไขจาก admin API, key ผิด, และ server ที่ไม่อยู่
```

ผลจริง: 7/7 ผ่านกับ mock, **Go** และ **Rust** (`FF_BASE_URL=http://localhost:8080 node --test test/integration.test.mjs` เมื่อเปิด service ด้วย `ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key`)

### 11.3 ตรวจขนาดและความทนทาน

```bash
cd sdk-js && npm run build      # พิมพ์ขนาด gzip ของ dist/index.min.js
npm run size                    # ล้มถ้า >= 5120 ไบต์
```

```text
ลองทำให้ SDK พัง: server ตอบ 500, ตอบ JSON เสีย, timeout, localStorage โยน exception, user ไม่มี id
ยืนยันด้วย test ว่าไม่มีกรณีใดทำให้ isEnabled/getVariant/track โยน exception และทุกกรณีคืนค่า default
```

แล้วทำ **mutation check** ([`tools/mutation-check/sdk.sh`](../../../tools/mutation-check/sdk.sh)): ใส่ bug ทีละจุดในโค้ด SDK (ลบ dedupe, ลบ timeout, ให้ listener ที่ throw หยุดตัวอื่น ฯลฯ) ผลจริง 44 จุด: รอบแรกรอด 8 ซึ่งล้วนเป็น test ที่ขาด → เพิ่ม 8 test → จับได้ครบ (ดู [`lessons/sdk-js.md`](../../../lessons/sdk-js.md))

## ตรวจผล

| คำสั่ง | ผลที่ถูกต้อง (ทดสอบแล้ว) |
|---|---|
| `cd sdk-js && npm install && npm run lint && npm test` | ผ่าน: unit 53 + spec 5 + integration 7 = 65 test |
| `npm run size` | 1,589 ไบต์ gzip (< 5,120) |
| ค้นหา `throw` ใน `src/` | เฉพาะ constructor (ไม่มี `baseUrl`/`clientKey`) |
| integration กับ Go และ Rust ผ่าน `FF_BASE_URL` | ผ่านทั้งคู่ |

## ข้อควรระวัง

- AI มักแถม feature (retry แบบซับซ้อน, event emitter เต็มรูปแบบ, React hook) ที่ไม่ได้ขอ ให้ตัดออก SDK ที่เล็กและทำน้อยแต่ไม่พัง ดีกว่า
- ถ้า SDK ต้องรู้ "ความหมายของ reason" เพื่อตัดสินใจเอง แปลว่า logic รั่วมาฝั่ง client ให้ทบทวนว่า server ควรคืนค่าที่ใช้ได้เลย (SDK นี้อ่านแค่ `enabled` และ `variant`)
- ห้ามใส่ admin key ในตัวอย่างหรือใน test ที่ build ไปรวมกับ SDK (SDK ไม่มี option สำหรับ admin key)
- **CORS:** ตอนทำ SDK service ตอบ `OPTIONS` เป็น 404 (BR-53) และ `X-Client-Key` ทำให้ทุก request ข้าม origin ต้อง preflight จึงใช้ข้าม origin ไม่ได้ (Node ไม่มี CORS จึงไม่เห็นปัญหาใน test) ต่อมาเจ้าของโปรเจกต์ตัดสินใจให้เพิ่มกติกา **BR-56** (`CORS_ORIGINS`, เฉพาะ `/v1/evaluate` กับ `/v1/events`) พร้อม contract test 10 ข้อ ทั้งห้าภาษาทำตาม — บทเรียน: gate "ใช้งานจริงจากเบราว์เซอร์" ต้องมีแยกจาก test ที่รันใน Node
- **ผลจริง (gate ใหม่):** [`tools/browser-check/`](../../../tools/browser-check/README.md) (Playwright + Chromium จริง + bundle ของ SDK) ผ่านกับทั้ง 6 server (mock, Go, TypeScript, Python, Java, Rust) ทั้งโหมด `EXPECT=allowed` และ `EXPECT=blocked` — `playwright` เป็น devDependency ที่ผู้ใช้สั่งเพิ่ม (เฉพาะโฟลเดอร์นั้น, pin เวอร์ชัน) ตาม `CONVENTIONS.md`
