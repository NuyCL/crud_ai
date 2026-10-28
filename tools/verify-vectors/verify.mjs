// Independent check of tests/vectors/*.json, written from spec/evaluation.md
// in plain Node (no dependencies). If this and the Go generator agree, the
// vectors are reproducible from the spec rather than from one implementation.
//
//   node tools/verify-vectors/verify.mjs [vectors-dir]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? new URL("../../tests/vectors", import.meta.url).pathname;
const load = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

// FNV-1a 32-bit over UTF-8 bytes. Math.imul keeps the multiply in 32 bits;
// `>>> 0` turns the signed result back into an unsigned value.
function fnv1a32(input) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(input, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const bucket = (flagKey, salt, userId) => fnv1a32(`${flagKey}:${salt}:${userId}`) % 10000;

const same = (a, b) => typeof a === typeof b && a === b;

function ruleMatches(rule, attrs) {
  if (!attrs || !Object.hasOwn(attrs, rule.attribute)) return false;
  const got = attrs[rule.attribute];
  switch (rule.operator) {
    case "eq": return same(got, rule.value);
    case "neq": return !same(got, rule.value);
    case "in": return rule.value.some((v) => same(got, v));
    case "not_in": return !rule.value.some((v) => same(got, v));
    default: throw new Error(`unknown operator ${rule.operator}`);
  }
}

function evaluate(flag, ctx) {
  const off = (reason) => ({ enabled: false, variant: null, reason });
  if (flag === null) return off("FLAG_NOT_FOUND");
  if (!flag.enabled) return off("DISABLED");
  if (!flag.rules.every((r) => ruleMatches(r, ctx.attributes))) return off("TARGETING_MISS");
  const userId = ctx.userId ?? "";
  if ((flag.rolloutPercent < 100 || flag.variants.length > 0) && userId === "") return off("MISSING_USER_ID");
  if (flag.rolloutPercent < 100 && bucket(flag.key, "rollout", userId) >= flag.rolloutPercent * 100) {
    return off("NOT_IN_ROLLOUT");
  }
  if (flag.variants.length === 0) return { enabled: true, variant: null, reason: "ON" };
  const b = bucket(flag.key, "variant", userId);
  let threshold = 0;
  for (const v of flag.variants) {
    threshold += v.weight * 100;
    if (b < threshold) return { enabled: true, variant: v.key, reason: "VARIANT" };
  }
  throw new Error("weights do not sum to 100");
}

let failures = 0;
const fail = (msg) => { failures++; console.error("FAIL", msg); };

const fnv = load("fnv1a32.json").cases;
for (const c of fnv) if (fnv1a32(c.input) !== c.hash) fail(`fnv1a32(${JSON.stringify(c.input)})`);

const buck = load("bucketing.json").cases;
for (const c of buck) {
  const h = fnv1a32(c.input);
  if (c.input !== `${c.flagKey}:${c.salt}:${c.userId}`) fail(`input shape ${c.input}`);
  if (h !== c.hash || h % 10000 !== c.bucket) fail(`bucketing ${c.input}`);
}

const ev = load("evaluation.json").cases;
for (const c of ev) {
  const got = evaluate(c.flag, c.context);
  if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
    fail(`evaluation ${c.id}: got ${JSON.stringify(got)} want ${JSON.stringify(c.expected)}`);
  }
}

console.log(`fnv1a32: ${fnv.length}, bucketing: ${buck.length}, evaluation: ${ev.length}, failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
