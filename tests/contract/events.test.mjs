// Exposure / conversion events and experiment results (MVP2).
// Covers BR-40..46 and the statistics in BR-42.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { get, post, uniqueKey, assertError, fixture, mvp2 } from "./lib.mjs";

const fx = fixture();
after(() => fx.cleanup());

const send = (events, auth = "client") => post("/v1/events", { events }, { auth });
const exposure = (flagKey, userId, variant) => ({ type: "exposure", flagKey, userId, variant });
const conversion = (userId, goal) => ({ type: "conversion", userId, goal });
const abFlag = () => fx.create({ enabled: true, variants: [{ key: "control", weight: 50 }, { key: "treatment", weight: 50 }] });
// Conversions are keyed by (goal, userId) across all flags, so every test uses its own goal.
const results = (key, goal) => get(`/v1/flags/${key}/results?goal=${encodeURIComponent(goal)}`);

/** Sends events in batches of 100 (the API limit) and asserts each batch is accepted. */
async function sendAll(events) {
  for (let i = 0; i < events.length; i += 100) {
    const batch = events.slice(i, i + 100);
    const res = await send(batch);
    assert.equal(res.status, 202, res.text);
    assert.equal(res.body.accepted, batch.length);
  }
}

describe("POST /v1/events (BR-11, BR-43, BR-44)", mvp2, () => {
  test("auth: no key / wrong key -> 401, client and admin keys accepted (BR-11)", async () => {
    const e = [exposure("f", "u1", "a")];
    assertError(await send(e, "none"), 401, "UNAUTHORIZED");
    assertError(await send(e, "bad-client"), 401, "UNAUTHORIZED");
    assert.equal((await send(e, "client")).status, 202);
    assert.equal((await send(e, "admin")).status, 202);
  });

  test("one event -> 202 accepted:1", async () => {
    const res = await send([exposure("some-flag", "u1", "control")]);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { accepted: 1 });
  });

  test("a mixed batch counts every event (BR-44)", async () => {
    const res = await send([exposure("f", "u1", "a"), conversion("u1", "g"), exposure("f", "u1", "a")]);
    assert.deepEqual(res.body, { accepted: 3 });
  });

  test("100 events are accepted, 101 are not", async () => {
    const make = (n) => Array.from({ length: n }, (_, i) => conversion(`u${i}`, "limit-test"));
    assert.equal((await send(make(100))).status, 202);
    assertError(await send(make(101)), 400, "VALIDATION_ERROR");
  });

  test("an optional RFC 3339 timestamp is accepted", async () => {
    const e = { ...exposure("f", "u1", "a"), timestamp: "2026-01-31T08:00:00Z" };
    assert.equal((await send([e])).status, 202);
    assert.equal((await send([{ ...e, timestamp: "2026-01-31T15:00:00.250+07:00" }])).status, 202);
    assert.equal((await send([{ ...e, timestamp: "2028-02-29T23:59:59Z" }])).status, 202, "Feb 29 in a leap year");
    assert.equal((await send([{ ...e, timestamp: "2026-12-31T23:59:59-05:30" }])).status, 202, "negative offset");
  });

  const invalid = [
    ["empty events array", []],
    ["unknown type", [{ type: "click", userId: "u1" }]],
    ["missing type", [{ userId: "u1", goal: "g" }]],
    ["missing userId", [{ type: "conversion", goal: "g" }]],
    ["empty userId", [{ type: "conversion", userId: "", goal: "g" }]],
    ["userId is a number", [{ type: "conversion", userId: 1, goal: "g" }]],
    ["exposure without flagKey", [{ type: "exposure", userId: "u1", variant: "a" }]],
    ["exposure without variant", [{ type: "exposure", userId: "u1", flagKey: "f" }]],
    ["exposure with empty variant", [{ type: "exposure", userId: "u1", flagKey: "f", variant: "" }]],
    ["conversion without goal", [{ type: "conversion", userId: "u1" }]],
    ["conversion with empty goal", [{ type: "conversion", userId: "u1", goal: "" }]],
    ["timestamp is not a string", [{ ...conversion("u1", "g"), timestamp: 1700000000 }]],
    ["timestamp is not RFC 3339", [{ ...conversion("u1", "g"), timestamp: "yesterday" }]],
    // Valid-looking but wrong: lenient parsers (JavaScript's Date.parse among them) accept these.
    ["timestamp on a day that does not exist (Feb 30)", [{ ...conversion("u1", "g"), timestamp: "2026-02-30T00:00:00Z" }]],
    ["timestamp Feb 29 in a non-leap year", [{ ...conversion("u1", "g"), timestamp: "2027-02-29T00:00:00Z" }]],
    ["timestamp April 31", [{ ...conversion("u1", "g"), timestamp: "2026-04-31T00:00:00Z" }]],
    ["timestamp month 13", [{ ...conversion("u1", "g"), timestamp: "2026-13-01T00:00:00Z" }]],
    ["timestamp hour 24", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T24:00:00Z" }]],
    ["timestamp minute 60", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T08:60:00Z" }]],
    ["timestamp with a date only", [{ ...conversion("u1", "g"), timestamp: "2026-01-31" }]],
    ["timestamp without a time zone", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T08:00:00" }]],
    ["timestamp in Arabic-Indic digits", [{ ...conversion("u1", "g"), timestamp: "\u0662\u0660\u0662\u0666-\u0660\u0661-\u0663\u0661T\u0660\u0668:\u0660\u0660:\u0660\u0660Z" }]],
    ["timestamp in full-width digits", [{ ...conversion("u1", "g"), timestamp: "\uff12\uff10\uff12\uff16-01-31T08:00:00Z" }]],
    ["timestamp offset without a colon", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T08:00:00+0700" }]],
    // Found by differential testing: Go's time.Parse accepts all four of these, RFC 3339 does not.
    ["timestamp with a one-digit hour", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T8:00:00Z" }]],
    ["timestamp with a comma before the fraction", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T08:00:00,5Z" }]],
    ["timestamp with an offset of +24:00", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T08:00:00+24:00" }]],
    ["timestamp with offset minutes 60", [{ ...conversion("u1", "g"), timestamp: "2026-01-31T08:00:00+07:60" }]],
    ["event is not an object", ["x"]],
  ];
  for (const [name, events] of invalid) {
    test(`${name} -> 400 VALIDATION_ERROR`, async () => assertError(await send(events), 400, "VALIDATION_ERROR"));
  }

  test("body without `events`, or with a non-array, -> 400", async () => {
    assertError(await post("/v1/events", {}, { auth: "client" }), 400, "VALIDATION_ERROR");
    assertError(await post("/v1/events", { events: {} }, { auth: "client" }), 400, "VALIDATION_ERROR");
  });

  test("a batch with one invalid event is rejected as a whole (BR-44)", async () => {
    const f = await abFlag();
    const res = await send([exposure(f.key, "u1", "control"), { type: "exposure", userId: "u2" }]);
    assertError(res, 400, "VALIDATION_ERROR");
    const r = await results(f.key, "g");
    assert.equal(r.body.variants.find((x) => x.variant === "control").exposures, 0);
  });
});

describe("GET /v1/flags/{key}/results", mvp2, () => {
  test("auth and errors (BR-46)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    assertError(await get(`/v1/flags/${f.key}/results?goal=g`, { auth: "none" }), 401, "UNAUTHORIZED");
    assertError(await get(`/v1/flags/${f.key}/results?goal=g`, { auth: "client" }), 403, "FORBIDDEN");
    assertError(await get(`/v1/flags/${f.key}/results`), 400, "VALIDATION_ERROR");
    assertError(await get(`/v1/flags/${f.key}/results?goal=`), 400, "VALIDATION_ERROR");
    assertError(await get(`/v1/flags/${uniqueKey("none")}/results?goal=g`), 404, "FLAG_NOT_FOUND");
  });

  test("a flag without variants has an empty variants list", async () => {
    const goal = uniqueKey("goal");
    const f = await fx.create({ enabled: true });
    const res = await results(f.key, goal);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { flagKey: f.key, goal, variants: [] });
  });

  test("a fresh experiment lists every variant in declared order with zeroes", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    const res = await results(f.key, goal);
    assert.equal(res.status, 200);
    assert.equal(res.body.flagKey, f.key);
    assert.equal(res.body.goal, goal);
    assert.deepEqual(res.body.variants, [
      { variant: "control", exposures: 0, conversions: 0, rate: 0, pValue: null, significant: false },
      { variant: "treatment", exposures: 0, conversions: 0, rate: 0, pValue: null, significant: false },
    ]);
  });

  test("counts exposures and conversions per variant, immediately (BR-45)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    await sendAll([
      exposure(f.key, "u1", "control"), exposure(f.key, "u2", "control"),
      exposure(f.key, "u3", "treatment"), exposure(f.key, "u4", "treatment"),
      conversion("u1", goal), conversion("u3", goal),
    ]);
    const res = await results(f.key, goal);
    const [c, t] = res.body.variants;
    assert.deepEqual([c.variant, c.exposures, c.conversions, c.rate], ["control", 2, 1, 0.5]);
    assert.deepEqual([t.variant, t.exposures, t.conversions, t.rate], ["treatment", 2, 1, 0.5]);
  });

  test("duplicate exposures count once, and the first exposure wins (BR-40)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    await sendAll([
      exposure(f.key, "u1", "control"), exposure(f.key, "u1", "control"),
      exposure(f.key, "u2", "control"), exposure(f.key, "u2", "treatment"),
    ]);
    const [c, t] = (await results(f.key, goal)).body.variants;
    assert.equal(c.exposures, 2);
    assert.equal(t.exposures, 0);
  });

  test("repeated conversions of one user count once (BR-41)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    await sendAll([exposure(f.key, "u1", "control"), conversion("u1", goal), conversion("u1", goal), conversion("u1", goal)]);
    const [c] = (await results(f.key, goal)).body.variants;
    assert.equal(c.conversions, 1);
    assert.equal(c.rate, 1);
  });

  test("a conversion without a prior exposure is accepted but not counted (BR-41)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    await sendAll([exposure(f.key, "u1", "control"), conversion("stranger", goal)]);
    const [c, t] = (await results(f.key, goal)).body.variants;
    assert.equal(c.conversions + t.conversions, 0);
  });

  test("a conversion sent before the exposure still counts once the user is exposed (BR-41)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    await sendAll([conversion("u1", goal), exposure(f.key, "u1", "treatment")]);
    const [, t] = (await results(f.key, goal)).body.variants;
    assert.equal(t.conversions, 1);
  });

  test("goals are independent", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    await sendAll([exposure(f.key, "u1", "control"), exposure(f.key, "u2", "control"), conversion("u1", goal), conversion("u2", `${goal}-signup`)]);
    assert.equal((await results(f.key, goal)).body.variants[0].conversions, 1);
    assert.equal((await results(f.key, `${goal}-signup`)).body.variants[0].conversions, 1);
    assert.equal((await results(f.key, `${goal}-never`)).body.variants[0].conversions, 0);
  });

  test("exposures are per flag", async () => {
    const goal = uniqueKey("goal");
    const a = await abFlag();
    const b = await abFlag();
    await sendAll([exposure(a.key, "u1", "control")]);
    assert.equal((await results(a.key, "g")).body.variants[0].exposures, 1);
    assert.equal((await results(b.key, "g")).body.variants[0].exposures, 0);
  });

  test("small samples never report significance (BR-42)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    const events = [];
    for (let i = 0; i < 29; i++) events.push(exposure(f.key, `c${i}`, "control"), exposure(f.key, `t${i}`, "treatment"));
    for (let i = 0; i < 29; i++) events.push(conversion(`t${i}`, goal)); // 100% vs 0%, but only 29 each
    await sendAll(events);
    for (const row of (await results(f.key, goal)).body.variants) {
      assert.equal(row.pValue, null, row.variant);
      assert.equal(row.significant, false, row.variant);
    }
  });

  test("the minimum sample is exactly 30 exposures per variant (BR-42)", async () => {
    // Found by differential testing: a boundary of 31 passed every other test.
    const run = async (nControl, nTreatment) => {
      const goal = uniqueKey("goal");
      const f = await abFlag();
      await sendAll([
        ...Array.from({ length: nControl }, (_, i) => exposure(f.key, `c${i}`, "control")),
        ...Array.from({ length: nTreatment }, (_, i) => exposure(f.key, `t${i}`, "treatment")),
        ...Array.from({ length: 3 }, (_, i) => conversion(`c${i}`, goal)),
        ...Array.from({ length: 15 }, (_, i) => conversion(`t${i}`, goal)),
      ]);
      return (await results(f.key, goal)).body.variants[1];
    };
    const atLimit = await run(30, 30); // 3/30 vs 15/30: z = 3.3806, p = 0.00072323
    assert.ok(atLimit.pValue !== null, "30 exposures in each variant is enough");
    assert.ok(Math.abs(atLimit.pValue - 0.0007232327) < 1e-4, `pValue ${atLimit.pValue}`);
    assert.equal(atLimit.significant, true);
    assert.equal((await run(30, 29)).pValue, null, "29 in the treatment is too few");
    assert.equal((await run(29, 30)).pValue, null, "29 in the control is too few");
  });

  test("two-proportion z-test: 20/200 vs 40/200 (BR-42)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    const events = [];
    for (let i = 0; i < 200; i++) events.push(exposure(f.key, `c${i}`, "control"), exposure(f.key, `t${i}`, "treatment"));
    for (let i = 0; i < 20; i++) events.push(conversion(`c${i}`, goal));
    for (let i = 0; i < 40; i++) events.push(conversion(`t${i}`, goal));
    await sendAll(events);

    const [c, t] = (await results(f.key, goal)).body.variants;
    assert.equal(c.exposures, 200);
    assert.equal(c.conversions, 20);
    assert.ok(Math.abs(c.rate - 0.1) < 1e-9);
    assert.equal(c.pValue, null, "control has nothing to compare with");
    assert.equal(c.significant, false);

    assert.equal(t.conversions, 40);
    assert.ok(Math.abs(t.rate - 0.2) < 1e-9);
    // pooled p = 0.15, se = 0.035707, z = 2.80056, pValue = erfc(z / sqrt 2) = 0.0051014
    assert.ok(Math.abs(t.pValue - 0.0051014) < 1e-4, `pValue ${t.pValue}`);
    assert.equal(t.significant, true);
  });

  test("identical rates are not significant", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    const events = [];
    for (let i = 0; i < 100; i++) events.push(exposure(f.key, `c${i}`, "control"), exposure(f.key, `t${i}`, "treatment"));
    for (let i = 0; i < 30; i++) events.push(conversion(`c${i}`, goal), conversion(`t${i}`, goal));
    await sendAll(events);
    const [, t] = (await results(f.key, goal)).body.variants;
    assert.ok(Math.abs(t.pValue - 1) < 1e-6, `pValue ${t.pValue}`);
    assert.equal(t.significant, false);
  });

  test("a rate of 0 or 1 in both groups gives no p-value instead of NaN (BR-42, se = 0)", async () => {
    const goal = uniqueKey("goal");
    const f = await abFlag();
    const events = [];
    for (let i = 0; i < 40; i++) events.push(exposure(f.key, `c${i}`, "control"), exposure(f.key, `t${i}`, "treatment"));
    await sendAll(events); // nobody converts
    const [, t] = (await results(f.key, goal)).body.variants;
    assert.equal(t.pValue, null);
    assert.equal(t.significant, false);
  });
});
