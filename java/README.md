# Java implementation

พอร์ตจากต้นฉบับ Go ([`../go`](../go/README.md)) ผ่านสเปกเดียวกัน ([`../spec`](../spec)), vectors และ contract test ชุดเดียวกัน โดยไม่แก้ test ใดๆ เพื่อให้ผ่าน เหตุผลของการออกแบบอยู่ใน [`../docs/porting/java-analysis.md`](../docs/porting/java-analysis.md) และสิ่งที่เรียนรู้ใน [`../lessons/java.md`](../lessons/java.md)

Java 21, Spring Boot 3.5 (Undertow), `sqlite-jdbc`, JUnit 5, Maven

## โครงสร้าง

```
src/main/java/ffservice/
  model/        record: Flag, Rule, Variant, Context, ... ; Json (Jackson แบบเข้มงวด); Scalars (ตัวเลข -> double)
  evaluation/   pure function ประเมิน flag + FNV-1a (int wrap, byte & 0xff, อ่านเป็น unsigned) + bucket
  repository/   interface Repository/Tx + SqliteRepository (JDBC, connection เดียว + lock)
  service/      FlagService (กฎ BR-xx), Parse (ตรวจ body/query), Erfc (เขียนเอง: Java ไม่มี erfc), ServiceError
  handler/      Api (servlet filter ที่ตอบทุก request), Router, Auth, Query
  Config.java   อ่านตัวแปร env
  Application.java  จุดเริ่มต้น + wiring
src/test/java/  JUnit 5: vectors, parse, service, repository, api (server จริง + raw socket), config
checkstyle.xml  กติกา lint
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
cd java
mvn -q -DskipTests package
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key java -jar target/ffservice.jar
```

## ตรวจคุณภาพ (gates)

```bash
cd java
mvn -q -DskipTests package   # build
mvn -q checkstyle:check      # lint
mvn -q test                  # unit test (รวม vectors)
```

Contract test (ต้องเปิด server ก่อน) ดู [`../tests/contract/README.md`](../tests/contract/README.md)

## จุดที่ออกแบบไว้โดยเจตนา (กับดักของ Java/Spring/Jackson)

- **hash:** `int` คูณแล้ววนรอบเอง; `byte` ของ Java มีเครื่องหมาย จึง `b & 0xff` ก่อน xor และอ่านผลเป็น unsigned (`Integer.toUnsignedLong`); `getBytes(UTF_8)`
- **HTTP server = Undertow ไม่ใช่ Tomcat:** Tomcat/Jetty ถอดรหัส path ก่อนแล้วตอบ 400 (HTML) กับ `%FF`, `%00`, `%2F` ก่อนโค้ดเราทำงาน สเปก (BR-55) ต้องการ 404 / เป็นส่วนของ key; Undertow กับ `decode-url=false` ให้ path ดิบ ดูผลทดลองใน analysis
- **ไม่ใช้ Spring MVC controller:** `Api` เป็น servlet filter ที่ตอบเองทุก request (MVC ถอดรหัส path ก่อนจับคู่, ตัด `;param`, ตอบ OPTIONS/TRACE เอง และมีหน้า error ของตัวเอง) `Router` จับคู่แบบ ServeMux ของ Go บน path ดิบ
- **JSON:** Jackson เข้มงวดตาม RFC 8259 โดยปริยาย (ปฏิเสธ `NaN`, เลขนำหน้า 0, comment, ฯลฯ) เปิด `FAIL_ON_TRAILING_TOKENS` และ `USE_BIG_DECIMAL_FOR_FLOATS`; **ถอดรหัส UTF-8 เองแบบเข้มงวดก่อน** (ถ้าให้ Jackson อ่าน byte มันจะเดา UTF-16/32 แล้วรับ); ซ้อนลึกเกิน 1000 ชั้นหรือเลขยาวเกิน 1000 ตัว Jackson ปฏิเสธเอง
- **lone surrogate:** Jackson รับ `"\ud800"` และ `String.getBytes(UTF_8)` แทนด้วย `?` ทำให้ hash เปลี่ยน จึง `Parse.clean` แทนด้วย U+FFFD เหมือน Go (BR-54)
- **ตัวเลข:** `Boolean` ไม่ใช่ `Number` ใน Java (ต่างจาก Python); เทียบด้วย `double ==` ไม่ใช่ `Double.equals` (ที่บอกว่า `0.0 != -0.0` และ `NaN == NaN`)
- **regex:** `matches()` (ทั้งสตริง) ไม่ใช้ `find()` / `$`; `[0-9]`
- **auth:** เทียบ SHA-256 ของสองฝั่งด้วย `MessageDigest.isEqual`; header อ่านเป็น Latin-1 (ไบต์) จึงไม่มีค่าไหนที่ทำให้ crash
- **สัญญา transaction:** `catch (Throwable)` -> rollback -> throw ซ้ำ (รวม `Error`) แล้วค่อย `setAutoCommit(true)` (ซึ่งจะ commit ถ้ายังค้าง)
- **`erfc`:** Java ไม่มี เขียนเอง ผ่าน `tests/vectors/erfc.json`

## ข้อจำกัดที่รู้อยู่

- connection เดียว + lock ต่อ operation: เหมาะกับ workshop ไม่ใช่โหลดสูง
- JVM ที่รันใน locale POSIX สร้าง `Path` ที่มีอักษรที่ไม่ใช่ ASCII ไม่ได้ (`sun.jnu.encoding=ANSI_X3.4-1968`) ดังนั้น `DB_PATH` แบบนั้นต้องรันด้วย locale UTF-8 (ข้อจำกัดของสภาพแวดล้อม ไม่ใช่ของ service)
- ความต่างที่ยอมรับจาก Go: ดู analysis ข้อ 6
