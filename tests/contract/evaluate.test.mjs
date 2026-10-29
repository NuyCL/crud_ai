// POST /v1/evaluate: auth, request validation, result shape, no side effects,
// and a replay of every case in tests/vectors/evaluation.json over HTTP.
// Covers BR-11, BR-20..23 and spec/evaluation.md.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { get, post, put, del, call, uniqueKey, assertError, fixture, mvp2, REASONS } from "./lib.mjs";

const fx = fixture();
after(() => fx.cleanup());

const evaluate = (body, auth = "client") => post("/v1/evaluate", body, { auth });

describe("auth (BR-11)", () => {
  test("no key -> 401", async () => assertError(await evaluate({}, "none"), 401, "UNAUTHORIZED"));
  test("wrong client key -> 401", async () => assertError(await evaluate({}, "bad-client"), 401, "UNAUTHORIZED"));
  test("wrong admin key -> 401", async () => assertError(await evaluate({}, "bad-admin"), 401, "UNAUTHORIZED"));
  test("client key is accepted", async () => assert.equal((await evaluate({}, "client")).status, 200));
  test("admin key is accepted", async () => assert.equal((await evaluate({}, "admin")).status, 200));
});

describe("request validation (BR-20, BR-52)", () => {
  const invalid = [
    ["body is an array", "[]"],
    ["body is null", "null"],
    ["body is malformed JSON", "{oops"],
    ["flags is not an array", '{"flags":"a"}'],
    ["flags contains a number", '{"flags":["a",1]}'],
    ["flags contains null", '{"flags":[null]}'],
    ["context is an array", '{"context":[]}'],
    ["context is a string", '{"context":"u1"}'],
    ["userId is a number", '{"context":{"userId":1}}'],
    ["attributes is an array", '{"context":{"attributes":[]}}'],
    ["attribute value is null", '{"context":{"attributes":{"a":null}}}'],
    ["attribute value is an object", '{"context":{"attributes":{"a":{}}}}'],
    ["attribute value is an array", '{"context":{"attributes":{"a":[1]}}}'],
  ];
  for (const [name, rawBody] of invalid) {
    test(`${name} -> 400 VALIDATION_ERROR`, async () => {
      assertError(await call("POST", "/v1/evaluate", { rawBody, auth: "client" }), 400, "VALIDATION_ERROR");
    });
  }

  test("empty object is a valid request", async () => {
    const res = await evaluate({});
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.results, "object");
  });

  test("scalar attributes of every type are accepted", async () => {
    const res = await evaluate({ flags: [], context: { userId: "u1", attributes: { s: "x", n: 1, b: false } } });
    assert.equal(res.status, 200);
  });
});

describe("results", () => {
  test("every result has enabled, variant and a known reason", async () => {
    const on = await fx.create({ enabled: true });
    const off = await fx.create({ enabled: false });
    const res = await evaluate({ flags: [on.key, off.key, uniqueKey("none")], context: { userId: "u1" } });
    assert.equal(res.status, 200);
    for (const r of Object.values(res.body.results)) {
      assert.equal(typeof r.enabled, "boolean");
      assert.ok(r.variant === null || typeof r.variant === "string");
      assert.ok(REASONS.includes(r.reason), r.reason);
      assert.deepEqual(Object.keys(r).sort(), ["enabled", "reason", "variant"]);
    }
  });

  test("on, off and unknown flags (BR-21)", async () => {
    const on = await fx.create({ enabled: true });
    const off = await fx.create({ enabled: false });
    const ghost = uniqueKey("none");
    const res = await evaluate({ flags: [on.key, off.key, ghost], context: { userId: "u1" } });
    assert.deepEqual(res.body.results, {
      [on.key]: { enabled: true, variant: null, reason: "ON" },
      [off.key]: { enabled: false, variant: null, reason: "DISABLED" },
      [ghost]: { enabled: false, variant: null, reason: "FLAG_NOT_FOUND" },
    });
  });

  test("`flags` limits the result to exactly the requested keys (BR-23)", async () => {
    const a = await fx.create({ enabled: true });
    await fx.create({ enabled: true });
    const res = await evaluate({ flags: [a.key] });
    assert.deepEqual(Object.keys(res.body.results), [a.key]);
  });

  test("flag names that coincide with Object.prototype members are ordinary keys of the results (BR-21)", async () => {
    // In JavaScript, results["__proto__"] = x on a plain object replaces its prototype instead of
    // adding an entry, so such a key would silently vanish from the response.
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
    const res = await evaluate({ flags: names });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.results).sort(), [...names].sort());
    for (const name of names) {
      assert.ok(Object.hasOwn(res.body.results, name), name);
      assert.deepEqual(res.body.results[name], { enabled: false, variant: null, reason: "FLAG_NOT_FOUND" }, name);
    }
  });

  test("`flags: []` evaluates nothing (BR-23)", async () => {
    await fx.create({ enabled: true });
    const res = await evaluate({ flags: [] });
    assert.deepEqual(res.body, { results: {} });
  });

  test("without `flags` every existing flag is evaluated (BR-23)", async () => {
    const a = await fx.create({ enabled: true });
    const b = await fx.create({ enabled: false });
    const res = await evaluate({ context: { userId: "u1" } });
    assert.equal(res.body.results[a.key].reason, "ON");
    assert.equal(res.body.results[b.key].reason, "DISABLED");
  });

  test("a deleted flag disappears from the evaluate-all result", async () => {
    const a = await fx.create({ enabled: true });
    await del(`/v1/flags/${a.key}`);
    const res = await evaluate({});
    assert.ok(!(a.key in res.body.results));
  });

  test("changes made through the admin API are visible immediately", async () => {
    const f = await fx.create({ enabled: false });
    assert.equal((await evaluate({ flags: [f.key] })).body.results[f.key].reason, "DISABLED");
    await put(`/v1/flags/${f.key}`, { key: f.key, enabled: true });
    assert.equal((await evaluate({ flags: [f.key] })).body.results[f.key].reason, "ON");
  });

  test("the same request gives the same answer (deterministic)", async () => {
    const f = await fx.create({ enabled: true });
    const req = { flags: [f.key], context: { userId: "stable-user", attributes: { country: "TH" } } };
    const first = await evaluate(req);
    for (let i = 0; i < 5; i++) assert.deepEqual((await evaluate(req)).body, first.body);
  });
});

describe("numbers and booleans in rules (evaluation.md 3.1)", () => {
  const rawEvaluate = (flagKey, attributesJson) =>
    call("POST", "/v1/evaluate", { rawBody: `{"flags":["${flagKey}"],"context":{"userId":"u","attributes":${attributesJson}}}`, auth: "client" });
  const reasonOf = (res, key) => res.body.results[key].reason;

  test("1, 1.0 and 1e0 are the same number; true is not a number", async () => {
    const f = await fx.create({ enabled: true, rules: [{ attribute: "n", operator: "eq", value: 1 }] });
    for (const literal of ["1", "1.0", "1e0", "1E+0", "0.1e1", "10e-1"]) assert.equal(reasonOf(await rawEvaluate(f.key, `{"n":${literal}}`), f.key), "ON", literal);
    for (const literal of ["true", "false", '"1"', "2", "0"]) assert.equal(reasonOf(await rawEvaluate(f.key, `{"n":${literal}}`), f.key), "TARGETING_MISS", literal);
  });

  test("numbers are compared as doubles: 2^53 + 1 equals 2^53, and -0 equals 0", async () => {
    const big = await fx.create({ enabled: true, rules: [{ attribute: "n", operator: "eq", value: 9007199254740992 }] });
    assert.equal(reasonOf(await rawEvaluate(big.key, '{"n":9007199254740993}'), big.key), "ON");
    const zero = await fx.create({ enabled: true, rules: [{ attribute: "n", operator: "eq", value: 0 }] });
    assert.equal(reasonOf(await rawEvaluate(zero.key, '{"n":-0}'), zero.key), "ON");
    assert.equal(reasonOf(await rawEvaluate(zero.key, '{"n":false}'), zero.key), "TARGETING_MISS");
  });

  test("in / not_in use the same equality (an int and a float are one type, a bool is another)", async () => {
    const f = await fx.create({ enabled: true, rules: [{ attribute: "n", operator: "in", value: [1, 2, 3] }] });
    assert.equal(reasonOf(await rawEvaluate(f.key, '{"n":2.0}'), f.key), "ON");
    assert.equal(reasonOf(await rawEvaluate(f.key, '{"n":true}'), f.key), "TARGETING_MISS");
    const g = await fx.create({ enabled: true, rules: [{ attribute: "n", operator: "not_in", value: [1, 2, 3] }] });
    assert.equal(reasonOf(await rawEvaluate(g.key, '{"n":true}'), g.key), "ON", "true is not in [1,2,3]");
    assert.equal(reasonOf(await rawEvaluate(g.key, '{"n":3.0}'), g.key), "TARGETING_MISS");
  });
});

describe("lone surrogates never cause a server error (BR-54)", () => {
  test("a userId with a lone surrogate gets the answer of U+FFFD, or a 400, never a 5xx", async () => {
    const f = await fx.create({ enabled: true, variants: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }] });
    const run = (userId) => call("POST", "/v1/evaluate", { rawBody: `{"flags":["${f.key}"],"context":{"userId":"${userId}"}}`, auth: "client" });
    const replacement = await run("\\ufffd");
    assert.equal(replacement.status, 200);
    for (const lone of ["\\ud800", "\\udc00", "\\ud83d", "x\\ud800y"]) {
      const res = await run(lone);
      assert.ok(res.status < 500, `${lone}: ${res.status} ${res.text}`);
      if (res.status === 200 && lone !== "x\\ud800y") assert.deepEqual(res.body.results[f.key], replacement.body.results[f.key], lone);
    }
  });

  test("lone surrogates in other strings are not a 5xx either", async () => {
    const key = uniqueKey();
    const created = await call("POST", "/v1/flags", { rawBody: `{"key":"${key}","description":"\\ud800","enabled":true,"rules":[{"attribute":"\\udc00","operator":"eq","value":"\\ud800"}]}` });
    fx.track(key);
    assert.ok(created.status < 500, created.text);
    for (const [path, rawBody] of [
      ["/v1/evaluate", `{"flags":["\\ud800"],"context":{"userId":"u","attributes":{"\\ud800":"\\udc00"}}}`],
      ["/v1/events", '{"events":[{"type":"conversion","userId":"\\ud800","goal":"\\udc00"}]}'],
      ["/v1/events", '{"events":[{"type":"exposure","userId":"\\ud800","flagKey":"\\ud800","variant":"\\udc00"}]}'],
    ]) {
      const res = await call("POST", path, { rawBody, auth: "client" });
      assert.ok(res.status < 500, `${path}: ${res.status} ${res.text}`);
    }
    const read = await get(`/v1/flags/${key}`);
    assert.ok(read.status < 500, read.text);
    assert.ok((await get("/v1/flags?limit=100")).status < 500, "the list must still work after a lone surrogate was stored");
  });
});

describe("no side effects (BR-22)", () => {
  test("evaluating changes neither the flag nor the audit log", async () => {
    const f = await fx.create({ enabled: true });
    const flagBefore = (await get(`/v1/flags/${f.key}`)).body;
    const auditBefore = (await get(`/v1/audit-logs?flagKey=${f.key}`)).body.total;
    await evaluate({ flags: [f.key], context: { userId: "u1" } });
    await evaluate({});
    assert.deepEqual((await get(`/v1/flags/${f.key}`)).body, flagBefore);
    assert.equal((await get(`/v1/audit-logs?flagKey=${f.key}`)).body.total, auditBefore);
  });
});

// ------------------------------------------------------------------ vectors

describe("vectors replayed over HTTP (tests/vectors/evaluation.json)", () => {
  const file = new URL("../vectors/evaluation.json", import.meta.url);
  const { cases } = JSON.parse(readFileSync(file, "utf8"));

  const isMvp1 = (c) => c.flag === null || (c.flag.rules.length === 0 && c.flag.rolloutPercent === 100 && c.flag.variants.length === 0);

  // Vector flags use fixed keys (the key is part of the bucket hash), so cases run one after another.
  for (const c of cases) {
    test(c.id, isMvp1(c) ? {} : mvp2, async () => {
      await del(`/v1/flags/${c.flagKey}`); // clear leftovers from earlier cases or runs
      if (c.flag !== null) {
        const created = await post("/v1/flags", c.flag);
        assert.equal(created.status, 201, `could not create the vector flag: ${created.text}`);
      }
      try {
        const res = await evaluate({ flags: [c.flagKey], context: c.context });
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(res.body.results[c.flagKey], c.expected, c.description);
      } finally {
        await del(`/v1/flags/${c.flagKey}`);
      }
    });
  }
});
