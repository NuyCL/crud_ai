// Flag model validation for rollout, targeting rules and variants (MVP2).
// Covers BR-30..35.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { get, post, put, call, uniqueKey, assertError, fixture, mvp2 } from "./lib.mjs";

const fx = fixture();
after(() => fx.cleanup());

const create = (extra) => post("/v1/flags", { key: uniqueKey("var"), ...extra });
const v = (key, weight) => ({ key, weight });

describe("rolloutPercent (BR-30)", mvp2, () => {
  for (const n of [0, 1, 50, 99, 100]) {
    test(`${n} is accepted and returned`, async () => {
      const f = await fx.create({ rolloutPercent: n });
      assert.equal(f.rolloutPercent, n);
    });
  }
  // JavaScript cannot tell 10 from 10.0 after parsing, so the spec treats them alike (BR-30).
  for (const literal of ["10", "10.0", "1e1", "1.0E1"]) {
    test(`the JSON number ${literal} is the integer 10`, async () => {
      const key = uniqueKey("var");
      const res = await call("POST", "/v1/flags", { rawBody: `{"key":"${key}","rolloutPercent":${literal}}` });
      fx.track(key);
      assert.equal(res.status, 201, res.text);
      assert.equal(res.body.rolloutPercent, 10);
    });
  }
  for (const [name, value] of [["negative", -1], ["over 100", 101], ["fractional", 10.5], ["a string", "50"], ["null", null], ["boolean", true]]) {
    test(`${name} -> 400 VALIDATION_ERROR`, async () => {
      assertError(await create({ rolloutPercent: value }), 400, "VALIDATION_ERROR");
    });
  }
});

describe("variants (BR-31, BR-32, BR-33, BR-34)", mvp2, () => {
  test("a valid split is stored in the order given", async () => {
    const variants = [v("blue", 50), v("green", 30), v("red", 20)];
    const f = await fx.create({ variants });
    assert.deepEqual(f.variants, variants);
    assert.deepEqual((await get(`/v1/flags/${f.key}`)).body.variants, variants);
  });

  test("order is kept even when it is not alphabetical or by weight", async () => {
    const variants = [v("z", 10), v("a", 60), v("m", 30)];
    const f = await fx.create({ variants });
    assert.deepEqual(f.variants.map((x) => x.key), ["z", "a", "m"]);
  });

  test("two variants of 50/50 are accepted", async () => assert.equal((await create({ variants: [v("a", 50), v("b", 50)] })).status, 201));
  test("a 99/1 split is accepted", async () => assert.equal((await create({ variants: [v("a", 99), v("b", 1)] })).status, 201));

  test("ten variants of 10 each are accepted", async () => {
    const variants = Array.from({ length: 10 }, (_, i) => v(`v${i}`, 10));
    assert.equal((await create({ variants })).status, 201);
  });

  test("variant key of 32 characters is accepted", async () => {
    assert.equal((await create({ variants: [v("a".repeat(32), 50), v("b", 50)] })).status, 201);
  });

  const invalid = [
    ["weights sum to 99", [v("a", 50), v("b", 49)]],
    ["weights sum to 101", [v("a", 51), v("b", 50)]],
    ["only one variant", [v("a", 100)]],
    // weights sum to 100 here, so only the count (BR-33) can be the reason
    ["eleven variants", Array.from({ length: 11 }, (_, i) => v(`v${i}`, i === 0 ? 10 : 9))],
    ["duplicate keys", [v("a", 50), v("a", 50)]],
    ["upper-case key", [v("Blue", 50), v("b", 50)]],
    ["empty key", [v("", 50), v("b", 50)]],
    ["key with a space", [v("a b", 50), v("b", 50)]],
    ["key of 33 characters", [v("a".repeat(33), 50), v("b", 50)]],
    ["key is a number", [{ key: 1, weight: 50 }, v("b", 50)]],
    ["zero weight", [v("a", 100), v("b", 0)]],
    ["negative weight", [v("a", 150), v("b", -50)]],
    ["fractional weight", [v("a", 50.5), v("b", 49.5)]],
    ["weight is a string", [{ key: "a", weight: "50" }, v("b", 50)]],
    ["missing weight", [{ key: "a" }, v("b", 100)]],
    ["missing key", [{ weight: 50 }, v("b", 50)]],
    ["entry is not an object", ["a", "b"]],
  ];
  for (const [name, variants] of invalid) {
    test(`${name} -> 400 INVALID_VARIANTS`, async () => {
      assertError(await create({ variants }), 400, "INVALID_VARIANTS");
    });
  }

  test("`variants` that is not an array -> 400", async () => {
    const res = await create({ variants: "blue" });
    assert.equal(res.status, 400);
  });

  test("an invalid variant set on PUT leaves the flag unchanged", async () => {
    const f = await fx.create({ variants: [v("a", 50), v("b", 50)] });
    assertError(await put(`/v1/flags/${f.key}`, { key: f.key, variants: [v("a", 60), v("b", 60)] }), 400, "INVALID_VARIANTS");
    assert.deepEqual((await get(`/v1/flags/${f.key}`)).body.variants, [v("a", 50), v("b", 50)]);
  });

  test("PUT can remove all variants again", async () => {
    const f = await fx.create({ variants: [v("a", 50), v("b", 50)] });
    const res = await put(`/v1/flags/${f.key}`, { key: f.key });
    assert.deepEqual(res.body.variants, []);
  });
});

describe("targeting rules (BR-35)", mvp2, () => {
  test("every operator is stored and returned unchanged", async () => {
    const rules = [
      { attribute: "country", operator: "eq", value: "TH" },
      { attribute: "plan", operator: "neq", value: "free" },
      { attribute: "tier", operator: "in", value: [1, 2, 3] },
      { attribute: "region", operator: "not_in", value: ["eu", "us"] },
      { attribute: "beta", operator: "eq", value: true },
      { attribute: "age", operator: "eq", value: 0 },
      { attribute: "flag", operator: "eq", value: false },
      { attribute: "name", operator: "eq", value: "" },
    ];
    const f = await fx.create({ rules });
    assert.deepEqual(f.rules, rules);
    assert.deepEqual((await get(`/v1/flags/${f.key}`)).body.rules, rules);
  });

  const invalid = [
    ["rules is not an array", "x"],
    ["rule is not an object", ["x"]],
    ["missing attribute", [{ operator: "eq", value: 1 }]],
    ["empty attribute", [{ attribute: "", operator: "eq", value: 1 }]],
    ["attribute is a number", [{ attribute: 1, operator: "eq", value: 1 }]],
    ["missing operator", [{ attribute: "a", value: 1 }]],
    ["unknown operator", [{ attribute: "a", operator: "gt", value: 1 }]],
    ["missing value", [{ attribute: "a", operator: "eq" }]],
    ["null value", [{ attribute: "a", operator: "eq", value: null }]],
    ["eq with an array", [{ attribute: "a", operator: "eq", value: [1] }]],
    ["neq with an object", [{ attribute: "a", operator: "neq", value: {} }]],
    ["in with a scalar", [{ attribute: "a", operator: "in", value: "x" }]],
    ["in with an empty array", [{ attribute: "a", operator: "in", value: [] }]],
    ["not_in with a scalar", [{ attribute: "a", operator: "not_in", value: 1 }]],
    ["in with a nested array", [{ attribute: "a", operator: "in", value: [[1]] }]],
    ["in containing null", [{ attribute: "a", operator: "in", value: [null] }]],
  ];
  for (const [name, rules] of invalid) {
    test(`${name} -> 400 VALIDATION_ERROR`, async () => {
      assertError(await create({ rules }), 400, "VALIDATION_ERROR");
    });
  }
});
