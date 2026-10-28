import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import type { Flag, Results } from "../model/index.js";
import { SqliteRepository } from "../repository/sqlite.js";
import { ServiceError } from "./errors.js";
import { isValidTimestamp, parseEvaluateRequest, parsePage } from "./parse.js";
import { Service } from "./service.js";

/** A service on a private in-memory database whose clock hands out a later time on every call. */
function newService(t: TestContext): { svc: Service; clock: { ms: number } } {
  const repo = new SqliteRepository(":memory:");
  t.after(() => repo.close());
  const clock = { ms: Date.parse("2026-01-31T08:00:00.000Z") };
  const svc = new Service(repo, () => new Date((clock.ms += 1000)).toISOString());
  return { svc, clock };
}

const json = (text: string): unknown => JSON.parse(text);

/** The error code a call fails with, "OK" if it does not fail, or the error's name if it is not a ServiceError. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "OK";
  } catch (e) {
    return e instanceof ServiceError ? e.code : `NOT_A_SERVICE_ERROR(${String(e)})`;
  }
}

function create(svc: Service, body: string): Flag {
  return svc.createFlag(json(body));
}

describe("BR-01, BR-08: key format and defaults", () => {
  test("valid and invalid keys", (t) => {
    const { svc } = newService(t);
    for (const k of ["a", "0", "a-b_c", "9lives", "x".repeat(64)]) assert.equal(codeOf(() => svc.createFlag({ key: k })), "OK", k);
    const invalid: Record<string, string> = {
      empty: "", upper: "Upper", "leading hyphen": "-abc", "leading underscore": "_abc", space: "a b", slash: "a/b",
      dot: "a.b", thai: "ไทย", "65 chars": "x".repeat(65), "trailing newline": "abc\n", "only a newline": "\n",
    };
    for (const [name, k] of Object.entries(invalid)) assert.equal(codeOf(() => svc.createFlag({ key: k })), "INVALID_KEY", name);
    for (const body of ["{}", '{"key":1}', '{"key":null}', '{"key":{}}']) assert.equal(codeOf(() => svc.createFlag(json(body))), "VALIDATION_ERROR", body);
  });

  test("defaults apply when fields are omitted", (t) => {
    const { svc } = newService(t);
    const f = create(svc, '{"key":"plain"}');
    assert.deepEqual([f.description, f.enabled, f.rolloutPercent, f.rules, f.variants], ["", false, 100, [], []]);
    assert.equal(f.createdAt, f.updatedAt);
    assert.match(f.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});

describe("BR-02, BR-04, BR-05, BR-06", () => {
  test("BR-02: a taken key is rejected and nothing is audited", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"dup","description":"first"}');
    assert.equal(codeOf(() => create(svc, '{"key":"dup","description":"second"}')), "FLAG_EXISTS");
    assert.equal(svc.getFlag("dup").description, "first");
    assert.equal(svc.listAudit(undefined, 10, 0).total, 1);
  });

  test("BR-04: description is counted in code points", (t) => {
    const { svc } = newService(t);
    const cases: [string, string, boolean][] = [
      ["500 ASCII", "a".repeat(500), true], ["501 ASCII", "a".repeat(501), false],
      ["500 emoji (1000 UTF-16 units, 2000 bytes)", "😀".repeat(500), true], ["501 emoji", "😀".repeat(501), false],
      ["500 Thai (1500 bytes)", "ก".repeat(500), true],
    ];
    cases.forEach(([name, text, ok], i) => {
      assert.equal(codeOf(() => svc.createFlag({ key: `d-${i}`, description: text })), ok ? "OK" : "VALIDATION_ERROR", name);
    });
  });

  test("BR-04: wrong types are rejected", (t) => {
    const { svc } = newService(t);
    const bodies = [
      '{"key":"k","description":5}', '{"key":"k","description":null}', '{"key":"k","enabled":"true"}',
      '{"key":"k","enabled":1}', '{"key":"k","enabled":null}', "[]", "null", '"x"', "1",
    ];
    for (const b of bodies) assert.equal(codeOf(() => svc.createFlag(json(b))), "VALIDATION_ERROR", b);
    assert.equal(codeOf(() => svc.createFlag(undefined)), "VALIDATION_ERROR", "no body at all");
  });

  test("BR-04: text survives a store and load byte for byte", (t) => {
    const { svc } = newService(t);
    const want = "ธงฟีเจอร์ 🚩 café 日本語";
    svc.createFlag({ key: "text", description: want });
    assert.equal(svc.getFlag("text").description, want);
  });

  test("BR-05: an unknown flag is not found, and nothing is audited", (t) => {
    const { svc } = newService(t);
    assert.equal(codeOf(() => svc.getFlag("nope")), "FLAG_NOT_FOUND");
    assert.equal(codeOf(() => svc.updateFlag("nope", { key: "nope" })), "FLAG_NOT_FOUND");
    assert.equal(codeOf(() => svc.deleteFlag("nope")), "FLAG_NOT_FOUND");
    assert.equal(svc.listAudit(undefined, 10, 0).total, 0);
  });

  test("BR-06: delete removes the flag and frees the key", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"gone","description":"first life"}');
    svc.deleteFlag("gone");
    assert.equal(codeOf(() => svc.getFlag("gone")), "FLAG_NOT_FOUND");
    assert.equal(create(svc, '{"key":"gone","description":"second life"}').description, "second life");
  });

  test("BR-21: evaluating a deleted flag reports FLAG_NOT_FOUND", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"gone","enabled":true}');
    svc.deleteFlag("gone");
    const res = svc.evaluate(json('{"flags":["gone"],"context":{"userId":"u1"}}'));
    assert.deepEqual(res.get("gone"), { enabled: false, variant: null, reason: "FLAG_NOT_FOUND" });
  });
});

describe("BR-03, BR-09, BR-51: replacing a flag", () => {
  test("BR-09: update is a full replace and keeps createdAt", (t) => {
    const { svc } = newService(t);
    const old = create(svc, `{"key":"u","description":"v1","enabled":true,"rolloutPercent":10,
      "rules":[{"attribute":"a","operator":"eq","value":1}],"variants":[{"key":"a","weight":50},{"key":"b","weight":50}]}`);
    const got = svc.updateFlag("u", json('{"key":"u"}'));
    assert.deepEqual([got.description, got.enabled, got.rolloutPercent, got.rules, got.variants], ["", false, 100, [], []]);
    assert.equal(got.createdAt, old.createdAt);
    assert.ok(got.updatedAt > old.updatedAt);
    assert.deepEqual(svc.getFlag("u"), got);
  });

  test("BR-09: updatedAt never goes backwards, even if the clock does", (t) => {
    const { svc, clock } = newService(t);
    const old = create(svc, '{"key":"u"}');
    clock.ms -= 3_600_000;
    assert.ok(svc.updateFlag("u", { key: "u" }).updatedAt >= old.updatedAt);
  });

  test("BR-03: the key cannot change and nothing is written", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"stay","description":"x"}');
    assert.equal(codeOf(() => svc.updateFlag("stay", { key: "moved", description: "y" })), "KEY_IMMUTABLE");
    assert.equal(svc.getFlag("stay").description, "x");
    assert.equal(codeOf(() => svc.getFlag("moved")), "FLAG_NOT_FOUND");
  });

  test("BR-51: validation comes before existence checks", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"v"}');
    assert.equal(codeOf(() => svc.createFlag({ key: "v", enabled: "yes" })), "VALIDATION_ERROR");
    assert.equal(codeOf(() => svc.updateFlag("missing", { key: "missing", enabled: "yes" })), "VALIDATION_ERROR");
  });
});

describe("BR-07: audit log", () => {
  test("each successful change writes one entry with before and after", (t) => {
    const { svc } = newService(t);
    const created = create(svc, '{"key":"a","description":"1"}');
    const updated = svc.updateFlag("a", json('{"key":"a","description":"2","enabled":true}'));
    svc.deleteFlag("a");
    const { items, total } = svc.listAudit("a", 10, 0);
    assert.equal(total, 3);
    const [del, upd, cre] = items;
    assert.deepEqual([del?.action, upd?.action, cre?.action], ["delete", "update", "create"]);
    assert.deepEqual([cre?.before, cre?.after], [null, created]);
    assert.deepEqual([upd?.before, upd?.after], [created, updated]);
    assert.deepEqual([del?.before, del?.after], [updated, null]);
    assert.match(JSON.stringify(del), /"after":null/);
  });

  test("rejected changes are not audited", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"a"}');
    codeOf(() => svc.createFlag({ key: "a" })); // FLAG_EXISTS
    codeOf(() => svc.updateFlag("a", { key: "a", enabled: "yes" })); // VALIDATION_ERROR
    codeOf(() => svc.updateFlag("a", { key: "b" })); // KEY_IMMUTABLE
    codeOf(() => svc.updateFlag("zzz", { key: "zzz" })); // FLAG_NOT_FOUND
    codeOf(() => svc.deleteFlag("zzz")); // FLAG_NOT_FOUND
    assert.equal(svc.listAudit(undefined, 10, 0).total, 1);
  });
});

describe("BR-30 .. BR-35: rollout, variants and rules", () => {
  test("BR-30: rolloutPercent is an integer from 0 to 100; 10.0 counts as 10", (t) => {
    const { svc } = newService(t);
    ["0", "1", "50", "99", "100", "10.0", "1e1", "1.0E1"].forEach((v, i) => assert.equal(codeOf(() => svc.createFlag(json(`{"key":"r-${i}","rolloutPercent":${v}}`))), "OK", v));
    assert.equal(svc.getFlag("r-5").rolloutPercent, 10);
    for (const v of ["-1", "101", "10.5", '"50"', "null", "true", "1e10", "[]", "1e999"]) {
      assert.equal(codeOf(() => svc.createFlag(json(`{"key":"bad","rolloutPercent":${v}}`))), "VALIDATION_ERROR", v);
    }
  });

  const two = (a: number, b: number) => `[{"key":"a","weight":${a}},{"key":"b","weight":${b}}]`;
  const many = (n: number, weightOf: (i: number) => number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ key: `v${i}`, weight: weightOf(i) })));

  test("BR-31 .. BR-34: valid variant sets", (t) => {
    const { svc } = newService(t);
    const valid: Record<string, string> = {
      "50/30/20": '[{"key":"blue","weight":50},{"key":"green","weight":30},{"key":"red","weight":20}]',
      "99/1": two(99, 1), ten: many(10, () => 10), "key of 32": `[{"key":"${"a".repeat(32)}","weight":50},{"key":"b","weight":50}]`, "empty list": "[]",
    };
    Object.entries(valid).forEach(([name, v], i) => assert.equal(codeOf(() => svc.createFlag(json(`{"key":"ok-${i}","variants":${v}}`))), "OK", name));
  });

  test("BR-31 .. BR-34: invalid variant sets", (t) => {
    const { svc } = newService(t);
    const invalid: Record<string, string> = {
      "sum 99 (BR-31)": two(50, 49), "sum 101 (BR-31)": two(51, 50),
      "duplicate key (BR-32)": '[{"key":"a","weight":50},{"key":"a","weight":50}]',
      "upper-case key (BR-32)": '[{"key":"Blue","weight":50},{"key":"b","weight":50}]',
      "empty key (BR-32)": '[{"key":"","weight":50},{"key":"b","weight":50}]',
      "key with space (BR-32)": '[{"key":"a b","weight":50},{"key":"b","weight":50}]',
      "key of 33 (BR-32)": `[{"key":"${"a".repeat(33)}","weight":50},{"key":"b","weight":50}]`,
      "key is a number (BR-32)": '[{"key":1,"weight":50},{"key":"b","weight":50}]',
      "missing key (BR-32)": '[{"weight":50},{"key":"b","weight":50}]',
      "one variant (BR-33)": '[{"key":"a","weight":100}]',
      "eleven variants (BR-33)": many(11, (i) => (i === 0 ? 10 : 9)),
      "zero weight (BR-34)": two(100, 0), "negative weight (BR-34)": two(150, -50), "fractional weight (BR-34)": two(50.5, 49.5),
      "string weight (BR-34)": '[{"key":"a","weight":"50"},{"key":"b","weight":50}]',
      "missing weight (BR-34)": '[{"key":"a"},{"key":"b","weight":100}]', "entries not objects": '["a","b"]',
    };
    for (const [name, v] of Object.entries(invalid)) assert.equal(codeOf(() => svc.createFlag(json(`{"key":"bad","variants":${v}}`))), "INVALID_VARIANTS", name);
    assert.equal(codeOf(() => svc.createFlag(json('{"key":"bad","variants":"blue"}'))), "VALIDATION_ERROR");
  });

  test("BR-33: the order the client sent is kept", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"o","variants":[{"key":"z","weight":10},{"key":"a","weight":60},{"key":"m","weight":30}]}');
    assert.deepEqual(svc.getFlag("o").variants.map((v) => v.key), ["z", "a", "m"]);
  });

  test("BR-35: rules are stored and returned unchanged", (t) => {
    const { svc } = newService(t);
    const f = create(svc, `{"key":"r","rules":[
      {"attribute":"country","operator":"eq","value":"TH"},{"attribute":"plan","operator":"neq","value":"free"},
      {"attribute":"tier","operator":"in","value":[1,2,3]},{"attribute":"region","operator":"not_in","value":["eu","us"]},
      {"attribute":"beta","operator":"eq","value":true},{"attribute":"age","operator":"eq","value":0},
      {"attribute":"flag","operator":"eq","value":false},{"attribute":"name","operator":"eq","value":""}]}`);
    assert.equal(f.rules.length, 8);
    assert.deepEqual(svc.getFlag("r").rules, f.rules);
  });

  test("BR-35: invalid rules", (t) => {
    const { svc } = newService(t);
    const invalid: Record<string, string> = {
      "rules not an array": '"x"', "rule not an object": '["x"]', "missing attribute": '[{"operator":"eq","value":1}]',
      "empty attribute": '[{"attribute":"","operator":"eq","value":1}]', "attribute is a number": '[{"attribute":1,"operator":"eq","value":1}]',
      "missing operator": '[{"attribute":"a","value":1}]', "unknown operator": '[{"attribute":"a","operator":"gt","value":1}]',
      "missing value": '[{"attribute":"a","operator":"eq"}]', "null value": '[{"attribute":"a","operator":"eq","value":null}]',
      "eq with array": '[{"attribute":"a","operator":"eq","value":[1]}]', "neq with object": '[{"attribute":"a","operator":"neq","value":{}}]',
      "in with scalar": '[{"attribute":"a","operator":"in","value":"x"}]', "in with empty array": '[{"attribute":"a","operator":"in","value":[]}]',
      "not_in with scalar": '[{"attribute":"a","operator":"not_in","value":1}]', "in with nested array": '[{"attribute":"a","operator":"in","value":[[1]]}]',
      "in containing null": '[{"attribute":"a","operator":"in","value":[null]}]', "Infinity as a value": '[{"attribute":"a","operator":"eq","value":1e999}]',
    };
    for (const [name, v] of Object.entries(invalid)) assert.equal(codeOf(() => svc.createFlag(json(`{"key":"bad","rules":${v}}`))), "VALIDATION_ERROR", name);
  });
});

describe("BR-20 .. BR-23: evaluate", () => {
  test("BR-20: request validation", (t) => {
    const { svc } = newService(t);
    const invalid: Record<string, string> = {
      "body array": "[]", "body null": "null", "flags not an array": '{"flags":"a"}', "flags contain a number": '{"flags":["a",1]}',
      "flags contain null": '{"flags":[null]}', "flags null": '{"flags":null}', "context array": '{"context":[]}', "context string": '{"context":"u1"}',
      "context null": '{"context":null}', "userId number": '{"context":{"userId":1}}', "userId null": '{"context":{"userId":null}}',
      "attributes array": '{"context":{"attributes":[]}}', "attribute null": '{"context":{"attributes":{"a":null}}}',
      "attribute object": '{"context":{"attributes":{"a":{}}}}', "attribute array": '{"context":{"attributes":{"a":[1]}}}',
    };
    for (const [name, body] of Object.entries(invalid)) assert.equal(codeOf(() => svc.evaluate(json(body))), "VALIDATION_ERROR", name);
    for (const body of ["{}", '{"flags":[]}', '{"context":{}}', '{"context":{"userId":"u","attributes":{"s":"x","n":1,"b":false}}}']) {
      assert.equal(codeOf(() => svc.evaluate(json(body))), "OK", body);
    }
  });

  test("BR-23: `flags` selects what is evaluated", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"a","enabled":true}');
    create(svc, '{"key":"b","enabled":false}');
    const keys = (body: string) => [...svc.evaluate(json(body)).keys()].sort();
    assert.deepEqual(keys("{}"), ["a", "b"]);
    assert.deepEqual(keys('{"flags":[]}'), []);
    assert.deepEqual(keys('{"flags":["a","ghost"]}'), ["a", "ghost"]);
    const res = svc.evaluate(json('{"flags":["a","b","ghost"],"context":{"userId":"u"}}'));
    assert.deepEqual([res.get("a")?.reason, res.get("b")?.reason, res.get("ghost")?.reason], ["ON", "DISABLED", "FLAG_NOT_FOUND"]);
  });

  test("names the client chooses are plain keys, even __proto__ and constructor", (t) => {
    const { svc } = newService(t);
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    const res = svc.evaluate(json(`{"flags":${JSON.stringify(names)}}`));
    assert.deepEqual([...res.keys()], names);
    for (const n of names) assert.equal(res.get(n)?.reason, "FLAG_NOT_FOUND", n);
    // and they survive being turned into a response body
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(Object.fromEntries(res)))), names);
  });

  test("attribute names such as __proto__ become real attributes with no prototype", () => {
    const { context } = parseEvaluateRequest(json('{"context":{"attributes":{"__proto__":"x","constructor":"y"}}}'));
    assert.equal(Object.getPrototypeOf(context.attributes), null);
    assert.deepEqual(Object.keys(context.attributes ?? {}), ["__proto__", "constructor"]);
    assert.equal(Object.hasOwn(context.attributes ?? {}, "toString"), false);
  });

  test("BR-22: evaluating writes nothing", (t) => {
    const { svc } = newService(t);
    const before = create(svc, '{"key":"a","enabled":true}');
    svc.evaluate(json('{"context":{"userId":"u"}}'));
    svc.evaluate(json('{"flags":["a"]}'));
    assert.deepEqual(svc.getFlag("a"), before);
    assert.equal(svc.listAudit(undefined, 10, 0).total, 1);
  });
});

describe("BR-43 .. BR-46: events and results", () => {
  const conversion = (u: string, g: string) => `{"type":"conversion","userId":"${u}","goal":"${g}"}`;
  const one = (event: string) => json(`{"events":[${event}]}`);
  const ab = '{"key":"f","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}';

  function record(svc: Service, ...events: string[]): void {
    for (let i = 0; i < events.length; i += 100) svc.recordEvents(json(`{"events":[${events.slice(i, i + 100).join(",")}]}`));
  }
  const exposures = (flag: string, prefix: string, variant: string, n: number) =>
    Array.from({ length: n }, (_, i) => `{"type":"exposure","userId":"${prefix}${i}","flagKey":"${flag}","variant":"${variant}"}`);
  const conversions = (goal: string, prefix: string, n: number) => Array.from({ length: n }, (_, i) => conversion(`${prefix}${i}`, goal));
  const row = (r: Results, i: number) => r.variants[i]!;

  test("BR-43: event validation", (t) => {
    const { svc } = newService(t);
    const hundred = Array.from({ length: 100 }, () => conversion("u", "g")).join(",");
    const invalid: Record<string, unknown> = {
      "body not an object": json("[]"), "no events": json("{}"), "events not an array": json('{"events":{}}'), "empty events": json('{"events":[]}'),
      "101 events": json(`{"events":[${hundred},${conversion("u", "g")}]}`), "unknown type": one('{"type":"click","userId":"u"}'),
      "missing type": one('{"userId":"u","goal":"g"}'), "missing userId": one('{"type":"conversion","goal":"g"}'),
      "empty userId": one('{"type":"conversion","userId":"","goal":"g"}'), "userId number": one('{"type":"conversion","userId":1,"goal":"g"}'),
      "exposure no flagKey": one('{"type":"exposure","userId":"u","variant":"a"}'), "exposure no variant": one('{"type":"exposure","userId":"u","flagKey":"f"}'),
      "exposure empty variant": one('{"type":"exposure","userId":"u","flagKey":"f","variant":""}'), "conversion no goal": one('{"type":"conversion","userId":"u"}'),
      "conversion empty goal": one('{"type":"conversion","userId":"u","goal":""}'), "event not an object": one('"x"'),
    };
    for (const [name, body] of Object.entries(invalid)) assert.equal(codeOf(() => svc.recordEvents(body)), "VALIDATION_ERROR", name);
    assert.equal(svc.recordEvents(json(`{"events":[${hundred}]}`)), 100);
  });

  test("BR-43: timestamps must be RFC 3339 and correct on the calendar", (t) => {
    const { svc } = newService(t);
    const withTs = (ts: unknown) => one(`{"type":"conversion","userId":"u","goal":"g","timestamp":${JSON.stringify(ts)}}`);
    const valid = ["2026-01-31T08:00:00Z", "2026-01-31T15:00:00.250+07:00", "2028-02-29T23:59:59Z", "2026-12-31T23:59:59-05:30", "2026-06-30T23:59:59.999999999Z"];
    for (const ts of valid) assert.equal(codeOf(() => svc.recordEvents(withTs(ts))), "OK", ts);
    const invalid = [
      "yesterday", "", "2026-02-30T00:00:00Z", "2027-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z",
      "2026-01-00T00:00:00Z", "2026-01-31T24:00:00Z", "2026-01-31T08:60:00Z", "2026-01-31T08:00:60Z", "2026-01-31", "2026-01-31T08:00:00",
      "2026-01-31T08:00:00+0700", "2026-01-31T08:00:00+24:00", "2026-01-31T08:00:00-24:00", "2026-01-31T08:00:00+07:60", "2026-01-31t08:00:00z",
      "2026-01-31T8:00:00Z", "2026-01-31T08:00:00,5Z", "2026-01-31T08:00:00.Z", "2026-01-31 08:00:00Z",
      " 2026-01-31T08:00:00Z", "2026-01-31T08:00:00Z\n", "٢٠٢٦-٠١-٣١T٠٨:٠٠:٠٠Z",
    ];
    for (const ts of invalid) assert.equal(codeOf(() => svc.recordEvents(withTs(ts))), "VALIDATION_ERROR", JSON.stringify(ts));
    assert.equal(codeOf(() => svc.recordEvents(withTs(1700000000))), "VALIDATION_ERROR", "number");
    // the lenient built-in would have accepted several of these
    assert.equal(Number.isNaN(Date.parse("2026-02-30T00:00:00Z")), false);
    assert.equal(isValidTimestamp("2026-02-30T00:00:00Z"), false);
  });

  test("BR-44: a batch with one bad event stores nothing", (t) => {
    const { svc } = newService(t);
    create(svc, ab);
    const bad = json(`{"events":[${exposures("f", "u", "control", 1)[0]},{"type":"exposure","userId":"u2"}]}`);
    assert.equal(codeOf(() => svc.recordEvents(bad)), "VALIDATION_ERROR");
    assert.equal(row(svc.results("f", "g"), 0).exposures, 0);
  });

  test("BR-46: results errors and shape", (t) => {
    const { svc } = newService(t);
    create(svc, '{"key":"plain","enabled":true}');
    create(svc, ab.replace('"f"', '"ab"'));
    assert.equal(codeOf(() => svc.results("ab", "")), "VALIDATION_ERROR");
    assert.equal(codeOf(() => svc.results("ghost", "g")), "FLAG_NOT_FOUND");
    assert.equal(codeOf(() => svc.results("ghost", "")), "VALIDATION_ERROR", "validation before existence");
    assert.deepEqual(svc.results("plain", "g"), { flagKey: "plain", goal: "g", variants: [] });
    const zero = { exposures: 0, conversions: 0, rate: 0, pValue: null, significant: false };
    assert.deepEqual(svc.results("ab", "buy"), {
      flagKey: "ab", goal: "buy", variants: [{ variant: "control", ...zero }, { variant: "treatment", ...zero }],
    });
  });

  test("BR-40, BR-41: counting rules", (t) => {
    const { svc } = newService(t);
    create(svc, ab);
    record(svc,
      '{"type":"exposure","userId":"u1","flagKey":"f","variant":"control"}', '{"type":"exposure","userId":"u1","flagKey":"f","variant":"control"}',
      '{"type":"exposure","userId":"u2","flagKey":"f","variant":"control"}', '{"type":"exposure","userId":"u2","flagKey":"f","variant":"treatment"}',
      '{"type":"exposure","userId":"u3","flagKey":"f","variant":"treatment"}',
      conversion("u1", "buy"), conversion("u1", "buy"), conversion("stranger", "buy"), conversion("u3", "signup"));
    const buy = svc.results("f", "buy");
    assert.deepEqual([row(buy, 0).exposures, row(buy, 0).conversions, row(buy, 0).rate], [2, 1, 0.5]);
    assert.deepEqual([row(buy, 1).exposures, row(buy, 1).conversions, row(buy, 1).rate], [1, 0, 0]);
    const signup = svc.results("f", "signup");
    assert.deepEqual([row(signup, 0).conversions, row(signup, 1).conversions], [0, 1]);
  });

  test("BR-42: small samples report no p-value", (t) => {
    const { svc } = newService(t);
    create(svc, ab);
    record(svc, ...exposures("f", "c", "control", 29), ...exposures("f", "t", "treatment", 29), ...conversions("buy", "t", 29));
    for (const r of svc.results("f", "buy").variants) assert.deepEqual([r.pValue, r.significant], [null, false], r.variant);
  });

  test("BR-42: the two-proportion z-test, two-sided", (t) => {
    const { svc } = newService(t);
    create(svc, ab);
    record(svc, ...exposures("f", "c", "control", 200), ...exposures("f", "t", "treatment", 200), ...conversions("buy", "c", 20), ...conversions("buy", "t", 40));
    const res = svc.results("f", "buy");
    assert.deepEqual([row(res, 0).pValue, row(res, 0).significant], [null, false], "the control has nothing to compare with");
    assert.ok(Math.abs(row(res, 0).rate - 0.1) < 1e-12 && Math.abs(row(res, 1).rate - 0.2) < 1e-12);
    // pooled p = 0.15, se = 0.035707, z = 2.80056, erfc(z / sqrt 2) = 0.005101399646004991 (from Go's math.Erfc)
    assert.ok(Math.abs(row(res, 1).pValue! - 0.005101399646004991) < 1e-12, String(row(res, 1).pValue));
    assert.equal(row(res, 1).significant, true);

    // the mirror image: the treatment is worse, the p-value is the same
    create(svc, ab.replace('"f"', '"g2"'));
    record(svc, ...exposures("g2", "c", "control", 200), ...exposures("g2", "t", "treatment", 200), ...conversions("lose", "c", 40), ...conversions("lose", "t", 20));
    const lose = svc.results("g2", "lose");
    assert.ok(Math.abs(row(lose, 1).pValue! - 0.005101399646004991) < 1e-12);
    assert.equal(row(lose, 1).significant, true);
  });

  test("BR-42: identical rates are not significant; nobody converting gives no p-value", (t) => {
    const { svc } = newService(t);
    create(svc, ab.replace('"f"', '"same"'));
    record(svc, ...exposures("same", "c", "control", 100), ...exposures("same", "t", "treatment", 100), ...conversions("buy", "c", 30), ...conversions("buy", "t", 30));
    const same = row(svc.results("same", "buy"), 1);
    assert.ok(same.pValue !== null && Math.abs(same.pValue - 1) < 1e-12 && !same.significant);

    create(svc, ab.replace('"f"', '"none"'));
    record(svc, ...exposures("none", "c", "control", 40), ...exposures("none", "t", "treatment", 40));
    // a conversion is keyed by (goal, user) across flags, so use a goal the first experiment never touched
    const none = row(svc.results("none", "never-converted"), 1);
    assert.deepEqual([none.pValue, none.significant], [null, false]);
  });
});

describe("BR-50: paging", () => {
  test("limit and offset", () => {
    const page = (q: string) => parsePage(new URLSearchParams(q));
    assert.deepEqual(page(""), { limit: 20, offset: 0 });
    assert.deepEqual(page("limit=1"), { limit: 1, offset: 0 });
    assert.deepEqual(page("limit=100"), { limit: 100, offset: 0 });
    assert.deepEqual(page("limit=7&offset=1000000"), { limit: 7, offset: 1000000 });
    assert.deepEqual(page("limit=1&limit=2"), { limit: 1, offset: 0 }, "the first of repeated values wins");
    assert.deepEqual(page("limit=007"), { limit: 7, offset: 0 });
    for (const q of ["limit=0", "limit=101", "limit=-1", "limit=abc", "limit=1.5", "limit=", "limit=+5", "limit=1e1", "limit=%D9%A5", "offset=-1", "offset=abc", "offset=99999999999999999999"]) {
      assert.throws(() => page(q), (e: unknown) => e instanceof ServiceError && e.code === "VALIDATION_ERROR", q);
    }
  });

  test("listFlags pages in key order with the total", (t) => {
    const { svc } = newService(t);
    for (const k of ["c", "a", "b"]) svc.createFlag({ key: k });
    const page = svc.listFlags(2, 1);
    assert.deepEqual([page.items.map((f) => f.key), page.total], [["b", "c"], 3]);
  });
});
