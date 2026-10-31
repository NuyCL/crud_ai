# แผน MVP4: อัปเดต flag แบบ real-time (SSE) และ deploy บน cloud

> **สถานะ: แผนเท่านั้น ยังไม่ได้ implement** เขียนเมื่อ 2026-10-31 หลัง MVP1–3, CORS (BR-56) และ BR-57 ปิดงานแล้ว
> ทุกข้อที่เขียนว่า "ข้อสมมติ" หรือ "ต้องตรวจ" ยังไม่ได้ทดลอง ตามกฎ `CLAUDE.md`: ห้ามเดากติกาที่สเปกไม่ได้บอก — แผนนี้จึงจบด้วยคำถามที่ต้องให้เจ้าของโปรเจกต์ตัดสินก่อนเริ่ม

## 1. ทำไมต้อง MVP4

| ปัญหาวันนี้ | หลักฐานในรีโป | MVP4 แก้อย่างไร |
|---|---|---|
| flag เปลี่ยนแล้ว client รู้ช้าสูงสุดเท่า `pollIntervalMs` (default 30 วินาที) | `sdk-js/src/client.ts` poll `POST /v1/evaluate` เป็นรอบ | **4A:** service แจ้งว่า flag ไหนเปลี่ยน SDK ประเมินใหม่ทันที |
| รันได้แค่ในเครื่อง ยังไม่เคยทดสอบบน cloud (ผู้ใช้สนใจ cloud) | ไม่มี `Dockerfile`, ไม่มีเอกสาร deploy | **4B:** container + deploy 1 ตัวอย่างพร้อม health check และ config ผ่าน env |
| เราสอน "AI สร้างและแปลงโค้ดจากสเปก" แล้ว แต่ยังไม่สอน "ฟีเจอร์ที่ framework ต่างกันมาก" | SSE ต่างกันมากในทั้ง 5 ภาษา (long-lived connection, timeout, shutdown) | เป็นบทเรียนใหม่ที่ยากกว่า MVP1–3 จริง |

**ขอบเขต MVP4 = 4A + 4B** แยก deliver ได้อิสระ (4A ก่อน แล้วจึง 4B)

## 2. 4A: การแจ้งการเปลี่ยนแปลงแบบ real-time

### 2.1 ทางเลือก (ต้องตัดสินใจ)

| ทางเลือก | ข้อดี | ข้อเสีย | ความเห็น |
|---|---|---|---|
| **A. SSE** `GET /v1/stream` | ง่ายกว่า WebSocket, ทางเดียว (server→client) ตรงกับโจทย์, ต่อใหม่เองได้ด้วย `Last-Event-ID` | ต้อง long-lived connection ใน 5 ภาษา; `EventSource` ของเบราว์เซอร์ส่ง header เองไม่ได้ (ดู 2.4) | **แนะนำ** |
| B. WebSocket | สองทาง | เกินความจำเป็น; ต้องใช้ library เพิ่มในหลายภาษา (ขัดกฎ dependency) | ไม่เอา |
| C. long-poll `GET /v1/changes?after=<id>` | ใช้ HTTP ธรรมดา ทดสอบง่ายสุด ไม่มีปัญหา proxy | latency/ภาระสูงกว่า SSE เล็กน้อย | **สำรอง** ถ้า spike ของ SSE ล้มเหลวใน Java/Rust |
| D. ลด `pollIntervalMs` | ไม่ต้องแก้ service | ภาระ evaluate สูงขึ้นตามจำนวน client | ไม่ใช่ real-time จริง |

### 2.2 แนวคิดหลัก (ข้อเสนอ ยังไม่ใช่สเปก)

1. **push แค่ "อะไรเปลี่ยน" ไม่ push ผลประเมิน** — event บอก `flagKey` และ id; SDK เรียก `POST /v1/evaluate` เอง การประเมินยังอยู่ฝั่ง server (ไม่รั่ว targeting rules และไม่ต้องรู้ context ของ client ฝั่ง service)
2. **ใช้ `id` ของ audit log (BR-07) เป็น event id** — มีอยู่แล้ว เรียงต่อเนื่อง คงอยู่ใน DB ทำให้ resume ด้วย `Last-Event-ID` ได้โดยไม่ต้องมีตารางใหม่ (ต้องตรวจว่า audit id เพิ่มทีละ 1 และไม่ถูกลบ)
3. **ส่ง event หลัง transaction ที่เขียน audit สำเร็จเท่านั้น** (สอดคล้อง BR-07: request ที่ถูกปฏิเสธไม่มี event)
4. รูปแบบ event (ร่าง):
   ```
   id: 42
   event: flag.changed
   data: {"flagKey":"new-checkout","action":"update"}

   : keepalive
   ```
   keepalive เป็น comment ทุก ~15 วินาที (ค่าที่ต้องกำหนดในสเปก)
5. **กฎใหม่ที่ต้องเขียนลง `spec/business-rules.md`** (ร่างเลข BR-58 ขึ้นไป — ต้องรอผล spec-ambiguity-check):
   - การยืนยันตัวตน: client key หรือ admin key (ตาม BR-11) ไม่ถูก → 401
   - `Last-Event-ID` ที่เก่ากว่าที่เก็บ/ไม่ถูกต้อง ทำอย่างไร (ร่าง: ส่ง event พิเศษ `resync` ให้ client ประเมินทุก flag ใหม่)
   - จำนวน connection สูงสุด และพฤติกรรมเมื่อเต็ม (ร่าง: 503 `UNAVAILABLE` — ต้องเพิ่ม code ใหม่ใน OpenAPI)
   - method อื่นบน path นี้ → 404 ตาม BR-53; path ที่เข้ารหัสไม่ใช่ endpoint ตาม BR-57
   - ปิด connection เมื่อ service shutdown (graceful) อย่างไร

### 2.3 ผลกระทบกับกฎที่มีอยู่

| กฎ | ผลกระทบ |
|---|---|
| **BR-56 (CORS)** | ปัจจุบัน CORS ครอบเฉพาะ `POST /v1/evaluate` และ `/v1/events` และ `Allow-Methods: POST` ต้องขยายให้ `GET /v1/stream` + preflight ที่ขอ `GET` (และ `Last-Event-ID`) แก้ implementation CORS ทั้ง 5 ภาษา + mock + contract test |
| BR-53 | `OPTIONS`/method อื่นบน `/v1/stream` ต้องยัง 404 ตามกฎเดิมเมื่อไม่เข้าเงื่อนไข CORS |
| BR-57 | `/v1/%73tream` ต้อง 404 (เพิ่มเคสใน contract test) |
| BR-52 (ขนาด body) | ไม่เกี่ยว (ไม่มี body) |
| spec/openapi.yaml | เพิ่ม path `GET /v1/stream` (`text/event-stream`) และ `check-openapi` ต้องผ่าน |

### 2.4 ข้อค้นพบที่ต้องออกแบบรอบๆ

- **`EventSource` ใส่ header `X-Client-Key` ไม่ได้** ทางออกที่ไม่ทำให้ key รั่วใน URL/log: SDK อ่านสตรีมด้วย `fetch` + `ReadableStream` และ parse รูปแบบ SSE เอง (ต้องเขียนเองในสเปกโค้ด ≤ ~80 บรรทัด ไม่เพิ่ม dependency) ห้ามส่ง key ผ่าน query string — ต้องระบุเป็นข้อห้ามในสเปก
- **Go:** `http.Server.WriteTimeout` ในโค้ดปัจจุบัน = 30 วินาที (`go/cmd/server/main.go:95`) จะตัดสตรีม ต้องปิดต่อ response ด้วย `http.ResponseController.SetWriteDeadline` หรือแยก handler
- **Java:** `Api` เป็น servlet `Filter` ที่ตอบเองทุกอย่าง (`java/.../handler/Api.java`) ต้องทดลองว่า Undertow รองรับการเขียนค้างและตรวจ client หลุดได้อย่างไร (อาจต้อง async)
- **Python (FastAPI) และ TypeScript (Fastify):** ต้องทดลอง `StreamingResponse` / `reply.raw` ว่าไม่ถูก middleware ที่เขียนเอง (`guard`, hook CORS/BR-57) ทำให้ buffer
- **Rust (axum):** `guard` ใช้ `tokio::spawn` ห่อ `next.run(req)` ต้องดูว่า body แบบ stream ผ่านได้และ panic guard ยังทำงาน
- **ทุกภาษา:** ตรวจจับ client หลุด (ไม่งั้นรั่ว subscriber), backpressure ของ client ช้า (ต้องมีขีดจำกัดคิวต่อ connection แล้วตัด), graceful shutdown ที่ต้องไม่ค้าง 10 วินาทีตาม `Shutdown` ของ Go
- **หลาย instance:** pub/sub ในหน่วยความจำใช้ได้เฉพาะ **instance เดียว** ถ้า deploy หลายตัวต้องมีตัวกลาง (เช่น DB notify/Redis) — **อยู่นอกขอบเขต MVP4** ต้องเขียนเป็นข้อจำกัดในเอกสาร deploy

### 2.5 งานย่อย (ลำดับแบบเดียวกับ MVP1–3)

| # | งาน | ผลลัพธ์ที่ตรวจได้ | ผู้ทำ/เครื่องมือ |
|---|---|---|---|
| 4A.1 | `spec-ambiguity-check` กับร่างกฎ + ตัดสินคำถามข้อ 6 | รายการข้อกำกวมพร้อมคำตอบ | skill `spec-ambiguity-check` |
| 4A.2 | เขียนสเปก: BR-58+ , `openapi.yaml`, ขยาย BR-56 | `check-openapi` ผ่าน | ผู้ใช้อนุมัติก่อนแก้ `spec/` |
| 4A.3 | contract test ใหม่ `tests/contract/stream.test.mjs` | ล้มทั้งหมดกับ mock เดิม | ผู้ใช้สั่งแก้ `tests/contract/` |
| 4A.4 | mock server รองรับ SSE | ผ่านชุด contract กับ mock | — |
| 4A.5 | **Go (golden)**: ทดลอง framework ก่อน (timeout, disconnect, shutdown) แล้วเขียน | unit + contract ผ่าน, `-race` สะอาด | `port-layer` ไม่ใช้ (นี่คือต้นฉบับ) |
| 4A.6 | พอร์ต TypeScript → Python → Rust → Java (Java ท้ายสุด) | gate ครบต่อภาษา + mutation check | `port-layer`, `verify-gates` |
| 4A.7 | SDK: `fetch` stream + parse SSE + reconnect (backoff) + fallback กลับไป poll | unit (fake fetch) + integration กับ service จริง | — |
| 4A.8 | browser-check: เปิดหน้า → แก้ flag ผ่าน admin → หน้าเปลี่ยนภายในไม่กี่วินาทีโดยไม่ poll | `tools/browser-check` เพิ่มโหมด | Playwright (อนุมัติแล้ว) |
| 4A.9 | differential test: ไม่เทียบสตรีมโดยตรง (timing) เทียบเฉพาะลำดับ event ที่ได้หลังชุดคำสั่งเดียวกัน | 0 ความต่าง | ต้องเขียนส่วนขยายใหม่ ถ้าไม่คุ้ม ให้ระบุว่าไม่ได้ทำ |
| 4A.10 | `/review-port` ใน session ใหม่ | ไม่มีข้อที่ต้องแก้ | ผู้ใช้ |

### 2.6 ความเสี่ยง

| เสี่ยง | ผลกระทบ | แผนรับมือ |
|---|---|---|
| Java/Undertow filter ทำสตรีมไม่ได้ | พอร์ตสุดท้ายไม่จบ | spike 1 วันก่อน commit สเปก; ถ้าล้มให้ใช้ทางเลือก C (long-poll) ทั้งสเปก |
| test ของสตรีม flaky (timing) | gate ไม่น่าเชื่อถือ | ใช้ event ที่ตรวจได้แบบกำหนดผล (รอ id เฉพาะ), timeout ใหญ่, ห้ามใช้ sleep เป็นตัวตัดสิน |
| ขยาย CORS แล้วทำให้ 5 ภาษากลับถอย | รอยร้าวที่เพิ่งปิด | contract CORS เดิม 390 ข้อต้องผ่านครบทุกโหมดก่อนและหลัง |
| รั่ว subscriber / connection ค้าง | memory โตตลอด | test ต่อ/ตัด 1,000 ครั้งแล้วดูจำนวน connection (ต้องมี metric ภายในหรือ endpoint ตรวจ — ยังไม่มีในสเปก) |
| ผู้เขียนกับผู้รีวิวเป็นโมเดลเดียวกัน | อคติร่วม | รีวิวใน session ใหม่โดยคนตามกฎ `CLAUDE.md` |

## 3. 4B: Deploy บน cloud

### 3.1 สิ่งที่มีอยู่แล้ว (ใช้ได้เลย)

- ตั้งค่าผ่าน env ล้วน: `PORT`, `DB_PATH`, `ADMIN_KEY`, `CLIENT_KEY`, `CORS_ORIGINS`
- `GET /healthz` ไม่ต้องใช้ key (BR-13) ใช้เป็น health check ได้ทันที
- graceful shutdown มีใน Go (ภาษาอื่นต้องตรวจ)

### 3.2 สิ่งที่ยังไม่มี / เป็นข้อจำกัดจริง

| เรื่อง | สถานะ | หมายเหตุ |
|---|---|---|
| Dockerfile | ❌ | ต้องเลือกว่าทำให้กี่ภาษา (ร่าง: **Go เป็นตัวหลัก** เพราะ image เล็กสุด + อีกหนึ่งภาษาเพื่อเปรียบเทียบ) |
| ที่เก็บข้อมูล | SQLite ไฟล์เดียว | ต้องมี volume ถาวร และรันได้ **instance เดียว**; บริการ container แบบไม่มี disk ถาวรใช้ตรงๆ ไม่ได้ |
| ฐานข้อมูลแบบ managed (เช่น Postgres) | ❌ | ต้องเขียน repository ใหม่ทั้ง 5 ภาษา — **อยู่นอกขอบเขต MVP4** ถ้าต้องการ ให้เป็น MVP5 |
| secret (`ADMIN_KEY`, `CLIENT_KEY`) | ส่งผ่าน env | บน cloud ต้องใช้ secret manager ของผู้ให้บริการ ห้ามใส่ใน image/โค้ด |
| log / metric | ใช้ stderr ธรรมดา | ยังไม่มี structured log (ไม่อยู่ในสเปก) |
| TLS | service ไม่ทำเอง | ให้ load balancer ทำ; ตรวจว่า LB ไม่ buffer สตรีม SSE และ idle timeout > ช่วง keepalive |

### 3.3 ทางเลือกแพลตฟอร์ม (**ยังไม่ได้ตรวจเอกสารผู้ให้บริการ** — ข้อความด้านล่างเป็นสมมติฐานที่ต้องยืนยันก่อนเลือก)

| ทางเลือก | เหมาะเมื่อ | สิ่งที่ต้องยืนยัน |
|---|---|---|
| คอนเทนเนอร์บนแพลตฟอร์มที่แนบ volume ถาวรได้ (เช่น แบบ VM-container หรือ PaaS ที่มี volume) | ต้องการสาธิตเร็ว ใช้ SQLite ต่อได้ | volume รองรับการล็อกของ SQLite หรือไม่ (ระวัง network filesystem) |
| บริการ serverless container ที่ไม่มี disk ถาวร | ต้องการสอนแนวคิด serverless | ต้องมีที่เก็บข้อมูลภายนอก → ต้องทำ MVP5 ก่อน |
| VM เดียว + Docker | เรียบง่ายสุด สอน basics ได้ครบ (network, TLS, systemd) | ไม่ใช่ "cloud-native" แต่ตรงไปตรงมา |

**ข้อเสนอ:** เลือกผู้ให้บริการหลังคุณระบุว่าอยากใช้เจ้าไหน (ผมไม่เลือกให้เอง) deliverable 4B คือ `Dockerfile` + เอกสาร deploy แบบ lab (ขั้นตอน, ค่าที่ใช้, ผลที่คาด, ค่าใช้จ่ายโดยประมาณจากหน้าราคาจริง ณ วันที่ทำ, วิธี clean up) ใน `docs/lab/`

### 3.4 งานย่อย

| # | งาน | ผลลัพธ์ที่ตรวจได้ |
|---|---|---|
| 4B.1 | ตัดสินแพลตฟอร์มและภาษาที่ deploy | บันทึกการตัดสินใจ |
| 4B.2 | Dockerfile (multi-stage, non-root, ไม่มี secret ใน image) | build ผ่าน; `docker run` แล้ว `/healthz` ตอบ; image size ที่วัดจริง |
| 4B.3 | รัน contract test (390 ข้อ) กับ container | ผ่านเท่า local |
| 4B.4 | deploy จริง + ตรวจ HTTPS, health check, restart แล้วข้อมูลยังอยู่ | บันทึกผลจริง |
| 4B.5 | รัน `tools/browser-check` กับ URL บน cloud (CORS ข้าม origin จริง) | `ok` |
| 4B.6 | เอกสาร lab + ค่าใช้จ่าย + ขั้นตอน clean up | ผู้อื่นทำตามได้ (ทดสอบกับคนจริง ≥ 1 คน) |

**ข้อควรระวัง:** การสร้างทรัพยากรบน cloud มีค่าใช้จ่ายและต้องใช้บัญชีของคุณ ผมจะไม่ deploy เองจนกว่าคุณจะสั่งและให้ข้อมูลเข้าถึงอย่างชัดเจน

## 4. การเรียนรู้/Workshop

ต่อจาก step 12 และ lab 00–08:

| ส่วนใหม่ | เนื้อหา |
|---|---|
| step 13 | เพิ่มกฎใหม่เมื่อสเปกเปลี่ยน: ขยาย BR-56 โดยไม่ทำของเดิมพัง (regression ผ่าน contract 390 ข้อ) |
| step 14 | ฟีเจอร์ long-lived connection ใน 5 ภาษา: ทดลอง framework ก่อน แล้วค่อยเขียน (ต่อยอดบทเรียน `%FF/%2F`) |
| step 15 | SDK ต่อสตรีมเอง (`fetch` stream) และ fallback เป็น poll |
| step 16 (4B) | Containerize และ deploy |
| lab 09–10 | แล็บ SSE + แล็บ deploy พร้อม prompt/ค่าที่ก๊อปได้ (รูปแบบเดียวกับ lab 00–08) |

## 5. เกณฑ์ว่า MVP4 "เสร็จ"

1. สเปก + `openapi.yaml` + contract test ใหม่ผ่าน `check-openapi` และตกกับ mock ที่ใส่ bug (mutation อย่างน้อย 3 แบบ: ไม่ส่ง event หลังลบ, ส่ง event ก่อน commit, ไม่ตรวจ key)
2. ทั้ง 5 ภาษาผ่านชุด contract ทั้งหมด (เดิม 390 + ใหม่) ในโหมด CORS ทั้ง 3 แบบ และ gate ต่อภาษา (build/lint/unit, Go `-race`)
3. SDK ได้รับการแจ้งเตือนจริงในเบราว์เซอร์ (browser-check) และตกกลับไป poll เมื่อสตรีมล่ม
4. 4B: container ผ่าน contract ทั้งชุด และ deploy บน cloud อย่างน้อย 1 แบบพร้อมบันทึกผลจริง
5. รีวิวอิสระใน session ใหม่ (`/review-port`) ไม่มีข้อที่ต้องแก้
6. เอกสารทุกจุดระบุสิ่งที่ยังไม่ได้ทดสอบ (เช่น หลาย instance, 5xx, เวลาจริงของผู้เรียน)

## 6. คำถามที่ต้องตัดสินก่อนเริ่ม

1. **SSE หรือ long-poll?** (ข้อเสนอ: SSE โดยมี spike ใน Java ก่อน ถ้าล้มให้ long-poll)
2. **ขอบเขตภาษาของ 4A:** ครบ 5 ภาษา (ข้อเสนอ ตามหลักโปรเจกต์นี้) หรือ Go + 2 ภาษา?
3. **วิธียืนยันตัวตนของสตรีม:** header `X-Client-Key` ผ่าน `fetch` (ข้อเสนอ) หรือยอมให้ส่ง key ทาง query string เพื่อใช้ `EventSource` ตรงๆ (ขัดกับหลักไม่ให้ key รั่ว)?
4. **ผู้ให้บริการ cloud และงบประมาณสำหรับ 4B** รวมถึงใครเป็นเจ้าของบัญชี/เป็นผู้ deploy จริง
5. **ที่เก็บข้อมูล:** ยอมรับข้อจำกัด SQLite + 1 instance สำหรับ MVP4 หรือต้องการ Postgres (= งานใหญ่ ควรแยกเป็น MVP5)?
6. **ตัวเลขที่ต้องกำหนดในสเปก:** ช่วง keepalive, จำนวน connection สูงสุด, จำนวน event ที่เก็บไว้ให้ resume

## 7. สิ่งที่ไม่ทำใน MVP4

- WebSocket, push ผลประเมินตรงๆ, หลาย instance/ตัวกลางข้อความ, Postgres, auth แบบอื่น, dashboard UI, การ scale อัตโนมัติ
- ไม่ implement อะไรจนกว่าคุณจะตอบข้อ 6 และสั่งเริ่ม (เอกสารนี้ไม่ได้แก้ `spec/`, `tests/` หรือโค้ด)

## 8. ประมาณการ (ค่าประมาณเชิงเปรียบเทียบ ไม่ได้วัดจริง)

| ส่วน | เทียบกับงานที่ผ่านมา |
|---|---|
| 4A สเปก + contract + mock | ใกล้เคียง CORS (BR-56) แต่ใหญ่กว่า ~2 เท่า |
| 4A Go + 4 ภาษา | ใกล้เคียง "ใส่ CORS ครบ 5 ภาษา" ×2–3 (long-lived connection ยากกว่า header) และ Java คือจุดเสี่ยงสุด |
| 4A SDK + browser-check | ใกล้เคียง step 11 |
| 4B | ขึ้นกับแพลตฟอร์มและสิทธิ์บัญชี; ส่วนที่ผมทำเองได้ในเครื่องคือ Dockerfile + contract กับ container |

เวลาจริงของโปรเจกต์นี้ไม่เคยถูกบันทึก (ดู "สถานะการปิดงาน") จึงไม่ให้ตัวเลขชั่วโมง/วัน แนะนำให้เริ่มบันทึกเวลาตั้งแต่ MVP4
