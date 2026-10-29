# JavaScript SDK (MVP3)

ไลบรารีเล็กๆ สำหรับเว็บ ดึงผลการประเมิน flag จาก service และส่ง exposure/conversion **สร้างจาก [`../spec/openapi.yaml`](../spec/openapi.yaml)** (ไม่ได้แปลจากโค้ด Go) ไม่มี runtime dependency · ESM + UMD · **1.6 KB gzip** (เป้า < 5 KB)

## ใช้

```js
import { FlagClient } from "ffservice-js-sdk";

const ff = new FlagClient({
  baseUrl: "https://flags.example.com",
  clientKey,                                   // CLIENT key เท่านั้น: ทุกอย่างใน browser เป็นสาธารณะ
  user: { id: "u1", attributes: { country: "TH" } },
  pollIntervalMs: 30_000,                      // 0 = ไม่ poll
});
await ff.ready();                              // โหลดครั้งแรกเสร็จ (หรือใช้ cache/fallback) ไม่เคย reject
ff.isEnabled("new-checkout", false);           // boolean; ค่าที่ 2 = ค่าเมื่อไม่รู้ผล
ff.getVariant("checkout-button", "blue");      // string; การอ่านครั้งแรกส่ง exposure ให้เอง
ff.track("purchase");                          // conversion
const stop = ff.onChange(() => rerender());    // เรียกเมื่อ poll ได้ค่าที่ต่างไป; stop() เพื่อเลิกฟัง
await ff.flush();                              // (ไม่บังคับ) ส่ง event ที่ค้างอยู่ตอนนี้เลย
ff.close();                                    // หยุด poll แล้วส่ง event ที่ค้าง
```

ทางเลือกอื่นของ options: `flushIntervalMs` (2000), `timeoutMs` (5000), `fetch` (แทน `fetch` ของ global), `storage` (แทน `localStorage`; `null` = ไม่เก็บ cache)

`<script src="index.umd.js">` ได้ global `FeatureFlags.FlagClient` และ `require("./dist/index.umd.js")` ได้ object เดียวกัน

## พฤติกรรมที่รับประกัน

| เรื่อง | พฤติกรรม |
|---|---|
| ประเมินที่ไหน | ฝั่ง server ผ่าน `POST /v1/evaluate` (ไม่ส่ง `flags` = ทุก flag); SDK อ่านแค่ `enabled` และ `variant` ไม่ตีความ `reason` |
| ห้ามพัง | `isEnabled`, `getVariant`, `track`, `onChange`, `close`, `flush`, `ready` **ไม่ throw/reject ไม่ว่ากรณีใด** (network ล่ม, 500, JSON เสีย, timeout, localStorage โยน exception, ข้อมูลผิดรูป); `new FlagClient` throw `TypeError` เฉพาะเมื่อไม่มี `baseUrl` หรือ `clientKey` |
| network ล่ม | ใช้ค่าล่าสุดใน cache (memory + `localStorage` ต่อ service/user/attributes) แล้วค่อย fallback ที่ผู้ใช้ให้ไว้; poll รอบถัดไปลองใหม่ |
| exposure | ส่งเมื่ออ่าน variant ของ flag นั้นครั้งแรกต่อ client (dedupe ในหน่วยความจำ; server เก็บ "ครั้งแรกชนะ" อยู่แล้ว) ไม่ส่งถ้าไม่มี user id |
| batch | รวม event ส่งทุก `flushIntervalMs` หรือเมื่อครบ 100; ไม่เกิน 100 ต่อ request (OpenAPI `maxItems`) |
| ส่งไม่สำเร็จ | network/5xx → เก็บไว้ส่งรอบหน้า (สูงสุด 1000 เหตุการณ์ ทิ้งของเก่า); 4xx → ทิ้ง (ลองใหม่ก็ไม่ดีขึ้น) |
| ไม่ค้างโปรเซส | timer ของ SDK เรียก `unref` ใน Node |

## สร้างและตรวจ

```bash
cd sdk-js
npm install
npm run build   # dist/index.js (ESM), index.min.js, index.umd.js, types/ ; พิมพ์ขนาด gzip
npm run lint
npm test        # build แล้วรัน node --test: unit (fake fetch), spec, integration (เปิด tools/mock-server เอง)
npm run size    # ล้มถ้า gzip ของ index.min.js >= 5120 ไบต์
```

Integration test กับ service อื่น: เปิด service ด้วย `ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key` แล้ว `FF_BASE_URL=http://localhost:8080 node --test test/integration.test.mjs`

| ชุด test | ครอบคลุม |
|---|---|
| `test/client.test.mjs` (fake fetch) | ค่าปกติ, ค่า fallback, network ล่ม/500/401/HTML/JSON เสีย/รูปผิด/ไม่ตอบ (timeout), cache + storage ที่ throw, user ไม่มี id, dedupe exposure, batch ≤ 100, retry/ทิ้ง, cap 1000, polling (เวลาปลอม), onChange, `close`, ไม่ throw กับ input อะไรก็ได้ |
| `test/spec.test.mjs` | ค่าที่ hard-code (reason, ชนิด event, batch 100, ชื่อ header, path) ตรงกับ `spec/openapi.yaml` |
| `test/integration.test.mjs` | กับ server จริง: อ่าน flag + rule, 1000 user แจก variant ตามสัดส่วน (±5%), exposure/conversion ครบตาม `GET /v1/flags/{key}/results`, poll เห็นการแก้ไข, key ผิด, server ไม่อยู่ |

ผ่านกับ mock, Go และ Rust (`FF_BASE_URL`) มี mutation check ที่ [`../tools/mutation-check/sdk.sh`](../tools/mutation-check/sdk.sh)

## ข้อจำกัดที่ต้องรู้ก่อนใช้จริง

- **CORS:** service **ยังไม่ตอบ CORS** (สเปกไม่ได้กำหนด และ `OPTIONS` ตอบ 404 ตาม BR-53) เบราว์เซอร์ที่เรียกข้าม origin จะถูก preflight (`X-Client-Key` เป็น header กำหนดเอง) บล็อก → ใช้งานได้เมื่อเว็บกับ service อยู่ origin เดียวกัน (reverse proxy path เช่น `/flags/`) จนกว่าจะมีกติกา CORS ในสเปก (**ต้องตัดสินใจ**; SDK แก้เองไม่ได้)
- ไม่มี retry แบบ backoff, ไม่ใช้ `sendBeacon` ตอนปิดหน้า (event ที่ค้างตอน `pagehide` อาจหาย: เรียก `flush()` ก่อนเอง), ไม่มี SSE
- เปลี่ยน user = สร้าง `FlagClient` ใหม่ (`close()` ตัวเก่า)
- dedupe exposure อยู่ในหน่วยความจำ: โหลดหน้าใหม่ส่ง exposure ซ้ำ แต่ server นับ (flag, user) ครั้งเดียวอยู่แล้ว (BR-40)
