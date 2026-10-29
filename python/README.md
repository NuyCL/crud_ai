# Python implementation

พอร์ตจากต้นฉบับ Go ([`../go`](../go/README.md)) ผ่านสเปกเดียวกัน ([`../spec`](../spec)), vectors และ contract test ชุดเดียวกัน โดยไม่แก้ test ใดๆ เพื่อให้ผ่าน เหตุผลของการออกแบบอยู่ใน [`../docs/porting/python-analysis.md`](../docs/porting/python-analysis.md) และสิ่งที่เรียนรู้ใน [`../lessons/python.md`](../lessons/python.md)

## โครงสร้าง

```
app/
  model.py        dataclass ของ Flag, Rule, Variant, Context, ... (ตาม OpenAPI)
  evaluation.py   pure function ประเมิน flag + FNV-1a (mask 32 บิต, UTF-8) + bucket
  errors.py       ServiceError + รหัส error
  parse.py        ตรวจ body/query (BR-xx), timestamp, ล้าง lone surrogate
  repository.py   Protocol + sqlite3 (stdlib); transaction() เป็น context manager
  service.py      กฎ BR-xx, audit, รายงานผลการทดลอง (math.erfc)
  handler.py      FastAPI: routing, auth, อ่าน/parse body เอง, แปล error -> status
  config.py       อ่านตัวแปร env
  main.py         จุดเริ่มต้น (`app.main:app`)
tests/            pytest: vectors, parse, service, repository, handler (ASGI ตรงๆ), config
```

dependency ไปทางเดียว: `handler → service → repository` และ `service → evaluation → model`

## รัน

| ตัวแปร | ความหมาย | Default |
|---|---|---|
| `PORT` | พอร์ต HTTP (ใช้เมื่อรัน `python -m app.main`) | `8080` |
| `DB_PATH` | ไฟล์ SQLite | `./flags.db` |
| `ADMIN_KEY` | key ของ admin API (**จำเป็น**) | — |
| `CLIENT_KEY` | key ของ evaluate/events (**จำเป็น**) | — |

```bash
cd python
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key .venv/bin/python -m app.main
# หรือ: ADMIN_KEY=... CLIENT_KEY=... .venv/bin/uvicorn app.main:app --port 8080
```

## ตรวจคุณภาพ (gates)

```bash
cd python
.venv/bin/python -m compileall -q app tests
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/pytest
```

Contract test (ต้องเปิด server ก่อน) ดู [`../tests/contract/README.md`](../tests/contract/README.md)

## จุดที่ออกแบบไว้โดยเจตนา (กับดักของ Python/FastAPI/Starlette)

- **hash:** `(h * 16777619) & 0xFFFFFFFF` และ `s.encode("utf-8")` (int ของ Python ไม่ล้น จึงต้อง mask เอง)
- **`bool` เป็น `int`:** `True == 1` ใน Python; ทุกที่ที่แยกชนิดตรวจ `bool` ก่อนตัวเลข (`as_int`, `as_scalar`, `_scalar_equal`)
- **regex:** `fullmatch` และ `[0-9]` (ไม่ใช้ `$` ที่ตรง "\n" ท้ายสตริง และไม่ใช้ `\d` ที่ตรงเลขอารบิก/เต็มความกว้าง)
- **JSON:** อ่าน body เองทั้งก้อน; `decode("utf-8")` แบบเข้มงวด; `json.loads(parse_constant=ปฏิเสธ)` (ค่าเริ่มต้นรับ `NaN`/`Infinity`); `RecursionError` (ซ้อนลึก) -> 400
- **lone surrogate:** `json.loads` รับ `"\ud800"` แล้วได้สตริงที่ encode ไม่ได้ (hash, SQLite และ response จะพัง); `clean()` แทนด้วย U+FFFD เหมือนที่ Go ทำ (BR-54)
- **query string:** parse เองแบบ `net/url` ของ Go; `request.query_params.get()` ของ Starlette คืนค่า **สุดท้าย** แต่สเปก (BR-50) ต้องการค่าแรก
- **path:** ปิด `redirect_slashes`; `%2F` ถูก ASGI server แปลงเป็น `/` ก่อน routing จึงต้องเก็บไว้ (Go จับคู่ `{key}` เป็น `a/b`); `%FF` -> 404 ตาม BR-55; escape ผิดรูป (`%zz`) -> 400
- **auth:** เทียบ SHA-256 ของสองฝั่งด้วย `hmac.compare_digest` (ถ้าเทียบ `str` ที่ไม่ใช่ ASCII จะ `TypeError` -> 500)
- **route ที่ไม่มี / method ผิด:** Starlette ตอบ 404/405 แบบของตัวเอง; ทั้งคู่ถูกแปลงเป็น 404 `FLAG_NOT_FOUND` (BR-53); ปิด `/docs`, `/redoc`, `/openapi.json`
- **ไม่ใช้ Pydantic model รับ body:** FastAPI จะตอบ 422 ในรูปแบบของตัวเอง และยอมรับ JSON แบบผ่อนปรน

## ข้อจำกัดที่รู้อยู่

- handler เป็น `async def` และเรียก service/SQLite แบบ sync ตรงๆ บน event loop: ไม่มี race ระหว่าง statement และไม่ต้องใช้ lock แต่ request หนึ่งบล็อกตัวอื่นระหว่างเข้าถึง DB เหมาะกับ workshop ไม่ใช่โหลดสูง
- ความต่างที่ยอมรับจาก Go (ไม่มี test บังคับ): response ของ rule value ที่เป็นเลขเต็ม (`1.0` แทน `1` — JSON ค่าเดียวกัน), `//` ใน path, header ซ้ำ (ดู analysis)
