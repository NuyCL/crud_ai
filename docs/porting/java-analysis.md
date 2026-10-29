# การวิเคราะห์ก่อนแปล: Go → Java

ตาม [Step 8](../workshop/steps/08-pre-port-analysis.md) ข้อเท็จจริงเรื่อง framework ทุกข้อด้านล่างมาจากการรันจริงกับ **JDK 21.0.12, Spring Boot 3.5.16 (Tomcat 10.1.55 / Jetty 12.0.36 / Undertow 2.3.24), Jackson 2.21.4, sqlite-jdbc 3.53.4.0** ไม่ใช่ความจำ และ **ทำก่อนเขียน `Api.java`** — การทดลองเรื่อง HTTP server ในข้อ 4 เปลี่ยนการออกแบบทั้งชั้น handler

> ต่างจาก [Python](python-analysis.md): รอบนี้ไม่ได้ให้ skill `spec-ambiguity-check` รันใหม่ เพราะรายการของ `spec-ambiguity-check python` (สเปกกำกวม 8 จุด) เป็นของภาษาที่ต่างกันเฉพาะส่วนกับดักของภาษา; ส่วนที่สเปกกำกวมและแก้ไปแล้ว (BR-52, 54, 55, evaluation 3.1) ใช้ร่วมกันทุกภาษา กับดักเฉพาะ Java ในข้อ 3 ทำนายจากความรู้เรื่อง Java และยืนยันด้วยการทดลองข้อ 3–4

## 1. ส่วนของ Go ที่ใช้จริง → วิธีใน Java

| ส่วนใน Go | วิธีใน Java |
|---|---|
| `error` + `errors.Is/As` | `ServiceError` (unchecked, ไม่เก็บ stack trace) พร้อม `enum ErrorCode`; repository โยน `NotFoundException`/`ExistsException`/`StorageException` (unchecked ทั้งหมด) |
| `*model.Flag` = "อาจไม่มี" | `Flag` ที่เป็น `null` (ตรงกับ Go) |
| struct + JSON tag | `record` (immutable) + เมธอด `toJson()` ที่คืน `LinkedHashMap` (ไม่พึ่ง annotation ของ Jackson ฝั่ง model) |
| `map[string]any` | `Map<String,Object>`; ค่าใน rule/attribute เป็น `String`/`Double`/`Boolean` |
| `context.Context` | ตัดทิ้ง (JDBC ไม่ใช้) |
| `Tx(fn)` + `recover()` | `inTransaction(Consumer<Tx>)`; `catch (Throwable)` → rollback → throw ซ้ำ |
| pool 1 connection | connection เดียว + `ReentrantLock` ครอบทั้ง transaction (Undertow มีหลาย worker thread) |
| `database/sql` + modernc | JDBC + `sqlite-jdbc`, WAL, `busy_timeout` 5000, `BEGIN IMMEDIATE` |
| `ServeMux` + `recoverPanics` | `Router` + servlet filter `Api` (ข้อ 4); `catch (Exception \| StackOverflowError)` → 500 ทึบ |
| `MaxBytesReader` + `UseNumber` | อ่าน stream เอง (นับเกิน 1 MiB แต่อ่านต่อจนจบ), ถอดรหัส UTF-8 แบบเข้มงวด, Jackson |
| `subtle.ConstantTimeCompare` | SHA-256 ของสองฝั่ง + `MessageDigest.isEqual` |
| `utf8.RuneCountInString` | `String.codePointCount` (`length()` นับ UTF-16) |
| `math.Erfc` | **Java ไม่มี** — เขียนเอง ผ่าน `erfc.json` (อัลกอริทึมเดียวกับ TypeScript) |
| `time.Parse(RFC3339)` | pattern + ตรวจปฏิทินเอง |

## 2. สเปกที่แก้ไว้แล้วก่อนแปล (ใช้ร่วมกันทุกภาษา)

BR-52 (JSON เข้มงวด, UTF-8), BR-54 (lone surrogate), BR-55 (key ใน path ที่ไม่ใช่ UTF-8, header ที่ไม่ใช่ ASCII), `evaluation.md` 3.1 (bool ไม่ใช่ number, เลขเทียบแบบ double) — ดู [python-analysis.md](python-analysis.md) ข้อ 2 และ commit `4a0f398` Java ผ่านชุด contract 333 ข้อนี้ตั้งแต่รอบแรก

## 3. กับดักของ Java (ทดลองจริงด้วย `JacksonFacts.java` และ unit test)

| เรื่อง | พฤติกรรมที่พบ | วิธีรับมือ | ตัวจับ |
|---|---|---|---|
| คูณ FNV 32 บิต | `int` ล้นเองได้ตรงที่ต้องการ (ไม่ต้อง mask) แต่ `byte` มีเครื่องหมาย | `h ^= b & 0xff`; อ่านผลเป็น unsigned (`Integer.toUnsignedLong`) | vectors (mutation: ลบ `& 0xff` ถูกจับ 6 ข้อ; อ่านเป็น signed ถูกจับ 17 ข้อ) |
| `String.getBytes(UTF_8)` กับ lone surrogate | แทนด้วย `?` (0x3F) ไม่ใช่ U+FFFD → hash เปลี่ยน | `Parse.clean` ก่อนเข้าระบบ | contract + `ApiTest` |
| `Double.equals` | `0.0 != -0.0`, `NaN == NaN` | เทียบด้วย `double ==` ผ่าน `Number.doubleValue()` | `EvaluationTest` (mutation ถูกจับ) |
| `Boolean` กับ `Number` | ไม่เกี่ยวกันใน Java (ต่างจาก Python) แต่ `Object` ผสมกันได้ จึงตรวจ `instanceof` ตามลำดับ | | vectors `target-*-bool-*` |
| Jackson อ่าน `byte[]` | **เดา encoding เอง: UTF-16 และ UTF-16LE ถูกรับ** | ถอดรหัส UTF-8 เองแบบเข้มงวดแล้วส่ง `String` | contract UTF-16 |
| Jackson ปริยาย | **ไม่ปฏิเสธข้อมูลหลังค่าแรก** (`{"a":1} {"b":2}` ผ่าน) | `FAIL_ON_TRAILING_TOKENS` | contract |
| Jackson ปริยาย (อื่นๆ) | ปฏิเสธ `NaN`, `01`, `.5`, `1.`, `+1`, comment, `'`, comma ท้าย, newline ดิบ, BOM; **คีย์ซ้ำ: ค่าสุดท้ายชนะ**; ซ้อนลึก > 1000 และเลข > 1000 หลัก → `StreamConstraintsException` | ไม่ต้องทำอะไร | contract |
| `1e999999999999` | `NumberFormatException` (ไม่ใช่ `JsonProcessingException`) | จับ `RuntimeException` ที่ชั้นอ่าน body → 400 | `ApiTest` |
| `1e999` | ได้ `BigDecimal` (ไม่ error) | `Scalars.toDouble` ตัดสินจากขนาด (precision − scale) ก่อนเรียก `doubleValue()` ที่ช้า/เสี่ยงกับเลขชี้กำลังหลายพันล้าน; เกิน double → null | `ScalarsTest` |
| `-0` | `Integer 0` | `BigDecimal.signum()==0` | test |
| regex `$`/`find()` | `$` ตรงก่อน `\n` ท้ายสตริง | `matches()` | test `a\n` |
| `JAVA_TOOL_OPTIONS` ใน sandbox | พิมพ์ banner ลง stderr ทุกครั้ง | ไม่เกี่ยวกับโค้ด | — |
| locale POSIX | JVM สร้าง `Path` ที่มีอักษรไม่ใช่ ASCII ไม่ได้ | ตัดกรณีออกจาก test พร้อมเหตุผล; จดเป็นข้อจำกัดใน README | — |

## 4. การทดลอง HTTP server (เปลี่ยนการออกแบบ)

ส่ง `GET /v1/flags/<key>` ด้วย `curl --path-as-is` ไปยัง controller เปล่าๆ บนแต่ละ server:

| path | Tomcat 10.1 | Jetty 12 (UriCompliance.UNSAFE) | Undertow (`decode-url=false`, `allow-encoded-slash=true`) |
|---|---|---|---|
| `/v1/flags/%FF`, `/v1/flags/%C3%28` | **400 HTML** | key = `�` | key = `�` |
| `/v1/flags/%00` | **400 HTML** | **400 HTML** | key = NUL |
| `/v1/flags/a%2Fb` | **400 HTML** | key = `a/b` | key = `a/b` |
| `/v1/flags/a%5Cb` | **400 HTML** | key = `a\b` | key = `a\b` |
| `/v1/flags/%zz`, `/v1/flags/a%` | 400 HTML | 400 HTML | ถึงโค้ดเรา (Spring MVC โยน → 500; ใน `Api` จับเอง → 400 JSON) |
| `/v1/flags/a;b` | key = `a` (ตัด `;`) | key = `a` | key = `a` ใน Spring MVC; `a;b` เมื่อ routing เอง |
| header `X-Admin-Key: café` (ไบต์ Latin-1) | ผ่าน | ผ่าน | ผ่าน |

ข้อสรุป: BR-55 (`%FF`, `%00` → 404) ทำไม่ได้บน Tomcat และ Jetty เพราะปฏิเสธก่อนโค้ดเราทำงาน (ตอบ HTML ไม่ใช่ JSON ด้วย) → **เลือก Undertow** (`spring-boot-starter-undertow` เป็นส่วนหนึ่งของ Spring Boot 3 ไม่ใช่ dependency ใหม่นอก CONVENTIONS — แต่ตั้งเป็น **ข้อสมมติที่ต้องยืนยัน** เพราะตารางเขียนแค่ "Spring Boot 3")

บน Undertow ยังเจอปัญหาจาก Spring MVC เอง จึงเลิกใช้ controller:

| พฤติกรรมของ Spring MVC | ผล | วิธีรับมือ |
|---|---|---|
| ตัด `;param` ออกจาก path segment | `/v1/flags/a;b` เจอ flag `a` | routing เองบน `getRequestURI()` (path ดิบ) |
| `OPTIONS` | ตอบ 200 ว่างเสมอ (`FrameworkServlet.doOptions` ทับผลของ handler) — ไม่ใช่ 404 ตาม BR-53 | `Api` เป็น servlet filter ที่ไม่ส่งต่อ request เลย |
| `TRACE` | แม้ตั้ง `dispatch-trace-request=true` แล้ว Spring ยังต่อท้าย body ด้วยการสะท้อน request (`TRACE /v1/flags HTTP/1.1`) หลังคำตอบ 404 ของ handler | เช่นเดียวกัน |
| `GET /error` | `BasicErrorController` ตอบ JSON ของ Boot (`status:999`) | เช่นเดียวกัน (ไม่มี `/error` ให้ถึง) |
| `PUT` ที่ `Content-Type: application/x-www-form-urlencoded` | พฤติกรรมที่รู้กัน: `FormContentFilter` ของ Boot อ่าน body ไปก่อน (**ไม่ได้ทดลองซ้ำ** เพราะเลิกใช้ controller ก่อนถึงจุดนั้น) | `Api` อยู่หน้าสุดของ chain (`HIGHEST_PRECEDENCE`); มี test (`br52DuplicateKeysLastWins...`) |
| `%zz` | `IllegalArgumentException` ในชั้น path → 500 | `Api` ตรวจ escape ผิดรูปก่อน → 400 JSON |

## 5. ความเสี่ยงที่ทำนายไว้ (ตรวจหลังแปล — ผลอยู่ใน lessons/java.md)

1. HTTP server ถอดรหัส path ก่อนถึงโค้ด (ข้อ 4)
2. Jackson เดา encoding / ไม่ปฏิเสธข้อมูลท้าย (ข้อ 3)
3. `getBytes(UTF_8)` เปลี่ยน lone surrogate เป็น `?`
4. `byte` มีเครื่องหมายใน FNV
5. เทียบ `Double` ผิดวิธี
6. transaction ค้างเมื่อเกิด `Error`
7. สอง thread ใช้ connection เดียวกัน

## 6. ความต่างที่ยอมรับ (ไม่มี test บังคับ)

- ตัวเลข rule ในผลตอบกลับเป็น `1.0` (Go: `1`) — JSON ค่าเดียวกัน
- path ที่ไม่สะอาด (`//`, `/./`): Go ตอบ 301; Java ตอบ 404
- escape ผิดรูป (`%zz`): Go ตอบ 400 `text/plain`; Java ตอบ 400 JSON `VALIDATION_ERROR` (เหมือน Python/TypeScript)
- `HEAD`: Go ตอบเหมือน `GET` (ไม่มี body); Java ตอบ 404 (เหมือน Python)
- `DB_PATH` ที่มีอักษรไม่ใช่ ASCII ต้องรัน JVM ด้วย locale UTF-8
