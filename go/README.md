# Go implementation (golden)

ต้นฉบับของ feature flag service ที่ภาษาอื่นใช้เป็นแบบอ้างอิง ทำตามสเปกใน [`../spec/`](../spec) และผ่าน [`../tests/vectors/`](../tests/vectors/README.md) กับ [`../tests/contract/`](../tests/contract/README.md) ทั้งหมด

## โครงสร้าง

```
cmd/server/main.go        อ่าน env, เปิด database, เริ่ม HTTP server, graceful shutdown
internal/
  model/                  Flag, Rule, Variant, Context, EvaluationResult, AuditLog, Event, Results
  evaluation/             pure function ประเมิน flag + FNV-1a + bucket (ไม่แตะ DB/เวลา/network)
  repository/             interface + SQLite (modernc.org/sqlite, ไม่ใช้ cgo)
  service/                กฎธุรกิจ BR-xx, การตรวจ input, audit, รายงานผลการทดลอง
  handler/                routing, auth, JSON in/out, แปลง error -> status code
```

ลำดับ dependency ไปทางเดียว: `handler → service → repository` และ `service → evaluation → model`

## รัน

| ตัวแปร | ความหมาย | Default |
|---|---|---|
| `PORT` | พอร์ต HTTP | `8080` |
| `DB_PATH` | ไฟล์ SQLite | `./flags.db` |
| `ADMIN_KEY` | key ของ admin API (**จำเป็น**) | — |
| `CLIENT_KEY` | key ของ evaluate/events (**จำเป็น**) | — |

```bash
cd go
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key go run ./cmd/server
```

```bash
curl -s -XPOST localhost:8080/v1/flags -H 'X-Admin-Key: test-admin-key' -d '{"key":"new-checkout","enabled":true}'
curl -s -XPOST localhost:8080/v1/evaluate -H 'X-Client-Key: test-client-key' -d '{"flags":["new-checkout"],"context":{"userId":"u1"}}'
```

## ตรวจคุณภาพ (gates)

```bash
cd go
go build ./... && go vet ./... && test -z "$(gofmt -l .)" && go test -count=1 -race ./...
```

Contract test ต้องเปิด server ก่อน ดู [`../tests/contract/README.md`](../tests/contract/README.md)

## จุดที่ออกแบบไว้โดยเจตนา

- **ตัวเลขจาก JSON เป็น `json.Number`** (`UseNumber`) เพื่อแยก `10` ออกจาก `10.5` และตรวจชนิดเข้มงวด (`"50"` ไม่ใช่ตัวเลข) การถอดตรงเข้า `int` จะทำไม่ได้
- **hash วนบนไบต์** (`s[i]`) ไม่ใช่ `range` ของ string ซึ่งให้ rune; `uint32` wrap เองตามสเปก
- **`description` นับ code point** ด้วย `utf8.RuneCountInString` ไม่ใช่ `len`
- **flag กับ audit log อยู่ใน transaction เดียวกัน**; request ที่ถูกปฏิเสธไม่เขียน audit
- **pool มี 1 connection** (SQLite เขียนได้ทีละคนอยู่แล้ว และ `:memory:` ต้องการแบบนี้) ผลที่ตามมา: ห้ามใช้ repository ซ้อนใน callback ของ `Tx` และ `Tx` ต้องคืน connection แม้ callback จะ panic
- ผลของการประเมินไม่แตะ DB (BR-22)

## ข้อจำกัดที่รู้อยู่

- ทุก request ผ่าน connection เดียวของ SQLite จึงเหมาะกับ workshop/ทดลอง ไม่ใช่งานที่ต้องรับโหลดสูง
- `POST /v1/evaluate` ที่ส่ง `flags` ยาวมากจะทำ query ทีละ key (จำกัดด้วยขนาด body 1 MB)
- ไม่มี rate limit, TLS หรือการหมุนเวียน key: สิ่งเหล่านี้อยู่นอกขอบเขต workshop
