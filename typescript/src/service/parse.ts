// Validation of request bodies (BR-xx in spec/business-rules.md). Every parser takes what
// JSON.parse produced, typed `unknown`, and either returns a typed value or throws ServiceError.
import type { Attributes, Context, Event, FlagDraft, Operator, Rule, Scalar, Variant } from "../model/index.js";
import { ServiceError, validationError, variantsError } from "./errors.js";

// `$` without the m flag matches only at the very end of the text, so "abc\n" does not match.
// (In Python, `$` would match before a trailing newline.)
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VARIANT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DIGITS_RE = /^[0-9]+$/; // not \d: in some languages \d also matches non-ASCII digits

const MAX_DESCRIPTION_CODE_POINTS = 500;
const MIN_VARIANTS = 2;
const MAX_VARIANTS = 10;
const MAX_EVENTS = 100;
const OPERATORS: readonly string[] = ["eq", "neq", "in", "not_in"];

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether the client sent the field at all, as opposed to the object merely inheriting a name. */
const has = (o: JsonObject, name: string): boolean => Object.hasOwn(o, name);
const own = (o: JsonObject, name: string): unknown => (has(o, name) ? o[name] : undefined);

/**
 * An integer, or null. JSON.parse cannot tell 10 from 10.0 and the spec treats them alike (BR-30);
 * 10.5, NaN, Infinity and anything absurdly large are not integers for our purposes.
 */
const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 1_000_000_000 ? v : null;

const isScalar = (v: unknown): v is Scalar =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Validates a create/replace body (BR-01, BR-04, BR-08, BR-30..35) and applies the defaults. */
export function parseFlagInput(raw: unknown): FlagDraft {
  if (!isObject(raw)) throw validationError("body must be a JSON object");
  const key = own(raw, "key");
  if (typeof key !== "string") throw validationError("key is required and must be a string");
  if (!KEY_RE.test(key)) throw new ServiceError("INVALID_KEY", `key must match ${KEY_RE.source}`);

  const draft: FlagDraft = { key, description: "", enabled: false, rules: [], rolloutPercent: 100, variants: [] };

  if (has(raw, "description")) {
    const description = raw["description"];
    if (typeof description !== "string") throw validationError("description must be a string");
    // Unicode code points: not bytes, and not UTF-16 units (an emoji is two of those).
    if (Array.from(description).length > MAX_DESCRIPTION_CODE_POINTS) {
      throw validationError(`description must be at most ${MAX_DESCRIPTION_CODE_POINTS} characters`);
    }
    draft.description = description;
  }
  if (has(raw, "enabled")) {
    if (typeof raw["enabled"] !== "boolean") throw validationError("enabled must be a boolean");
    draft.enabled = raw["enabled"];
  }
  if (has(raw, "rolloutPercent")) {
    const n = asInt(raw["rolloutPercent"]);
    if (n === null || n < 0 || n > 100) throw validationError("rolloutPercent must be an integer from 0 to 100");
    draft.rolloutPercent = n;
  }
  if (has(raw, "rules")) draft.rules = parseRules(raw["rules"]);
  if (has(raw, "variants")) draft.variants = parseVariants(raw["variants"]);
  return draft;
}

function parseRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) throw validationError("rules must be an array");
  return raw.map((item: unknown, i): Rule => {
    if (!isObject(item)) throw validationError(`rules[${i}] must be an object`);
    const attribute = own(item, "attribute");
    if (!nonEmptyString(attribute)) throw validationError(`rules[${i}].attribute must be a non-empty string`);
    const operator = own(item, "operator");
    if (typeof operator !== "string" || !OPERATORS.includes(operator)) {
      throw validationError(`rules[${i}].operator must be one of ${OPERATORS.join(", ")}`);
    }
    return { attribute, operator: operator as Operator, value: parseRuleValue(operator, own(item, "value"), i) };
  });
}

function parseRuleValue(operator: string, value: unknown, i: number): Scalar | Scalar[] {
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) {
      throw validationError(`rules[${i}].value must be a non-empty array of scalars`);
    }
    return value as Scalar[];
  }
  if (!isScalar(value)) throw validationError(`rules[${i}].value must be a string, number or boolean`);
  return value;
}

function parseVariants(raw: unknown): Variant[] {
  if (!Array.isArray(raw)) throw validationError("variants must be an array");
  if (raw.length === 0) return [];
  if (raw.length < MIN_VARIANTS || raw.length > MAX_VARIANTS) {
    throw variantsError(`a flag with variants needs ${MIN_VARIANTS} to ${MAX_VARIANTS} of them`);
  }
  const seen = new Set<string>();
  let sum = 0;
  const variants = raw.map((item: unknown, i): Variant => {
    if (!isObject(item)) throw variantsError(`variants[${i}] must be an object`);
    const key = own(item, "key");
    if (typeof key !== "string" || !VARIANT_KEY_RE.test(key)) throw variantsError(`variants[${i}].key must match ${VARIANT_KEY_RE.source}`);
    if (seen.has(key)) throw variantsError(`variant key ${JSON.stringify(key)} is used twice`);
    seen.add(key);
    const weight = asInt(own(item, "weight"));
    if (weight === null || weight < 1 || weight > 100) throw variantsError(`variants[${i}].weight must be an integer from 1 to 100`);
    sum += weight;
    return { key, weight };
  });
  if (sum !== 100) throw variantsError(`weights must add up to 100, got ${sum}`);
  return variants; // the order the client sent is kept: it decides which variant a bucket falls into
}

/** A validated POST /v1/evaluate body. `flags` is null when every flag should be evaluated (BR-23). */
export interface EvaluateRequest {
  flags: string[] | null;
  context: Context;
}

/** Validates an evaluate body (BR-20). */
export function parseEvaluateRequest(raw: unknown): EvaluateRequest {
  if (!isObject(raw)) throw validationError("body must be a JSON object");

  let flags: string[] | null = null;
  if (has(raw, "flags")) {
    const list = raw["flags"];
    if (!Array.isArray(list) || !list.every((f): f is string => typeof f === "string")) {
      throw validationError("flags must be an array of strings");
    }
    flags = list;
  }

  const context: Context = {};
  if (has(raw, "context")) {
    const c = raw["context"];
    if (!isObject(c)) throw validationError("context must be an object");
    if (has(c, "userId")) {
      if (typeof c["userId"] !== "string") throw validationError("context.userId must be a string");
      context.userId = c["userId"];
    }
    if (has(c, "attributes")) {
      const a = c["attributes"];
      if (!isObject(a)) throw validationError("context.attributes must be an object");
      // No prototype: with one, assigning a client-chosen name like "__proto__" would replace the
      // prototype instead of adding an attribute, and "constructor" would look like it was sent.
      const attributes: Record<string, Scalar> = Object.create(null) as Record<string, Scalar>;
      for (const [name, value] of Object.entries(a)) {
        if (!isScalar(value)) throw validationError(`context.attributes.${name} must be a string, number or boolean`);
        attributes[name] = value;
      }
      context.attributes = attributes as Attributes;
    }
  }
  return { flags, context };
}

/** Validates a POST /v1/events body (BR-43). Nothing is returned unless every event is valid. */
export function parseEvents(raw: unknown): Event[] {
  if (!isObject(raw)) throw validationError("body must be a JSON object");
  const list = own(raw, "events");
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_EVENTS) {
    throw validationError(`events must be an array of 1 to ${MAX_EVENTS} events`);
  }
  return list.map((item: unknown, i): Event => {
    if (!isObject(item)) throw validationError(`events[${i}] must be an object`);
    const type = own(item, "type");
    const userId = own(item, "userId");
    if (type !== "exposure" && type !== "conversion") throw validationError(`events[${i}].type must be exposure or conversion`);
    if (!nonEmptyString(userId)) throw validationError(`events[${i}].userId must be a non-empty string`);
    if (has(item, "timestamp")) {
      const ts = item["timestamp"];
      if (typeof ts !== "string" || !isValidTimestamp(ts)) throw validationError(`events[${i}].timestamp must be an RFC 3339 string`);
    }
    if (type === "exposure") {
      const flagKey = own(item, "flagKey");
      const variant = own(item, "variant");
      if (!nonEmptyString(flagKey)) throw validationError(`events[${i}].flagKey is required for an exposure`);
      if (!nonEmptyString(variant)) throw validationError(`events[${i}].variant is required for an exposure`);
      return { type, userId, flagKey, variant };
    }
    const goal = own(item, "goal");
    if (!nonEmptyString(goal)) throw validationError(`events[${i}].goal is required for a conversion`);
    return { type, userId, goal };
  });
}

const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * RFC 3339 that is also correct on the calendar (BR-43). `Date.parse` alone is far too lenient: it
 * accepts Feb 30 (as March 2), hour 24, a bare date and a time without a zone.
 */
export function isValidTimestamp(s: string): boolean {
  const m = TIMESTAMP_RE.exec(s);
  if (m === null) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month, 0); // day 0 of the next month is the last day of this one
  if (day < 1 || day > lastDay.getUTCDate()) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false; // zone offset
  return true;
}

/** Reads limit and offset from a query string (BR-50). The first value wins when one is repeated. */
export function parsePage(params: URLSearchParams): { limit: number; offset: number } {
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = params.get(name); // null when absent; get() returns the first of repeated values
    if (raw === null) return fallback;
    if (!DIGITS_RE.test(raw)) throw validationError(`${name} must be an integer`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw validationError(`${name} must be between ${min} and ${max}`);
    return n;
  };
  return { limit: number("limit", 20, 1, 100), offset: number("offset", 0, 0, 2_147_483_647) };
}
