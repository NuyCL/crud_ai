// Admin API: auth, flag CRUD, validation, pagination, audit log.
// Covers BR-01..09, BR-10..13, BR-50..52.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { get, post, put, del, call, uniqueKey, assertError, fixture, ISO_8601_UTC } from "./lib.mjs";

const fx = fixture();
after(() => fx.cleanup());

describe("healthz (BR-13)", () => {
  test("needs no key and reports ok", async () => {
    const res = await get("/healthz", { auth: "none" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });
});

describe("auth on the admin API (BR-10, BR-12)", () => {
  const key = uniqueKey("auth");
  const endpoints = [
    ["GET", "/v1/flags"],
    ["POST", "/v1/flags", { key }],
    ["GET", `/v1/flags/${key}`],
    ["PUT", `/v1/flags/${key}`, { key }],
    ["DELETE", `/v1/flags/${key}`],
    ["GET", "/v1/audit-logs"],
    ["GET", `/v1/flags/${key}/results?goal=g`],
  ];
  for (const [method, path, body] of endpoints) {
    test(`${method} ${path.split("?")[0].replace(key, ":key")}: no key -> 401`, async () => {
      assertError(await call(method, path, { body, auth: "none" }), 401, "UNAUTHORIZED");
    });
    test(`${method} ${path.split("?")[0].replace(key, ":key")}: wrong admin key -> 401`, async () => {
      assertError(await call(method, path, { body, auth: "bad-admin" }), 401, "UNAUTHORIZED");
    });
    test(`${method} ${path.split("?")[0].replace(key, ":key")}: client key -> 403`, async () => {
      assertError(await call(method, path, { body, auth: "client" }), 403, "FORBIDDEN");
    });
  }

  test("auth is checked before the body is read: a malformed body without a key is 401/403, not 400 (BR-51)", async () => {
    assertError(await call("POST", "/v1/flags", { rawBody: "{oops", auth: "none" }), 401, "UNAUTHORIZED");
    assertError(await call("POST", "/v1/flags", { rawBody: "{oops", auth: "bad-admin" }), 401, "UNAUTHORIZED");
    assertError(await call("POST", "/v1/flags", { rawBody: "{oops", auth: "client" }), 403, "FORBIDDEN");
    assertError(await call("PUT", `/v1/flags/${key}`, { rawBody: "[", auth: "none" }), 401, "UNAUTHORIZED");
    assertError(await call("POST", "/v1/evaluate", { rawBody: "{oops", auth: "none" }), 401, "UNAUTHORIZED");
    assertError(await call("POST", "/v1/events", { rawBody: "{oops", auth: "bad-client" }), 401, "UNAUTHORIZED");
  });

  test("a key header with characters outside ASCII is just a wrong key (BR-55)", async () => {
    // hmac.compare_digest(str, str) raises on non-ASCII text; a 500 here would be an easy denial of service
    for (const value of ["caf\u00e9", "\u00ff\u00fe", "a".repeat(5000), "a b"]) {
      assertError(await get("/v1/flags", { auth: "none", headers: { "x-admin-key": value } }), 401, "UNAUTHORIZED");
    }
    assertError(await post("/v1/evaluate", {}, { auth: "none", headers: { "x-client-key": "caf\u00e9" } }), 401, "UNAUTHORIZED");
  });

  test("a rejected create leaves no flag behind", async () => {
    await post("/v1/flags", { key }, { auth: "client" });
    assertError(await get(`/v1/flags/${key}`), 404, "FLAG_NOT_FOUND");
  });
});

describe("routes that do not exist (BR-53)", () => {
  const routes = [
    ["GET", "/nope"],
    ["GET", "/v1/nope"],
    ["GET", "/v1/flags/a/b/c"],
    ["GET", "/v1/flags/"],
    ["PATCH", "/v1/flags"],
    ["POST", "/healthz"],
    ["DELETE", "/v1/evaluate"],
    ["OPTIONS", "/v1/flags"],
    ["OPTIONS", "/v1/evaluate"],
    ["GET", "/error"],
    ["GET", "/docs"],
    ["GET", "/openapi.json"],
    ["GET", "/actuator/health"],
  ];
  for (const [method, path] of routes) {
    for (const auth of ["admin", "none"]) {
      test(`${method} ${path} (${auth === "none" ? "no key" : "admin key"}) -> 404 in the standard error shape`, async () => {
        assertError(await call(method, path, { auth }), 404, "FLAG_NOT_FOUND");
      });
    }
  }
});

describe("only the flag key is percent-decoded; the rest of the path is literal (BR-57)", () => {
  const routes = [
    ["GET", "/%68ealthz"],
    ["GET", "/v1/%66lags"],
    ["GET", "/%76%31/flags"],
    ["GET", "/v1/audit%2Dlogs"],
    ["POST", "/v1/%65valuate"],
    ["POST", "/v1/%65vents"],
    ["GET", "/v1/flags/some-key/%72esults?goal=g"],
  ];
  for (const [method, path] of routes) {
    for (const auth of ["admin", "client", "none"]) {
      test(`${method} ${path} (${auth}) -> 404, as if the route did not exist`, async () => {
        assertError(await call(method, path, { auth, body: method === "POST" ? {} : undefined }), 404, "FLAG_NOT_FOUND");
      });
    }
  }

  test("POST /v1/%66lags does not create a flag", async () => {
    const key = uniqueKey();
    assertError(await call("POST", "/v1/%66lags", { body: { key } }), 404, "FLAG_NOT_FOUND");
    assertError(await get(`/v1/flags/${key}`), 404, "FLAG_NOT_FOUND");
  });

  test("an encoded key still works: /v1/flags/{key} is decoded (BR-55 is unchanged)", async () => {
    const f = await fx.create({});
    const encoded = [...f.key].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    assert.equal((await get(`/v1/flags/${encoded}`)).body.key, f.key);
  });
});

describe("a method with no route for a path is 404 even when another method has one (BR-53)", () => {
  test("PATCH, POST on /v1/flags/{key}, PUT on /v1/flags and POST on /results change nothing", async () => {
    const f = await fx.create({ description: "before" });
    assertError(await call("PATCH", `/v1/flags/${f.key}`, { body: { key: f.key, description: "after" } }), 404, "FLAG_NOT_FOUND");
    assertError(await call("POST", `/v1/flags/${f.key}`, { body: { key: f.key } }), 404, "FLAG_NOT_FOUND");
    assertError(await call("PUT", "/v1/flags", { body: { key: f.key } }), 404, "FLAG_NOT_FOUND");
    assertError(await call("POST", `/v1/flags/${f.key}/results?goal=g`), 404, "FLAG_NOT_FOUND");
    assert.equal((await get(`/v1/flags/${f.key}`)).body.description, "before");
  });
});

describe("percent-encoded path keys (BR-55)", () => {
  test("an encoded key is decoded before the lookup: it finds the flag it spells", async () => {
    const key = uniqueKey("enc");
    fx.track(key);
    assert.equal((await post("/v1/flags", { key })).status, 201);
    const encoded = key.replace("-", "%2D").replace("enc", "%65nc");
    assert.notEqual(encoded, key);
    for (const path of [`/v1/flags/${encoded}`, `/v1/flags/${key.replace("-", "%2d")}`]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.body.key, key);
    }
    assert.equal((await get(`/v1/flags/${encoded}/results?goal=g`)).status, 200);
    assert.equal((await put(`/v1/flags/${encoded}`, { key, description: "d" })).status, 200);
    assert.equal((await del(`/v1/flags/${encoded}`)).status, 204);
  });

  test("a slash in the key is part of the key: it is not another path segment", async () => {
    assertError(await get("/v1/flags/a%2Fb"), 404, "FLAG_NOT_FOUND");
    assertError(await put("/v1/flags/a%2Fb", { key: "a/b" }), 400, "INVALID_KEY");
    assertError(await put("/v1/flags/a%2Fb", { key: "ab" }), 400, "KEY_IMMUTABLE");
  });

  test("a broken escape is a 400, whatever the body", async () => {
    for (const path of ["/v1/flags/%zz", "/v1/flags/a%", "/v1/flags/%4"]) {
      assert.equal((await get(path)).status, 400, path);
    }
  });
});

describe("create (BR-01, BR-02, BR-08)", () => {
  test("minimal body gets defaults", async () => {
    const key = uniqueKey();
    const res = await post("/v1/flags", { key });
    fx.track(key);
    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.body.key, key);
    assert.equal(res.body.description, "");
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.rules, []);
    assert.equal(res.body.rolloutPercent, 100);
    assert.deepEqual(res.body.variants, []);
    assert.match(res.body.createdAt, ISO_8601_UTC);
    assert.match(res.body.updatedAt, ISO_8601_UTC);
    assert.ok(!Number.isNaN(Date.parse(res.body.createdAt)));
  });

  test("provided fields are stored and returned", async () => {
    const key = uniqueKey();
    const res = await post("/v1/flags", { key, description: "new checkout", enabled: true });
    fx.track(key);
    assert.equal(res.status, 201);
    assert.equal(res.body.description, "new checkout");
    assert.equal(res.body.enabled, true);
  });

  test("GET returns exactly what POST returned", async () => {
    const created = await fx.create({ description: "same", enabled: true });
    const res = await get(`/v1/flags/${created.key}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created);
  });

  test("duplicate key -> 409 FLAG_EXISTS and the original is untouched", async () => {
    const created = await fx.create({ description: "original" });
    assertError(await post("/v1/flags", { key: created.key, description: "other" }), 409, "FLAG_EXISTS");
    assert.equal((await get(`/v1/flags/${created.key}`)).body.description, "original");
  });

  // Fixed keys may be left over from an earlier run, so they are deleted first.
  const goodKeys = [
    ["single letter", () => "a"],
    ["single digit", () => "0"],
    ["hyphen and underscore", () => "a-b_c"],
    ["starts with a digit", () => "9lives"],
    ["exactly 64 characters", () => uniqueKey("k").padEnd(64, "x")],
  ];
  for (const [name, make] of goodKeys) {
    test(`valid key accepted: ${name}`, async () => {
      const key = make();
      await del(`/v1/flags/${key}`);
      const res = await post("/v1/flags", { key });
      fx.track(key);
      assert.equal(res.status, 201);
      assert.equal(res.body.key, key);
    });
  }

  const badKeys = [
    ["empty", ""],
    ["upper case", "Upper"],
    ["leading hyphen", "-abc"],
    ["leading underscore", "_abc"],
    ["space", "a b"],
    ["slash", "a/b"],
    ["dot", "a.b"],
    ["non-ASCII", "ไทย"],
    ["65 chars", "x".repeat(65)],
    // Python's `$` and Java's `find()` accept a trailing newline; the key pattern must not.
    ["trailing newline", "abc\n"],
    ["only a newline", "\n"],
  ];
  for (const [name, key] of badKeys) {
    test(`invalid key (${name}) -> 400 INVALID_KEY`, async () => {
      assertError(await post("/v1/flags", { key }), 400, "INVALID_KEY");
    });
  }

  const invalidBodies = [
    ["missing key", {}],
    ["key is a number", { key: 123 }],
    ["key is null", { key: null }],
    ["description is a number", () => ({ key: uniqueKey(), description: 5 })],
    ["enabled is a string", () => ({ key: uniqueKey(), enabled: "true" })],
    ["enabled is a number", () => ({ key: uniqueKey(), enabled: 1 })],
    ["description over 500 code points", () => ({ key: uniqueKey(), description: "x".repeat(501) })],
  ];
  for (const [name, body] of invalidBodies) {
    test(`${name} -> 400 VALIDATION_ERROR`, async () => {
      assertError(await post("/v1/flags", typeof body === "function" ? body() : body), 400, "VALIDATION_ERROR");
    });
  }

  test("body that is not an object -> 400 VALIDATION_ERROR", async () => {
    assertError(await call("POST", "/v1/flags", { rawBody: "[]" }), 400, "VALIDATION_ERROR");
    assertError(await call("POST", "/v1/flags", { rawBody: "null" }), 400, "VALIDATION_ERROR");
    assertError(await call("POST", "/v1/flags", { rawBody: '"str"' }), 400, "VALIDATION_ERROR");
  });

  test("malformed JSON -> 400 VALIDATION_ERROR (BR-52)", async () => {
    assertError(await call("POST", "/v1/flags", { rawBody: "{not json" }), 400, "VALIDATION_ERROR");
    assertError(await call("POST", "/v1/flags", { rawBody: "" }), 400, "VALIDATION_ERROR");
  });

  test("validation runs before the duplicate check (BR-51)", async () => {
    const created = await fx.create();
    assertError(await post("/v1/flags", { key: created.key, enabled: "yes" }), 400, "VALIDATION_ERROR");
  });

  test("a rejected create is not stored", async () => {
    const key = uniqueKey();
    assertError(await post("/v1/flags", { key, enabled: "yes" }), 400, "VALIDATION_ERROR");
    assertError(await get(`/v1/flags/${key}`), 404, "FLAG_NOT_FOUND");
  });
});

describe("request body handling (BR-52)", () => {
  test("Content-Type is not consulted: the body is always read as JSON", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "application/octet-stream"]) {
      const key = uniqueKey();
      const res = await call("POST", "/v1/flags", { rawBody: JSON.stringify({ key }), contentType });
      fx.track(key);
      assert.equal(res.status, 201, `${contentType}: ${res.text}`);
    }
  });

  test("more than one JSON value, or anything after it, -> 400 VALIDATION_ERROR", async () => {
    for (const rawBody of ['{"key":"a"}{"key":"b"}', '{"key":"a"} junk', '{"key":"a"},', "[]{}"]) {
      assertError(await call("POST", "/v1/flags", { rawBody }), 400, "VALIDATION_ERROR");
    }
  });

  test("trailing whitespace after the JSON value is fine", async () => {
    const key = uniqueKey();
    const res = await call("POST", "/v1/flags", { rawBody: `${JSON.stringify({ key })}\n \t\r\n` });
    fx.track(key);
    assert.equal(res.status, 201);
  });

  test("things that are not standard JSON are rejected (NaN, leading zeros, comments, ...)", async () => {
    // Python's json.loads accepts NaN and Infinity; JSON5 and JavaScript literals accept the rest.
    const bodies = [
      '{"key":"nojson","rolloutPercent":NaN}', '{"key":"nojson","rolloutPercent":Infinity}', '{"key":"nojson","rolloutPercent":-Infinity}',
      '{"key":"nojson","rolloutPercent":01}', '{"key":"nojson","rolloutPercent":.5}', '{"key":"nojson","rolloutPercent":1.}',
      '{"key":"nojson","rolloutPercent":+1}', '{"key":"nojson","rolloutPercent":0x10}', '{"key":"nojson",}', "[1,]", "{'key':'nojson'}",
      '/*c*/{"key":"nojson"}', '{"key":"nojson"} // c', '{"key":"no\njson"}', '{"key":"nojson","description":"a\tb"}',
      '{"key":"nojson","description":"\\x41"}', '{"key":"nojson","description":"\\u12"}', '\uFEFF{"key":"nojson"}', '{"key":"nojson"}\u0000', "{key:\"nojson\"}",
    ];
    for (const rawBody of bodies) assertError(await call("POST", "/v1/flags", { rawBody }), 400, "VALIDATION_ERROR");
    assertError(await get("/v1/flags/nojson"), 404, "FLAG_NOT_FOUND");
  });

  test("NaN and Infinity are refused even in a field the service ignores", async () => {
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      assertError(await call("POST", "/v1/flags", { rawBody: `{"key":"${uniqueKey()}","unknown":${literal}}` }), 400, "VALIDATION_ERROR");
    }
  });

  test("numbers JSON allows but a careless parser might not: -0, 1E2, 1e+2 for rolloutPercent", async () => {
    for (const [literal, want] of [["-0", 0], ["1E2", 100], ["1e+2", 100], ["0e0", 0], ["5.0E0", 5]]) {
      const key = uniqueKey();
      const res = await call("POST", "/v1/flags", { rawBody: `{"key":"${key}","rolloutPercent":${literal}}` });
      fx.track(key);
      assert.equal(res.status, 201, `${literal}: ${res.text}`);
      assert.equal(res.body.rolloutPercent, want, literal);
    }
  });

  test("invalid UTF-8, UTF-16 and other encodings are rejected, not repaired (BR-52)", async () => {
    const utf16 = (s, bom) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);
    const bodies = {
      "a 0xFF byte inside a string": Buffer.concat([Buffer.from('{"key":"u8","description":"'), Buffer.from([0xff]), Buffer.from('"}')]),
      "a truncated multi-byte sequence": Buffer.concat([Buffer.from('{"key":"u8","description":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
      "a surrogate encoded as UTF-8 (CESU-8)": Buffer.concat([Buffer.from('{"key":"u8","description":"'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')]),
      "an overlong encoding of '/'": Buffer.concat([Buffer.from('{"key":"u8","description":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]),
      "UTF-16LE with a BOM": utf16('{"key":"u8"}', true),
      "UTF-16LE without a BOM": utf16('{"key":"u8"}', false),
    };
    for (const [name, rawBody] of Object.entries(bodies)) assertError(await call("POST", "/v1/flags", { rawBody }), 400, "VALIDATION_ERROR");
    assertError(await get("/v1/flags/u8"), 404, "FLAG_NOT_FOUND");
  });

  test("absurdly deep nesting is a 400, not a crash (BR-52)", async () => {
    for (const rawBody of ["[".repeat(100000), '{"a":'.repeat(50000), `{"key":"deep","description":${"[".repeat(20000)}${"]".repeat(20000)}}`]) {
      assertError(await call("POST", "/v1/flags", { rawBody }), 400, "VALIDATION_ERROR");
    }
    assertError(await get("/v1/flags/deep"), 404, "FLAG_NOT_FOUND");
  });

  test("a repeated key in a JSON object: the last value wins (BR-52)", async () => {
    const [first, second] = [uniqueKey(), uniqueKey()];
    const res = await call("POST", "/v1/flags", { rawBody: `{"key":"${first}","key":"${second}"}` });
    fx.track(second);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.key, second);
    assertError(await get(`/v1/flags/${first}`), 404, "FLAG_NOT_FOUND");
  });

  const MIB = 1024 * 1024;
  test("a body of exactly 1 MiB is accepted", async () => {
    const key = uniqueKey();
    const json = JSON.stringify({ key });
    const res = await call("POST", "/v1/flags", { rawBody: json + " ".repeat(MIB - json.length) }); // ASCII: 1 char = 1 byte
    fx.track(key);
    assert.equal(res.status, 201, res.text.slice(0, 200));
  });

  test("a body over 1 MiB -> 400 VALIDATION_ERROR (not 413) and nothing is created", async () => {
    const key = uniqueKey();
    const json = JSON.stringify({ key });
    // Valid JSON that is only too large: padding, so no other rule can be the reason for the 400.
    assertError(await call("POST", "/v1/flags", { rawBody: json + " ".repeat(MIB - json.length + 1) }), 400, "VALIDATION_ERROR");
    assertError(await get(`/v1/flags/${key}`), 404, "FLAG_NOT_FOUND");
  });
});

describe("description length counts Unicode code points (BR-04)", () => {
  test("exactly 500 ASCII characters is accepted", async () => {
    const f = await fx.create({ description: "a".repeat(500) });
    assert.equal(f.description.length, 500);
  });
  test("500 emoji (1 code point, 2 UTF-16 units, 4 bytes each) is accepted", async () => {
    const f = await fx.create({ description: "😀".repeat(500) });
    assert.equal([...f.description].length, 500);
  });
  test("500 Thai characters (3 bytes each) is accepted", async () => {
    const f = await fx.create({ description: "ก".repeat(500) });
    assert.equal([...f.description].length, 500);
  });
  test("501 emoji -> 400 VALIDATION_ERROR", async () => {
    assertError(await post("/v1/flags", { key: uniqueKey(), description: "😀".repeat(501) }), 400, "VALIDATION_ERROR");
  });
  test("text survives a round trip byte-for-byte", async () => {
    const text = "ธงฟีเจอร์ 🚩 café 日本語";
    const f = await fx.create({ description: text });
    assert.equal((await get(`/v1/flags/${f.key}`)).body.description, text);
  });
});

describe("read and list (BR-05, BR-50)", () => {
  test("unknown flag -> 404 FLAG_NOT_FOUND", async () => {
    assertError(await get(`/v1/flags/${uniqueKey("none")}`), 404, "FLAG_NOT_FOUND");
  });

  test("a key that cannot be decoded as UTF-8 is just a flag that does not exist (BR-55)", async () => {
    for (const encoded of ["%FF", "%C3%28", "%ED%A0%80", "%C0%AF", "%00", "%7F", "a%FFb", "%F0%9F%98"]) {
      assertError(await get(`/v1/flags/${encoded}`), 404, "FLAG_NOT_FOUND");
      assertError(await del(`/v1/flags/${encoded}`), 404, "FLAG_NOT_FOUND");
      assertError(await get(`/v1/flags/${encoded}/results?goal=g`), 404, "FLAG_NOT_FOUND");
    }
  });

  test("a key longer than any real key is simply not found, however long (BR-05)", async () => {
    // Some routers answer 400 once a path parameter passes a length limit (Fastify: 100 characters).
    for (const length of [65, 101, 300, 5000]) {
      const key = "k".repeat(length);
      assertError(await get(`/v1/flags/${key}`), 404, "FLAG_NOT_FOUND");
      assertError(await del(`/v1/flags/${key}`), 404, "FLAG_NOT_FOUND");
      assertError(await get(`/v1/flags/${key}/results?goal=g`), 404, "FLAG_NOT_FOUND");
    }
  });

  test("list has items and total, sorted by key ascending", async () => {
    await Promise.all([fx.create(), fx.create(), fx.create()]);
    const res = await get("/v1/flags?limit=100");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(typeof res.body.total, "number");
    assert.ok(res.body.total >= 3);
    assert.ok(res.body.items.length <= 100);
    const keys = res.body.items.map((f) => f.key);
    assert.deepEqual(keys, [...keys].sort());
  });

  test("limit and offset page through the same ordering", async (t) => {
    await Promise.all([fx.create(), fx.create(), fx.create()]);
    // Other tests may create or delete flags while this one runs. Only compare pages
    // taken from a stable snapshot: the full list must be identical before and after.
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = await get("/v1/flags?limit=100");
      if (before.body.total > 100) return; // cannot compare against a single page
      const first = await get("/v1/flags?limit=1&offset=0");
      const second = await get("/v1/flags?limit=1&offset=1");
      const after = await get("/v1/flags?limit=100");
      const keys = (r) => r.body.items.map((f) => f.key);
      const totals = new Set([before, first, second, after].map((r) => r.body.total));
      if (totals.size !== 1 || keys(before).join() !== keys(after).join()) {
        await new Promise((r) => setTimeout(r, 20));
        continue; // something changed mid-read
      }

      assert.equal(first.body.items.length, 1);
      assert.equal(second.body.items.length, 1);
      assert.equal(first.body.items[0].key, keys(before)[0]);
      assert.equal(second.body.items[0].key, keys(before)[1]);
      assert.equal(first.body.total, before.body.total);
      assert.equal(second.body.total, before.body.total);
      return;
    }
    // Another test file keeps creating/deleting flags, so no stable snapshot exists. Do not
    // pretend it passed and do not fail on a race: report it as skipped. With
    // --test-concurrency=1 nothing else writes, so this test always runs there.
    t.skip("flag list kept changing (parallel run); rerun with --test-concurrency=1 to check paging");
  });

  test("offset past the end gives an empty page", async () => {
    const res = await get("/v1/flags?offset=1000000");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(typeof res.body.total, "number");
  });

  test("default page size is 20", async () => {
    const res = await get("/v1/flags");
    assert.ok(res.body.items.length <= 20);
  });

  for (const q of ["limit=0", "limit=101", "limit=-1", "limit=abc", "limit=1.5", "offset=-1", "offset=abc", "limit=", "limit=+5", "limit=1e1", "limit=%D9%A5"]) {
    test(`bad paging parameter ${q} -> 400 VALIDATION_ERROR`, async () => {
      assertError(await get(`/v1/flags?${q}`), 400, "VALIDATION_ERROR");
    });
  }

  test("a repeated parameter uses its first value (BR-50)", async () => {
    await Promise.all([fx.create(), fx.create()]);
    const one = await get("/v1/flags?limit=1&limit=100");
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.items.length, 1, "limit=1&limit=100 must behave like limit=1");
    assertError(await get("/v1/flags?limit=0&limit=5"), 400, "VALIDATION_ERROR");
    const past = await get("/v1/flags?offset=1000000&offset=0");
    assert.deepEqual(past.body.items, [], "offset=1000000&offset=0 must behave like offset=1000000");
  });

  test("a leading-zero limit is the same number", async () => {
    await fx.create();
    const res = await get("/v1/flags?limit=001");
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.items.length, 1);
  });
});

describe("update (BR-03, BR-05, BR-09)", () => {
  test("replaces the flag and returns it", async () => {
    const f = await fx.create({ description: "v1", enabled: false });
    const res = await put(`/v1/flags/${f.key}`, { key: f.key, description: "v2", enabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.description, "v2");
    assert.equal(res.body.enabled, true);
    assert.deepEqual((await get(`/v1/flags/${f.key}`)).body, res.body);
  });

  test("omitted optional fields reset to defaults (full replace)", async () => {
    const f = await fx.create({ description: "keep me?", enabled: true });
    const res = await put(`/v1/flags/${f.key}`, { key: f.key });
    assert.equal(res.status, 200);
    assert.equal(res.body.description, "");
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.rules, []);
    assert.equal(res.body.rolloutPercent, 100);
    assert.deepEqual(res.body.variants, []);
  });

  test("createdAt is kept, updatedAt does not go backwards", async () => {
    const f = await fx.create();
    await new Promise((r) => setTimeout(r, 15));
    const res = await put(`/v1/flags/${f.key}`, { key: f.key, enabled: true });
    assert.equal(res.body.createdAt, f.createdAt);
    assert.ok(Date.parse(res.body.updatedAt) >= Date.parse(f.updatedAt));
  });

  test("changing the key -> 400 KEY_IMMUTABLE and nothing changes", async () => {
    const f = await fx.create({ description: "stay" });
    assertError(await put(`/v1/flags/${f.key}`, { key: uniqueKey(), description: "moved" }), 400, "KEY_IMMUTABLE");
    assert.equal((await get(`/v1/flags/${f.key}`)).body.description, "stay");
  });

  test("unknown flag -> 404 FLAG_NOT_FOUND", async () => {
    const key = uniqueKey("none");
    assertError(await put(`/v1/flags/${key}`, { key }), 404, "FLAG_NOT_FOUND");
  });

  test("invalid body -> 400 and the flag is unchanged", async () => {
    const f = await fx.create({ description: "stay" });
    assertError(await put(`/v1/flags/${f.key}`, { key: f.key, enabled: "yes" }), 400, "VALIDATION_ERROR");
    assert.equal((await get(`/v1/flags/${f.key}`)).body.description, "stay");
  });
});

describe("delete (BR-06)", () => {
  test("204 with no body, then the flag is gone", async () => {
    const f = await fx.create();
    const res = await del(`/v1/flags/${f.key}`);
    assert.equal(res.status, 204);
    assert.equal(res.text, "");
    assertError(await get(`/v1/flags/${f.key}`), 404, "FLAG_NOT_FOUND");
  });

  test("deleting twice -> second is 404 FLAG_NOT_FOUND", async () => {
    const f = await fx.create();
    await del(`/v1/flags/${f.key}`);
    assertError(await del(`/v1/flags/${f.key}`), 404, "FLAG_NOT_FOUND");
  });

  test("a deleted key can be created again", async () => {
    const f = await fx.create({ description: "first life" });
    await del(`/v1/flags/${f.key}`);
    const res = await post("/v1/flags", { key: f.key, description: "second life" });
    assert.equal(res.status, 201);
    assert.equal(res.body.description, "second life");
  });

  test("evaluate after delete does not fail and reports FLAG_NOT_FOUND", async () => {
    const f = await fx.create({ enabled: true });
    await del(`/v1/flags/${f.key}`);
    const res = await post("/v1/evaluate", { flags: [f.key], context: { userId: "u1" } }, { auth: "client" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results[f.key], { enabled: false, variant: null, reason: "FLAG_NOT_FOUND" });
  });
});

describe("audit log (BR-07)", () => {
  test("create, update and delete each add one entry, newest first", async () => {
    const key = uniqueKey("audit");
    const created = (await post("/v1/flags", { key, description: "a" })).body;
    const updated = (await put(`/v1/flags/${key}`, { key, description: "b", enabled: true })).body;
    await del(`/v1/flags/${key}`);

    const res = await get(`/v1/audit-logs?flagKey=${key}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    const [d, u, c] = res.body.items;
    assert.deepEqual([d.action, u.action, c.action], ["delete", "update", "create"]);
    assert.ok(d.id > u.id && u.id > c.id, "ids must increase over time");

    assert.equal(c.flagKey, key);
    assert.equal(c.before, null);
    assert.deepEqual(c.after, created);
    assert.deepEqual(u.before, created);
    assert.deepEqual(u.after, updated);
    assert.deepEqual(d.before, updated);
    assert.equal(d.after, null);
    for (const e of res.body.items) assert.match(e.createdAt, ISO_8601_UTC);
  });

  test("rejected requests write nothing", async () => {
    const f = await fx.create();
    const before = (await get(`/v1/audit-logs?flagKey=${f.key}`)).body.total;
    await post("/v1/flags", { key: f.key }); // 409
    await put(`/v1/flags/${f.key}`, { key: f.key, enabled: "yes" }); // 400
    await put(`/v1/flags/${f.key}`, { key: uniqueKey() }); // 400 KEY_IMMUTABLE
    await del(`/v1/flags/${uniqueKey("none")}`); // 404
    assert.equal((await get(`/v1/audit-logs?flagKey=${f.key}`)).body.total, before);
  });

  test("a repeated flagKey filter uses the first value (BR-50)", async () => {
    const a = await fx.create();
    const b = await fx.create();
    const res = await get(`/v1/audit-logs?flagKey=${a.key}&flagKey=${b.key}`);
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.items.length >= 1);
    assert.ok(res.body.items.every((e) => e.flagKey === a.key), "only the first flagKey may be used");
  });

  test("filter by flagKey only returns that flag", async () => {
    const a = await fx.create();
    await fx.create();
    const res = await get(`/v1/audit-logs?flagKey=${a.key}`);
    assert.ok(res.body.items.length >= 1);
    assert.ok(res.body.items.every((e) => e.flagKey === a.key));
  });

  test("unknown flagKey -> empty list, not an error", async () => {
    const res = await get(`/v1/audit-logs?flagKey=${uniqueKey("none")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [], total: 0 });
  });

  test("without a filter the newest entries come first", async () => {
    await fx.create();
    const res = await get("/v1/audit-logs?limit=100");
    const ids = res.body.items.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((x, y) => y - x));
  });

  test("paging", async () => {
    const key = uniqueKey("audit");
    await post("/v1/flags", { key });
    await put(`/v1/flags/${key}`, { key, enabled: true });
    await del(`/v1/flags/${key}`);
    const p1 = await get(`/v1/audit-logs?flagKey=${key}&limit=2&offset=0`);
    const p2 = await get(`/v1/audit-logs?flagKey=${key}&limit=2&offset=2`);
    assert.equal(p1.body.items.length, 2);
    assert.equal(p2.body.items.length, 1);
    assert.equal(p1.body.total, 3);
    assert.equal(p2.body.items[0].action, "create");
  });

  for (const q of ["limit=0", "limit=101", "offset=-1", "limit=x"]) {
    test(`bad paging parameter ${q} -> 400 VALIDATION_ERROR`, async () => {
      assertError(await get(`/v1/audit-logs?${q}`), 400, "VALIDATION_ERROR");
    });
  }
});
