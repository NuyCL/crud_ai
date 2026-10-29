# Step 9: แปลเป็น TypeScript (ทีละ layer พร้อม quality gates)

**เป้าหมาย:** service เวอร์ชัน TypeScript ที่ผ่าน unit test, vectors และ contract test **ชุดเดียวกับ Go โดยไม่แก้ test เพื่อให้ผ่าน** และทำงานเหมือน Go ในจุดที่ไม่มีใครเขียน test
**เวลา:** 60 นาที (ไม่รวม differential test) · **ก่อนหน้า:** [Step 8](08-pre-port-analysis.md) · **ถัดไป:** [Step 10](10-port-other-languages.md)

> ✅ **มีเฉลยและทดสอบแล้ว:** โค้ดอยู่ใน [`typescript/`](../../../typescript/README.md) บทเรียนละเอียดอยู่ใน [`lessons/typescript.md`](../../../lessons/typescript.md) คำสั่งตรวจในเอกสารนี้รันจริงแล้ว
> **ข้อควรทราบอย่างตรงไปตรงมา:** โค้ดสร้างโดยทำตามวงจรนี้ในบทสนทนาเดียวที่มีบริบทของ step 1–8 อยู่แล้ว skill `port-layer` ไม่ได้ถูกเรียกผ่านเครื่องมือ (session นั้นไม่โหลด skill ที่เพิ่งสร้าง) จึงทำตามขั้นตอนในไฟล์ด้วยมือ ผลของคุณอาจต่างในโครงสร้างภายใน; สิ่งที่ต้องตรงกันคือผลของ gate

## ผลที่ได้ (เฉลย)

| ตรวจอะไร | ผล |
|---|---|
| `npm run build && npm run lint && npm test` | ผ่าน: unit test 161 ข้อ (รวม vectors ทั้ง 4 ไฟล์), lint แบบ **strict + stylistic** |
| contract test กับ server จริง | **313/313** ผ่านรอบแรก ทั้งแบบเรียง ขนาน และรันซ้ำบน database เดิม (ชุดต่อมาเป็น 333 ข้อ ใน step 10: TypeScript ผ่านหลังแก้ parser และ frameworkErrors) |
| mutation check | unit: evaluation 7/7, repository 9/9, service 19/19; HTTP: handler 9/9 (หลังเติม test 1 ข้อ) |
| differential test กับ Go | 0 ความต่างใน seed 1–9 (ก่อนเพิ่ม scenario สถิติ) และ 11–14 (หลังเพิ่ม) |

## หลักคิด

ขั้นนี้คือหัวใจของ workshop: ใช้ **วงจรเดียวกับทุก layer** และทุกภาษาต่อจากนี้ (step 10) ใช้วงจรนี้

```
/port-layer typescript <layer> ──▶ gates ผ่าน? ──▶ mutation check ──▶ commit ──▶ layer ถัดไป
                                       │ ไม่ผ่าน (ไม่เกิน 3 รอบ) ──▶ ให้ AI แก้ ──▶ รัน gates ใหม่
                                       └ ยังไม่ผ่านรอบที่ 3 ──▶ คนอ่านเอง
```

ลำดับ layer: `model → evaluation → repository → service → handler → main`

**สิ่งที่ต้องทำก่อนแปล** (จาก step 8): ทุกความเสี่ยงที่ "ไม่มีตัวจับ" ต้องเติม test ก่อน ในเฉลยนั่นคือ vectors 6 case, contract test 39 ข้อ (จาก 260 เป็น 299) และการแก้สเปก 5 จุด ทั้งหมดผ่านกับ Go ก่อนที่จะเขียน TypeScript บรรทัดแรก

## เตรียมโครงโปรเจกต์ (ครั้งเดียว)

```text
อ่าน CONVENTIONS.md และ docs/porting/typescript-analysis.md แล้วสร้างโครง typescript/ เท่านั้น (ยังไม่แปล layer ใด):
package.json (type: module, scripts: build / lint / test / start), tsconfig.json (strict, NodeNext, noUncheckedIndexedAccess),
eslint.config.js (typescript-eslint, ใช้ชุด strict + stylistic และกฎ eqeqeq), .gitignore (node_modules, dist, *.db*)
ใช้ node:test, Fastify, better-sqlite3 ตาม CONVENTIONS; ติดตั้งแบบ --save-exact
เขียน test ทดสอบ toolchain 1 ไฟล์ (เปิด better-sqlite3 ในหน่วยความจำ และสร้าง/ปิด Fastify)
เสร็จเมื่อ: cd typescript && npm install && npm run build && npm run lint && npm test ผ่านโดยยังไม่มีโค้ดของ service
```

ในเฉลย: Fastify 5.12.7, better-sqlite3 13.0.3, TypeScript 6.0.3 (ผ่านโดยไม่ต้อง compile native เพราะมี prebuilt)

## ขั้นตอน (ทำซ้ำสำหรับแต่ละ layer)

### 9.1 แปล layer

ถ้ามี skill จาก step 7 (**เริ่ม session ใหม่หลังสร้าง skill** มิฉะนั้นจะเรียกไม่ได้):

```text
/port-layer typescript model
```

ถ้าไม่มี skill ให้วาง prompt นี้:

```text
แปล layer <layer> ของ go/internal/<layer>/ เป็น typescript/src/<layer>/
อ่านก่อน: CONVENTIONS.md, spec/, docs/porting/typescript-analysis.md และโค้ด Go ของ layer นี้
- เขียนแบบ idiomatic TypeScript ไม่ใช่แปลทีละบรรทัด ใช้เฉพาะ library ใน CONVENTIONS.md
- unit test อยู่ข้างโค้ด; layer evaluation ต้องอ่าน tests/vectors/*.json ทุกแถว
- ห้ามแก้ spec/, tests/contract/, tests/vectors/ และห้ามข้ามหรือแก้ test เพื่อให้ผ่าน
- รัน gate: cd typescript && npm run build && npm run lint && npm test
- ถ้า gate fail แก้โค้ดแล้วรันใหม่ ไม่เกิน 3 รอบ แล้วรายงาน
รายงานท้ายงาน: ไฟล์ที่เปลี่ยน, ผล gate, ความต่างของพฤติกรรมจาก Go, ข้อสมมติ
```

**ที่เกิดขึ้นจริงต่อ layer:**

| layer | สิ่งที่ต้องระวัง (จากรายงาน step 8) | ผล |
|---|---|---|
| model | `interface` ไม่ใช่ class; attributes เป็น `Record` ที่สร้างโดยไม่มี prototype | ผ่านรอบแรก |
| evaluation | `Math.imul(...) >>> 0`, `Buffer.from(s, "utf8")`, `Object.hasOwn`, `typeof a === typeof b && a === b` | ผ่านรอบแรก 75 test |
| repository | `db.transaction` ย้อนกลับเมื่อ throw; callback แบบ **async** ถูก commit ก่อนทำงานเสร็จ จึงต้องปฏิเสธ; path ไม่ต้อง escape เพราะรับชื่อไฟล์ ไม่ใช่ URI | ผ่านรอบแรก |
| service | `erfc` เขียนเอง, timestamp ตรวจเอง, `Array.from(s).length`, `Map` สำหรับผล evaluate | ผ่านรอบแรก |
| handler + main | override ค่าเริ่มต้นของ Fastify หลายอย่าง (ดูรายการใน `typescript/README.md`) | **3 รอบ**: type error ของ `reply.code()` (รับเฉพาะ literal), `:key` ว่าง, `maxParamLength` |

### 9.2 อ่านรายงานของ AI ก่อน commit

ถามตัวเอง 3 ข้อ:

1. "ความต่างของพฤติกรรม" ว่างเปล่าหรือไม่? ถ้าว่าง ให้สงสัย ภาษาต่างกันย่อมมีอะไรต่างบ้าง
2. gate ผ่านจริงหรือ AI แค่บอก? รัน `npm test` ซ้ำเองหนึ่งครั้ง
3. มีไฟล์ใน `spec/` หรือ `tests/` ถูกแก้ไหม?

```bash
git status --short -- spec tests      # ต้องไม่แสดงอะไร ถ้ามีรายการ แปลว่า AI แตะไฟล์ที่ห้ามแก้
git add -A && git commit -m "Port <layer> to TypeScript"
```

### 9.3 Mutation check: พิสูจน์ว่า test ของ layer นั้นไวจริง

test ที่ผ่านรอบแรกเกือบหมด (เพราะพอร์ตจาก test ของ Go) พิสูจน์ได้น้อยกว่าที่คิด วิธีตรวจคือใส่ bug แล้วดูว่า test จับไหม [`tools/mutation-check/ts.sh`](../../../tools/mutation-check/ts.sh) ทำสิ่งนี้ในสำเนาชั่วคราว (ไม่แตะโค้ดจริง):

```bash
tools/mutation-check/ts.sh unit evaluation/index.ts "float multiply instead of Math.imul" <<'PY'
import sys; p = sys.argv[1]; s = open(p).read()
a = "Math.imul(h, 0x01000193) >>> 0"; assert a in s
open(p, "w").write(s.replace(a, "(h * 0x01000193) >>> 0"))
PY
```

ผลที่ถูกต้อง: `killed (20 failing) e.g. fnv1a32("b") = ...` ผลที่เป็นไปได้มี 3 แบบ:

| ผล | ความหมาย | ทำอะไร |
|---|---|---|
| `killed` | test จับ bug ได้ | ดีแล้ว |
| `SURVIVED` | ไม่มี test สังเกตเห็น | ถามก่อนว่า bug นี้เปลี่ยนพฤติกรรมจริงไหม (ถ้าไม่ ก็คือ equivalent mutant เช่น ตัด `>>> 0` ที่มี `>>> 0` ตามหลังอยู่แล้ว) ถ้าเปลี่ยนจริง **เติม test** |
| `BUILD FAILED` | bug ที่ใส่ไม่ compile | ไม่ใช่การทดลองที่ใช้ได้ ปรับให้ยัง compile |

ชุดที่ควรลองต่อ layer (ทั้งหมดถูกจับในเฉลย):

- evaluation: คูณแบบ float, hash แบบ UTF-16, ลำดับ FNV-1, lookup ด้วยค่าแทน `hasOwn`, `==` แทน `===`, ขอบ rollout เกินไป 1
- repository: ไม่มี transaction, ยอมรับ callback async, เรียง DESC, exposure หลังทับแรก, conversion ไม่สนใจ goal
- service: นับ description เป็น UTF-16, attributes เป็น object ธรรมดา, `Date.parse` อย่างเดียว, ไม่ตรวจปฏิทิน, รับ `10.5`, ลืมตรวจผลรวม weight, ลืม audit ตอนลบ, z ไม่ใช่ค่าสัมบูรณ์

### 9.4 ทำครบทุก layer แล้วรัน contract test

```bash
cd typescript && npm run build && cd ..
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8080 DB_PATH=typescript/contract.db node typescript/dist/server.js & SVC_PID=$!
sleep 1.5
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
kill $SVC_PID
rm -f typescript/contract.db typescript/contract.db-shm typescript/contract.db-wal
```

ผลที่ถูกต้อง: `# pass 333`, `# fail 0`, `# skipped 0`

หรือใช้ `/verify-gates typescript` (step 7) ถ้า fail ส่งผลกลับให้ AI ด้วยรูปแบบเดียวกับ step 6.6 (วิเคราะห์ก่อนว่าโค้ด/test/สเปกผิด) ไม่เกิน 3 รอบต่อกลุ่มปัญหา

เพิ่ม mutation ระดับ HTTP กับ handler (ตรวจว่า contract test กลางจับ bug ของ **ภาษานี้** ได้ ไม่ใช่แค่ unit test ของมัน):

```bash
tools/mutation-check/ts.sh http handler/handler.ts "client key on the admin API answers 401" <<'PY'
import sys; p = sys.argv[1]; s = open(p).read()
a = 'reply.code(403).send(errorBody("FORBIDDEN"'; assert a in s
open(p, "w").write(s.replace(a, 'reply.code(401).send(errorBody("UNAUTHORIZED"'))
PY
```

### 9.5 Idiomatic pass (หลัง test ผ่านแล้วเท่านั้น)

```text
test ทั้งหมดผ่านแล้ว ทบทวน typescript/src ให้เป็นสไตล์ TypeScript ที่ dev ภาษานี้คุ้นเคย:
ใช้ type/discriminated union แทนที่ที่แปลมาจาก pattern ของ Go ตรงๆ, ลบโค้ดที่เหลือจากการแปล,
ตั้งชื่อตามธรรมเนียม เปลี่ยนทีละเรื่อง แล้วรัน gate ทุกครั้ง ห้ามเปลี่ยนพฤติกรรม
```

ให้เครื่องช่วยตัดสิน ไม่ใช่ความรู้สึก: เปิดชุดกฎ `strict` + `stylistic` ของ typescript-eslint ในเฉลยพบ 12 จุด (ทั้งหมดเป็น `!` ในไฟล์ test) แก้แล้ว ชุดกฎนี้ค้างเป็น gate ถาวร ถ้ามี test ที่เคยผ่านแล้ว fail หลัง refactor แปลว่าเปลี่ยนพฤติกรรม ให้ย้อนกลับ (`git checkout .`)

### 9.6 Diff review: เทียบพฤติกรรมกับ Go

```text
เทียบ go/ กับ typescript/ ในแง่ "พฤติกรรมที่ test ไม่ครอบคลุม" ลิสต์เป็นตาราง:
(1) ลำดับการตรวจ validation (2) รูปแบบ response ของ error ที่ไม่มี test (3) การจัดการ transaction
(4) ค่า default (5) การเรียง/การแบ่งหน้า พร้อม file:line ทั้งสองฝั่ง อย่าแก้โค้ด
```

ทุกช่องว่างที่เจอ: ตัดสินว่า (ก) สเปกควรระบุ → แก้สเปก, (ข) test ควรครอบคลุม → เพิ่ม contract test แล้วรันกับ **ทั้ง Go และ TypeScript**, หรือ (ค) ไม่สำคัญ → จดใน `lessons/typescript.md`

### 9.7 Differential test: ให้เครื่องเทียบแทนคน

อ่านโค้ดสองฝั่งเทียบกันจับได้เฉพาะที่เรานึกถึง [`tools/diff-servers/diff.mjs`](../../../tools/diff-servers/diff.mjs) ยิง request ชุดเดียวกัน (สุ่มจาก seed) ไปทั้งสอง service แล้วเทียบ response ทั้งก้อน มี scenario "experiment" ที่สร้างตัวอย่างขนาด 29/30/31/…/400 เพื่อให้เข้าถึงสายสถิติ:

```bash
cd go && go build -o ffservice ./cmd/server && cd .. && (cd typescript && npm run build)
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8301 DB_PATH=go/diff.db go/ffservice & GO_PID=$!
ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key PORT=8302 DB_PATH=typescript/diff.db node typescript/dist/server.js & TS_PID=$!
sleep 1.5
node tools/diff-servers/diff.mjs http://localhost:8301 http://localhost:8302 --seed=1 --requests=3000
kill $GO_PID $TS_PID
rm -f go/diff.db go/diff.db-shm go/diff.db-wal typescript/diff.db typescript/diff.db-shm typescript/diff.db-wal go/ffservice
```

ผลที่ถูกต้อง: `0 differing responses` และบรรทัด `N reports contained a computed p-value` ต้องมากกว่า 0 (ไม่งั้น harness ไม่เคยแตะสถิติ)

**ข้อกำหนดของการใช้ (เรียนมาจากความผิดพลาดจริง):**

1. database ต้องเริ่มจากว่างทั้งสองฝั่ง และ **ห้ามรัน harness สองชุดพร้อมกันบนพอร์ตเดียวกัน** (ผมเคยทำ ผลคือ `ECONNREFUSED` และผล mutation ที่ใช้ไม่ได้)
2. ก่อนเชื่อผล "0 ความต่าง" ให้พิสูจน์ว่า harness ไว: เทียบ Go กับตัวมันเองต้องได้ 0 (ตรวจว่า deterministic) และเทียบ Go กับ TypeScript ที่ใส่ bug ต้องเห็นความต่าง ในเฉลย harness รุ่นแรก **ไม่เห็น** bug "z-test ไม่ two-sided" เลยเพราะ request สุ่มไม่เคยสร้างตัวอย่างพอ จึงเพิ่ม scenario experiment
3. ความต่างที่ยอมรับแล้ว (lone surrogate, header ซ้ำ, path ไม่สะอาด, รูปแบบ timestamp) harness ไม่สุ่มและไม่เทียบ ดู `docs/porting/typescript-analysis.md` ข้อ 6

**สิ่งที่ harness ทำให้เจอในเฉลย:** ขอบ 30 กับ 31 exposure ไม่มี test ใดบังคับ (mutation "31" รอดทั้ง unit และ contract) → เพิ่ม contract test ขอบ ส่วนความต่างของ timestamp (Go ผ่อนปรนกว่าสเปก) เจอจากการเทียบ validator ของสองภาษาแบบเฉพาะจุด (202 สตริง) ซึ่งเป็นเทคนิคเดียวกันในขนาดเล็ก

### 9.8 สรุปบทเรียน

```bash
git add -A && git commit -m "TypeScript port: idiomatic pass and review"
```

จด `lessons/typescript.md` ตามแม่แบบใน [Step 12](12-retrospective.md) ขณะที่ยังจำได้

## ตรวจผล (สรุป)

| คำสั่ง | ผลที่ถูกต้อง |
|---|---|
| `cd typescript && npm run build && npm run lint && npm test` | ผ่านทั้งหมด รวม vectors ทุกแถว |
| contract test กับ TypeScript server (9.4) | `pass 333 / fail 0` เหมือน Go |
| `git diff --stat <commit ก่อนแปล> -- tests/contract tests/vectors spec` | มีเฉพาะที่เติมโดยตั้งใจ (step 8 และ 9.6–9.7) ไม่มีการแก้ test ที่เคยมีเพื่อให้ผ่าน |
| differential test (9.7) | `0 differing responses` และ p-value ถูกคำนวณอย่างน้อย 1 ครั้ง |

## บทเรียนจากการแปลจริง (ย่อ; ละเอียดใน `lessons/typescript.md`)

| ที่เจอ | ต้นเหตุ | ป้องกันที่ไหน |
|---|---|---|
| `GET /v1/flags/` ตอบ 401 แทน 404 | Fastify จับคู่กับ `:key` ที่เป็นสตริงว่าง | ทดลอง framework กับ route ที่มี parameter ด้วยใน step 8 |
| key ยาว > 100 ตัวได้ 400 | `maxParamLength` เริ่มต้น 100 | contract test "key ยาวเท่าไรก็ 404" |
| query ซ้ำกลายเป็น array | `request.query` | อ่านจาก `URLSearchParams`; เติมสเปก BR-50 + test |
| ขอบ 30/31 ไม่มี test | สเปกมีเกณฑ์ แต่ทดสอบแค่ 29 กับ 200 | differential test เจอ → contract test ขอบ |
| **ต้นฉบับ Go ผ่อนปรนกว่าสเปก** | `time.Parse` รับชั่วโมงหลักเดียว, `,` และ offset `+24:00` | แก้ **Go** ไม่ใช่ผ่อน TypeScript (สเปกชนะโค้ด) |
| mock ที่เป็น JS ผิดเอง | `Date.parse` ผ่อนปรน, `/v1/flags/` = `/v1/flags`, `out["__proto__"]` | contract test ใหม่ทำให้เห็น |
| skill เรียกไม่ได้ | session ไม่โหลดไฟล์ skill ที่เพิ่งสร้าง | เริ่ม session ใหม่หลังสร้าง skill |

## ข้อควรระวัง

- **อย่าให้ AI แปลทั้ง service ในครั้งเดียว** ถ้า fail จะไม่รู้ว่าชั้นไหนผิด และคุณจะเสียหลักการ "gate ต่อ layer"
- AI มักแก้ปัญหาโดย "ปรับ test ให้ตรง" เมื่อเจอ fail ซ้ำๆ เช็ก `git diff` ของ `tests/` ทุก commit
- framework มักทำสิ่งที่ขัดสเปกโดยอัตโนมัติ (415, 413, หน้า 404 ของตัวเอง, ปฏิเสธ `__proto__`) ถ้า contract test ตรงนี้ fail ให้ไล่ที่ framework ก่อน ไม่ใช่ logic ของเรา
- bug เรื่องตัวเลข/Unicode จะโผล่จาก `fnv1a32.json` และ `bucketing.json` ตั้งแต่ layer `evaluation` ไม่ต้องรอถึง HTTP
- ผล fail ทั้งชุด (เช่น 312/312) หรือบางส่วนที่ไม่ตรงกับสิ่งที่เพิ่งแก้ มักไม่ใช่ bug ของโค้ด ตรวจก่อนว่า server รันอยู่ `BASE_URL` ถูกพอร์ต และ **ไม่มี server รุ่นเก่าค้างอยู่บนพอร์ตนั้น**: เมื่อพอร์ตชน server ใหม่จะออกด้วย `address already in use` แต่ test ยังรันกับตัวเก่าและให้ผลที่ดูเหมือน bug จริง ทางป้องกัน: `curl localhost:$PORT/healthz` ก่อนรัน test, ดู log ของ server ว่าผูกพอร์ตสำเร็จ, และอย่าเขียน `A && B & pid=$!` (PID ที่ได้เป็นของ subshell) ใช้ `ps -eo pid,args | grep server` ตรวจโปรเซสค้าง (ในสภาพแวดล้อมของเฉลย `ss -ltn` คืนค่าว่างเสมอ จึงใช้ยืนยันไม่ได้)
