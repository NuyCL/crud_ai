# Module 00: เตรียมเครื่อง

**เป้าหมาย:** ตรวจเครื่องมือ, build Go ต้นฉบับ, และฝึกเปิด/ปิด server อย่างถูกวิธี (ข้อห้ามที่ AI เคยทำพลาดซ้ำสองภาษา)
**เวลา:** ประมาณ 20 นาที (build Go ครั้งแรก ~12 วินาทีที่วัดได้ ถ้ายังไม่มี module cache อาจนานกว่านี้)
**ระดับ:** ง่าย · **ค่าใช้จ่าย:** 0 บาท, รันในเครื่อง · **ใช้ AI:** ไม่
**ก่อนหน้า:** [README](README.md) · **ถัดไป:** [Module 01](01-spec-and-vectors.md)

## ค่าที่ใช้ในแลบ

| รายการ | ค่า |
|---|---|
| โฟลเดอร์ทำงาน | root ของรีโป (`crud_ai/`) ทุกคำสั่งในแลบสมมติว่าอยู่ที่นี่ |
| โฟลเดอร์ชั่วคราว | `$LAB` (สร้างจาก `mktemp -d`) |
| พอร์ต | Go `8080` (มาตรฐานของ contract test), TypeScript `8082`, Python `8083`, Go อ้างอิงสำหรับ differential `8084`, mock `8081`/`8085`, หน้าเว็บทดลอง `9001` |
| admin key / client key | `test-admin-key` / `test-client-key` (header `X-Admin-Key` / `X-Client-Key`) |
| `CORS_ORIGINS` | 3 แบบที่ใช้: `https://app.example.com,https://b.example.com` (contract) · `http://localhost:9001` (เบราว์เซอร์) · ไม่ตั้ง (ปิด) |

## Prerequisites

- ติดตั้ง Node 22+ และ Go (ดูตารางใน [README](README.md#สิ่งที่ต้องมี))
- รีโปนี้ clone แล้ว และ `pwd` อยู่ที่ root

## ขั้นตอน

**1. ตรวจเวอร์ชัน**

```bash
node -v && go version
```

Expected output (ของผู้เขียนแลบ):

```text
v22.22.0
go version go1.24.7 linux/amd64
```

**2. (ไม่บังคับ) ตรวจภาษาอื่นที่จะใช้ใน module 04-06**

```bash
python3 --version && cargo --version
```

Expected output:

```text
Python 3.13.17
cargo 1.97.0 (c980f4866 2026-06-30)
```

**3. ตั้งตัวแปรของแลบ**

```bash
export REPO="$(pwd)" LAB="$(mktemp -d)"
```

> ถ้าเปิด terminal ใหม่ต้องรันคำสั่งนี้อีกครั้ง (ตัวแปรไม่ติดไปด้วย) และ `LAB` ใหม่จะเป็นคนละโฟลเดอร์

**4. สร้างโฟลเดอร์รันและ build Go เป็นไฟล์ในโฟลเดอร์ชั่วคราว**

```bash
mkdir -p "$LAB/run"
```

```bash
( cd go && go build -o "$LAB/ffservice" ./cmd/server )
```

Expected output: ไม่มีข้อความ (ใช้ ~12 วินาทีบนเครื่องผู้เขียน) ตรวจว่ามีไฟล์:

```bash
ls -l "$LAB/ffservice"
```

**5. เปิด server ด้วยวิธีที่ถูก**

> **Why this matters:** `cd go && ./ffservice &` ทำให้ `&` ครอบทั้งชุดคำสั่ง `$!` จึงเป็น PID ของ subshell แล้ว `kill $!` ไม่ถึง server เกิดจริงสองครั้งตอนสร้างโปรเจกต์นี้ (TypeScript แล้ว Python ซ้ำ) และเกิดอีกครั้งตอนเขียนแลบนี้ จึงมีข้อห้ามใน `CLAUDE.md`

```bash
( cd "$LAB/run" && ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH="$LAB/run/flags.db" exec "$LAB/ffservice" ) &
```

server พิมพ์ log ลง terminal เดียวกัน (ตัวอย่าง: `2026/10/31 11:08:33 listening on :8080 (database /tmp/tmp.XXXX/run/flags.db)`) เก็บ PID ทันที (บรรทัดถัดไป ห้ามต่อด้วย `&&` กับบรรทัดบน):

```bash
GO_PID=$!
```

**6. รอจน `/healthz` ตอบก่อนทำอะไรต่อ**

```bash
until curl -sf localhost:8080/healthz; do sleep 0.3; done
```

Expected output:

```text
{"status":"ok"}
```

**7. ตรวจว่า `GO_PID` คือ server จริง**

```bash
ps -o pid,args -p "$GO_PID"
```

Expected output (PID และพาธต่างกันตามเครื่อง): บรรทัดที่สองต้องเป็นพาธของ `ffservice` ไม่ใช่ `bash`

```text
    PID COMMAND
   1234 /tmp/tmp.XXXXXX/ffservice
```

**8. ปิด server ด้วย PID นั้นเท่านั้น แล้วตรวจด้วย `ps`**

```bash
kill "$GO_PID"
```

```bash
ps -o pid,args -p "$GO_PID" || echo "ไม่มีโปรเซส (ถูกต้อง)"
```

Expected output: มีแค่หัวตาราง แล้วตามด้วยข้อความ

```text
    PID COMMAND
ไม่มีโปรเซส (ถูกต้อง)
```

## Checkpoint

1. ทำไมต้องเก็บ `GO_PID=$!` ในบรรทัดแยก และทำไมใช้ `exec`?
2. ทำไมตรวจ `/healthz` ก่อนรัน test แทนที่จะ `sleep 1`?
3. ทำไมแลบใช้ `ps` ไม่ใช้ `ss` ตรวจว่าไม่มีโปรเซสค้าง?

<details>
<summary>เฉลย</summary>

1. `( ... exec cmd ) &` ทำให้ subshell ถูกแทนที่ด้วย server เอง `$!` จึงเป็น PID ของ server; ถ้าใช้ `cd x && cmd &` `$!` จะเป็นของ subshell ที่ห่อทั้งชุด
2. `sleep` เป็นการเดาเวลา; ถ้า server ยังไม่พร้อม (หรือพอร์ตชน) test ทั้งชุดจะล้มและดูเหมือนโค้ดผิด ผล fail ทั้งชุดมักไม่ใช่ bug ของโค้ด (`lessons/typescript.md`)
3. ใน sandbox ที่เขียนบทเรียน `ss` คืนค่าว่างเสมอ จึงสรุปผิดว่า "ไม่มีโปรเซสค้าง" (`lessons/typescript.md` แถว server เก่าค้าง)

</details>

## Troubleshooting

| อาการ | แก้ |
|---|---|
| `go: command not found` | ติดตั้ง Go 1.22+ แล้วเปิด terminal ใหม่ |
| `until ... curl` วนไม่จบ | ดู log ใน terminal: ถ้าขาด key จะเห็น `error: ADMIN_KEY and CLIENT_KEY must both be set` (ทดสอบแล้ว) แล้ว server ไม่เริ่ม; กด Ctrl+C แล้วตรวจคำสั่งเปิด server |
| `bind: address already in use` | พอร์ต 8080 ถูกใช้: `ps -ef | grep ffservice` แล้ว `kill` เฉพาะ PID ของคุณ |

## Clean up

ถ้าทำขั้น 8 แล้ว ไม่มีอะไรต้องล้าง ถ้าข้ามขั้น 8 ให้ปิดด้วย `kill "$GO_PID"` ก่อนไป module ถัดไป โฟลเดอร์ `$LAB` เก็บไว้ใช้ต่อทุก module
