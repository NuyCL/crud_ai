import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import type { Context, EvaluationResult, Flag } from "../model/index.js";
import { bucket, evaluate, fnv1a32 } from "./index.js";

// The vectors live at the repository root and are shared by every language. This file is compiled
// to typescript/dist/evaluation/, so the repository root is three levels up.
const vectors = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../tests/vectors/${name}`, import.meta.url), "utf8"));

interface Cases<T> {
  cases: T[];
}

describe("vectors shared with every other language", () => {
  const fnv = vectors("fnv1a32.json") as Cases<{ input: string; hash: number }>;
  test("fnv1a32.json is loaded and not empty", () => assert.ok(fnv.cases.length > 0));
  for (const c of fnv.cases) {
    test(`fnv1a32(${JSON.stringify(c.input.slice(0, 20))}) = ${c.hash}`, () => assert.equal(fnv1a32(c.input), c.hash));
  }

  const bucketing = vectors("bucketing.json") as Cases<{ flagKey: string; salt: string; userId: string; input: string; hash: number; bucket: number }>;
  test("every row of bucketing.json: the hash of its input and the bucket", () => {
    assert.ok(bucketing.cases.length > 0);
    for (const c of bucketing.cases) {
      assert.equal(fnv1a32(c.input), c.hash, `hash of ${JSON.stringify(c.input)}`);
      assert.equal(bucket(c.flagKey, c.salt, c.userId), c.bucket, `bucket of ${JSON.stringify(c.input)}`);
    }
  });

  const evaluation = vectors("evaluation.json") as Cases<{ id: string; flag: Flag | null; context: Context; expected: EvaluationResult }>;
  test("evaluation.json is loaded and not empty", () => assert.ok(evaluation.cases.length > 0));
  for (const c of evaluation.cases) {
    test(c.id, () => assert.deepEqual(evaluate(c.flag, c.context), c.expected));
  }
});

describe("properties the vectors only sample", () => {
  const flag: Flag = {
    key: "f", description: "", enabled: true, rolloutPercent: 50, rules: [],
    variants: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }], createdAt: "", updatedAt: "",
  };

  test("the same input always gives the same answer", () => {
    const first = evaluate(flag, { userId: "user-1" });
    for (let i = 0; i < 100; i++) assert.deepEqual(evaluate(flag, { userId: "user-1" }), first);
  });

  test("evaluating does not change the flag or the context", () => {
    const f: Flag = { ...flag, rolloutPercent: 100, rules: [{ attribute: "country", operator: "in", value: ["TH", "SG"] }] };
    const ctx: Context = { userId: "u", attributes: { country: "TH" } };
    const before = JSON.stringify([f, ctx]);
    evaluate(f, ctx);
    assert.equal(JSON.stringify([f, ctx]), before);
  });

  test("JavaScript's == semantics never leak in: 1 is not '1', true is not 1", () => {
    const rule = (value: string | number | boolean): Flag => ({ ...flag, rolloutPercent: 100, variants: [], rules: [{ attribute: "x", operator: "eq", value }] });
    assert.equal(evaluate(rule(1), { attributes: { x: "1" } }).reason, "TARGETING_MISS");
    assert.equal(evaluate(rule("1"), { attributes: { x: 1 } }).reason, "TARGETING_MISS");
    assert.equal(evaluate(rule(1), { attributes: { x: true } }).reason, "TARGETING_MISS");
    assert.equal(evaluate(rule(0), { attributes: { x: false } }).reason, "TARGETING_MISS");
    assert.equal(evaluate(rule(0), { attributes: { x: 0 } }).reason, "ON");
  });

  test("names from Object.prototype are not attributes unless they were sent", () => {
    const neq: Flag = { ...flag, rolloutPercent: 100, variants: [], rules: [{ attribute: "constructor", operator: "neq", value: "x" }] };
    assert.equal(evaluate(neq, { attributes: {} }).reason, "TARGETING_MISS");
    const attrs = Object.create(null) as Record<string, string>;
    attrs["constructor"] = "y"; // sent for real: now it is compared like any other attribute
    assert.equal(evaluate(neq, { attributes: attrs }).reason, "ON");
  });
});
