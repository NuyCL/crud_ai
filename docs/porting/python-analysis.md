# การวิเคราะห์ก่อนแปล: Go → Python

ตาม [Step 8](../workshop/steps/08-pre-port-analysis.md) ทำก่อนเขียน `python/` โดยเริ่มจาก skill `spec-ambiguity-check python` (รันจริงครั้งแรกใน session นี้ หลังโหลด skill ได้) แล้ว **ทดลองกับ Go, TypeScript และ mock server** ก่อนสรุป ข้อเท็จจริงเรื่อง framework ในหัวข้อ 4 มาจากการรัน FastAPI 0.162.0 / Starlette 1.10.0 / uvicorn 0.54.0 / Python 3.13.17 ไม่ใช่ความจำ

> **ซื่อตรงเรื่องลำดับเวลา:** ผลของ `spec-ambiguity-check` ถูกใช้ก่อนแปลเพื่อแก้สเปกและเพิ่ม test (ข้อ 2) แต่ข้อ 4 แถว `%2F` **พบจาก differential test หลังแปลเสร็จ** ไม่ได้ทำนายไว้ ดู `lessons/python.md`

## 1. ส่วนของ Go ที่ใช้จริง → วิธีใน Python

| ส่วนใน Go | วิธีใน Python |
|---|---|
| `error` + `errors.Is/As` | `ServiceError(code, message)` เป็น exception; repository โยน `NotFoundError`/`ExistsError`; ใช้ `try/except` |
| `*model.Flag` = "อาจไม่มี" | `Flag \| None` |
| struct + JSON tag | `@dataclass(slots=True)` + `to_json()` (ชื่อ JSON เป็น camelCase, ชื่อฟิลด์เป็น snake_case ตาม CONVENTIONS) |
| `context.Context` | ตัดทิ้ง (sqlite3 เป็น sync) |
| `Tx(fn)` + `recover()` | `with repo.transaction() as tx:` (context manager) — `except BaseException` -> `ROLLBACK` แล้ว raise ซ้ำ |
| pool 1 connection + mutex | connection เดียว; handler เป็น `async def` เรียก sync ตรง จึงไม่มีการแทรก (ข้อจำกัดเขียนใน README) |
| `database/sql` + modernc | `sqlite3` ของ stdlib, `isolation_level=None` + `BEGIN IMMEDIATE`/`COMMIT` เอง, WAL, `busy_timeout` 5000 |
| `INSERT OR IGNORE` | SQL เดิม |
| `json.RawMessage` (audit) | เก็บเป็นสตริง JSON; `json.loads` ตอนตอบ |
| `time.Time` RFC3339Nano | `datetime` UTC; เก็บ `YYYY-MM-DDTHH:MM:SS.mmmZ` |
| `ServeMux` + catch-all `/` | FastAPI route + handler ของ `StarletteHTTPException` (404 และ 405 -> `FLAG_NOT_FOUND`) |
| middleware `admin(...)`/`clientOrAdmin(...)` | ฟังก์ชัน `require_admin/require_client_or_admin` เรียกต้น handler ก่อนอ่าน body (BR-51) |
| `recoverPanics` | middleware `guard` จับ `Exception` -> 500 `INTERNAL_ERROR` ไม่เปิดเผยรายละเอียด (ไม่ใช้ exception handler ของ `Exception` เพราะ Starlette ส่ง response แล้ว raise ซ้ำ) |
| `MaxBytesReader` + `UseNumber` + `dec.Token()` EOF | อ่าน stream เอง (นับเกิน 1 MiB แต่ยังอ่านต่อจนจบ), `decode("utf-8")` เข้มงวด, `json.loads` |
| `subtle.ConstantTimeCompare` | `hmac.compare_digest` บน SHA-256 ของทั้งสองฝั่ง |
| `regexp` | `re.fullmatch` + `[0-9]` |
| `utf8.RuneCountInString` | `len(str)` (นับ code point อยู่แล้ว) |
| `math.Erfc` | `math.erfc` (มีใน stdlib; ยังรัน `erfc.json` เป็น test) |
| `time.Parse(RFC3339)` | regex + ตรวจปฏิทินเอง (`datetime.fromisoformat` ผ่อนปรนเกิน) |
| `signal.NotifyContext` + `Shutdown` | uvicorn จัดการ SIGINT/SIGTERM |

## 2. สิ่งที่ spec-ambiguity-check พบ และจัดการก่อนแปล

แก้สเปก (`BR-52`, `BR-54`, `BR-55`, `evaluation.md` 3.1) และเพิ่ม contract test 20 ข้อ + vectors 6 แถว ทำให้ Go, TypeScript และ mock ถูกแก้ด้วย (commit `4a0f398`):

| ประเด็น | ทำไมสำคัญกับ Python | ตัวจับ |
|---|---|---|
| `bool` เป็นชนิดย่อยของ `int` | `True == 1`, `isinstance(True, int)` | vectors `target-*-bool-*` (ใหม่), `evaluation.md` 3.1 |
| `json.loads` รับ `NaN`/`Infinity` | ค่าเริ่มต้นของโมดูล | contract "not standard JSON" |
| `json.loads` รับ `"\ud800"` | สตริง encode ไม่ได้ -> hash/SQLite/response พัง | contract lone surrogate, BR-54 |
| invalid UTF-8 / UTF-16 / CESU-8 ใน body | decoder แบบผ่อนปรนจะ "ซ่อม" เป็น U+FFFD | contract invalid UTF-8, BR-52 |
| `%FF` ใน path | Go 404, TS 400, mock 500 (เป็นปัญหาของทั้งสามอยู่แล้ว) | contract BR-55 |
| `hmac.compare_digest(str, str)` | `TypeError` เมื่อมีอักขระที่ไม่ใช่ ASCII -> 500 | contract non-ASCII header, BR-55 |
| `$` ตรงก่อน `\n` ท้ายสตริง, `\d` ตรงเลข Unicode | regex ของ Python ต่างจาก Go/JS | contract timestamp เลขอารบิก/เต็มความกว้าง, test key `"a\n"` |
| ซ้อนลึกเกิน recursion limit | `RecursionError` -> 500 ถ้าไม่จับ | contract deep nesting |

## 3. กับดักตัวเลขและข้อความ

| เรื่อง | Go | Python | วิธีรับมือ | ตัวจับ |
|---|---|---|---|---|
| คูณ FNV 32 บิต | `uint32` wrap เอง | int ไม่จำกัดขนาด | `& 0xFFFFFFFF` ทุกรอบ | `fnv1a32.json`, `bucketing.json` |
| hash บนไบต์ | `s[i]` | `str` เป็น code point | `s.encode("utf-8")` | `bucketing.json` |
| `10` กับ `10.0` | `json.Number` | `int` กับ `float` | `as_int` รับทั้งคู่ (BR-30), ปฏิเสธ `bool` | test + contract |
| `1e999` | ปฏิเสธ | `float('inf')`; จำนวนเต็ม > 4300 หลัก -> `ValueError` | `math.isfinite`; `ValueError` = 400 | test ใน `test_parse.py` |
| `True == 1` | type switch | เท่ากัน | `isinstance(x, bool)` ก่อน | vectors + `test_evaluation.py` |
| `1` กับ `1.0` | ทั้งคู่ float64 | `int` กับ `float` | แปลงเป็น `float` ก่อนเทียบ | vectors |
| นับ description | rune | `len(str)` = code point | ใช้ตรงๆ (หลังล้าง surrogate) | contract 500 emoji |
| RFC 3339 | `time.Parse` | `fromisoformat` ผ่อนปรน | regex `[0-9]` + ตรวจปฏิทินเอง | contract timestamp |

## 4. Library และ framework (ทดลองจริง)

| ใช้ | อยู่ใน CONVENTIONS | หมายเหตุ |
|---|---|---|
| FastAPI 0.162.0 | ✅ | ใช้เป็น router/ASGI เท่านั้น |
| uvicorn 0.54.0 | ไม่อยู่ในตาราง library แต่อยู่ในคำสั่ง gate "เริ่ม server" | จำเป็นต่อการรัน FastAPI; **ข้อสมมติ:** ถือว่าได้รับอนุมัติแล้วโดยคำสั่ง gate |
| `sqlite3` (stdlib) | ✅ | |
| pytest 9.2.0 | ✅ | |
| ruff 0.17.3 | อยู่ในคำสั่ง gate (lint) | ข้อสมมติแบบเดียวกับ uvicorn |
| httpx | ❌ ไม่ใช้ | `TestClient` ของ FastAPI ต้องใช้ จึงทดสอบ handler ผ่าน ASGI ตรงๆ แทน (ไม่ต้องขออนุมัติ dependency เพิ่ม) |

| พฤติกรรม Starlette/FastAPI | ผลการทดลอง | วิธีรับมือ |
|---|---|---|
| `request.query_params.get("limit")` | คืนค่า **สุดท้าย** ของพารามิเตอร์ซ้ำ | parse query เองแบบ `net/url` (ค่าแรก, ทิ้งคู่ที่ escape ผิด/มี `;`) |
| `redirect_slashes` | `/v1/flags/` -> 307 ไป `/v1/flags` | `redirect_slashes=False` |
| route ที่ไม่มี / method ผิด | 404/405 รูปแบบ `{"detail": ...}` | handler ของ `StarletteHTTPException` |
| `/docs`, `/redoc`, `/openapi.json` | เปิดอยู่โดยปริยาย | ปิดทั้งหมด (BR-53) |
| `Exception` handler | ส่ง 500 แล้ว **raise ซ้ำ** (บันทึกใน log ของ uvicorn) | middleware `guard` |
| `%2F` ใน path | server แปลงเป็น `/` ก่อน routing -> `a%2Fb` ไม่ตรง route | `_route_path` (พบหลังแปล — ดูหัวข้อบนสุด) |
| `%FF` ใน path | `unquote` แทนด้วย U+FFFD -> ไม่เจอ flag -> 404 | ไม่ต้องทำอะไร ตรง BR-55 |
| ส่ง response ก่อนอ่าน body เสร็จ | อาจตัดการเชื่อมต่อ | อ่านจนจบ (ไม่เก็บส่วนเกิน 1 MiB) |

## 5. ความเสี่ยงที่ทำนายไว้ (ให้ตรวจหลังแปล — ผลอยู่ใน lessons/python.md)

1. พฤติกรรม Starlette ต่อ query/path/body/error (ตาราง 4)
2. `bool`/`int`/`float` ปะปน (ตาราง 3)
3. lone surrogate / invalid UTF-8 ทำให้ 500
4. `compare_digest` กับ header ที่ไม่ใช่ ASCII
5. recursion limit ตอน parse/ล้างข้อมูลซ้อนลึก

## 6. ความต่างที่ยอมรับ (ไม่มี test บังคับ)

- rule value ที่เป็นเลขเต็มในผลตอบกลับเป็น `1.0` (Go: `1`) — JSON ค่าเดียวกัน ทุก client ที่ parse JSON เห็นเป็นเลขเดียวกัน
- path ที่ไม่สะอาด (`//`, `/./`): Go ตอบ 301; Python ตอบ 404 (differential test ไม่สร้างกรณีนี้)
- escape ผิดรูป (`%zz`): Go ตอบ 400 เป็นข้อความธรรมดา (`text/plain`); Python ตอบ 400 JSON `VALIDATION_ERROR` (สเปกไม่ได้บอก; status เหมือนกัน)
- header ซ้ำ: ใช้ค่าแรกทั้งคู่ แต่ไม่มี test

## 7. หลังเพิ่ม CORS (BR-56) และ BR-57

อ่านจากโค้ดจริงใน `python/app/handler.py` (`create_app`) และ `python/app/config.py`: ทั้งสองเรื่องอยู่ใน middleware `guard` ตัวเดียวกับที่ตอบ `%zz` เป็น 400 และจับ exception เป็น 500 ทึบ ลำดับในตัว:

1. `%zz` (escape ผิดรูป) → 400 `VALIDATION_ERROR`
2. **BR-57:** `_encoded_outside_key(raw_path)` ตรวจ `raw_path` (ไบต์ดิบ ก่อน Starlette ถอดรหัส) ถ้ามี `%` นอก key → 404 `FLAG_NOT_FOUND` (ก่อนมีกฎนี้ Starlette ถอดรหัสทั้ง path ก่อน routing ทำให้ `/v1/%65valuate` ใช้ได้)
3. ถ้ามี `%2` ใน path ให้ route ด้วย path ที่ถอดรหัสเฉพาะ key (แก้ `%2F` ตาม BR-55)
4. **BR-56:** `cors_headers()` คืน header เมื่อ `Origin` ไม่ว่าง, path ตรงตัวกับ `/v1/evaluate`|`/v1/events`, method เป็น `POST`/`OPTIONS` และ origin อยู่ในรายการ; `OPTIONS` ตอบ 204 จาก middleware เลย (ไม่ตรวจ key); ที่เหลือเรียก `call_next` แล้ว `response.headers.update(cors)` **หลัง** `try/except` จึงติดทั้ง 4xx และ 500 ที่ middleware สร้างเอง

`CORS_ORIGINS` อ่านใน `config.py` แล้วส่งเป็นพารามิเตอร์ `cors_origins` (ไม่มี global state). ไม่ใช้ `CORSMiddleware` ของ Starlette: เขียนเองในสิบกว่าบรรทัดเพื่อให้ตรง BR-56 (origin ที่ไม่อยู่ในรายการต้องได้ 404 ตาม BR-53 ไม่ใช่ response ของ framework — ข้อสมมติของผู้เขียน ไม่ได้ทดลองกับ `CORSMiddleware` จริง)
