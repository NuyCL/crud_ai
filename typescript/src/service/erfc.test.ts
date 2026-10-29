import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { erfc } from "./erfc.js";

interface ErfcVectors {
  absoluteTolerance: number;
  relativeTolerance: number;
  cases: { x: number; erfc: number }[];
}

const vectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/erfc.json", import.meta.url), "utf8")) as ErfcVectors;

test("erfc matches every row of tests/vectors/erfc.json within the shared tolerance", () => {
  assert.ok(vectors.cases.length > 0);
  for (const { x, erfc: want } of vectors.cases) {
    const tolerance = Math.max(vectors.absoluteTolerance, vectors.relativeTolerance * want);
    const got = erfc(x);
    assert.ok(Math.abs(got - want) <= tolerance, `erfc(${x}) = ${got}, want ${want} (tolerance ${tolerance})`);
  }
});

test("the textbook approximation would NOT pass these vectors (that is why it is not used)", () => {
  // Abramowitz and Stegun 7.1.26, the approximation the mock server uses.
  const approx = (x: number): number => {
    const t = 1 / (1 + 0.3275911 * x);
    return ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  };
  const failures = vectors.cases.filter(({ x, erfc: want }) => Math.abs(approx(x) - want) > Math.max(vectors.absoluteTolerance, vectors.relativeTolerance * want));
  assert.ok(failures.length > 0, "if this fails the vectors are too loose to protect the p-value");
});

test("erfc is continuous across the point where the method changes", () => {
  const below = erfc(2 - 1e-12);
  const above = erfc(2 + 1e-12);
  assert.ok(Math.abs(below - above) < 1e-13, `${below} vs ${above}`);
});

test("edge values", () => {
  assert.equal(erfc(0), 1);
  assert.equal(erfc(Infinity), 0);
  assert.equal(erfc(30), 0); // underflows to 0 rather than becoming NaN
  assert.ok(Number.isNaN(erfc(NaN)));
  assert.ok(Math.abs(erfc(-1) - (2 - erfc(1))) < 1e-15, "erfc(-x) = 2 - erfc(x)");
  for (let x = 0; x <= 10; x += 0.37) assert.ok(erfc(x) >= 0 && erfc(x) <= 1, `erfc(${x}) = ${erfc(x)}`);
});

test("erfc decreases as x grows", () => {
  let previous = erfc(0);
  for (let x = 0.05; x <= 9; x += 0.05) {
    const current = erfc(x);
    assert.ok(current < previous, `erfc(${x}) = ${current} is not below ${previous}`);
    previous = current;
  }
});
