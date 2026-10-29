// Decides what a flag means for a user. A pure function of its arguments: no I/O, no clock, no
// randomness. The rules are in spec/evaluation.md and are checked against tests/vectors.
import type { Attributes, Context, EvaluationResult, Flag, Reason, Rule, Scalar } from "../model/index.js";

const BUCKETS = 10000;

/**
 * 32-bit FNV-1a over the UTF-8 bytes of `input`.
 *
 * Two JavaScript traps are avoided here. Numbers are doubles, so `h * 16777619` silently loses
 * low bits once it passes 2^53: `Math.imul` multiplies as 32-bit integers instead. And
 * `charCodeAt` yields UTF-16 units, which hashes every non-ASCII input differently: the bytes
 * come from `Buffer.from(input, "utf8")`.
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(input, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0; // >>> 0 turns the signed 32-bit result back into unsigned
  }
  return h >>> 0;
}

/** Maps (flagKey, salt, userId) to 0..9999. */
export function bucket(flagKey: string, salt: string, userId: string): number {
  return fnv1a32(`${flagKey}:${salt}:${userId}`) % BUCKETS;
}

const off = (reason: Reason): EvaluationResult => ({ enabled: false, variant: null, reason });

/** Evaluates `flag` for `ctx`. A null flag means the flag does not exist. */
export function evaluate(flag: Flag | null, ctx: Context): EvaluationResult {
  if (flag === null) return off("FLAG_NOT_FOUND");
  if (!flag.enabled) return off("DISABLED");
  if (!flag.rules.every((rule) => ruleMatches(rule, ctx.attributes))) return off("TARGETING_MISS");

  const userId = ctx.userId ?? "";
  const needsBucket = flag.rolloutPercent < 100 || flag.variants.length > 0;
  if (needsBucket && userId === "") return off("MISSING_USER_ID");
  if (flag.rolloutPercent < 100 && bucket(flag.key, "rollout", userId) >= flag.rolloutPercent * 100) {
    return off("NOT_IN_ROLLOUT");
  }
  if (flag.variants.length === 0) return { enabled: true, variant: null, reason: "ON" };

  const b = bucket(flag.key, "variant", userId);
  let threshold = 0;
  for (const variant of flag.variants) {
    threshold += variant.weight * 100;
    if (b < threshold) return { enabled: true, variant: variant.key, reason: "VARIANT" };
  }
  // Unreachable while weights add up to 100, which the service guarantees.
  return off("DISABLED");
}

/**
 * Whether `rule` holds for `attrs`. A missing attribute fails every operator, including neq and
 * not_in. "Missing" means no own property: `attrs["constructor"]` or `"toString" in attrs` would
 * find members of Object.prototype that the client never sent.
 */
function ruleMatches(rule: Rule, attrs: Attributes | undefined): boolean {
  if (attrs === undefined || !Object.hasOwn(attrs, rule.attribute)) return false;
  const got = attrs[rule.attribute] as Scalar;
  switch (rule.operator) {
    case "eq":
      return scalarEqual(got, rule.value);
    case "neq":
      return !scalarEqual(got, rule.value);
    case "in":
      return contains(rule.value, got);
    case "not_in":
      return !contains(rule.value, got);
  }
}

function contains(list: unknown, got: Scalar): boolean {
  return Array.isArray(list) && list.some((item) => scalarEqual(got, item));
}

/** Strict equality, no conversion: "1" is not 1 and true is not "true" (JavaScript's `==` would say otherwise). */
function scalarEqual(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && a === b;
}
