import assert from "node:assert/strict";
import { describe, test, mock, afterEach } from "node:test";
import { FlagClient } from "../dist/index.js";
import { BASE, RFC3339, evaluated, fakeFetch, json, memoryStorage, off, on, settle, variant } from "./helpers.mjs";

const options = (fetch, extra = {}) => ({ baseUrl: BASE, clientKey: "ck", user: { id: "u1", attributes: { country: "TH" } }, fetch, storage: null, pollIntervalMs: 0, ...extra });

// A service that knows two flags, and accepts every event.
const service = (results = { checkout: on, button: variant("blue"), legacy: off }) =>
  fakeFetch((path) => (path === "/v1/evaluate" ? evaluated(results) : json({ accepted: 1 }, 202)));

afterEach(() => mock.timers.reset());

describe("reading values", () => {
  test("asks the service for every flag with this user's context and the client key", async () => {
    const fetch = service();
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    assert.equal(fetch.calls.length, 1);
    const [call] = fetch.calls;
    assert.equal(call.url, `${BASE}/v1/evaluate`);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["X-Client-Key"], "ck");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.deepEqual(call.body, { context: { userId: "u1", attributes: { country: "TH" } } }); // no `flags`: evaluate everything
    ff.close();
  });

  test("isEnabled and getVariant return what the service said", async () => {
    const ff = new FlagClient(options(service()));
    await ff.ready();
    assert.equal(ff.isEnabled("checkout"), true);
    assert.equal(ff.isEnabled("legacy", true), false, "a flag the service says is off is off, whatever the fallback");
    assert.equal(ff.getVariant("button", "red"), "blue");
    ff.close();
  });

  test("a flag the service does not know, or that has no variant, gives the fallback", async () => {
    const ff = new FlagClient(options(service()));
    await ff.ready();
    assert.equal(ff.isEnabled("ghost"), false);
    assert.equal(ff.isEnabled("ghost", true), true);
    assert.equal(ff.getVariant("ghost", "red"), "red");
    assert.equal(ff.getVariant("checkout", "red"), "red", "on, but no variant");
    assert.equal(ff.getVariant("legacy", "red"), "red", "off");
    ff.close();
  });

  test("before the first answer there is nothing: the fallback is used", () => {
    const ff = new FlagClient(options(fakeFetch(() => new Promise(() => undefined))));
    assert.equal(ff.isEnabled("checkout", true), true);
    assert.equal(ff.getVariant("button", "red"), "red");
    ff.close();
  });

  test("a trailing slash in baseUrl is not doubled", async () => {
    const fetch = service();
    await new FlagClient(options(fetch, { baseUrl: `${BASE}//` })).ready();
    assert.equal(fetch.calls[0].url, `${BASE}/v1/evaluate`);
  });

  test("attributes that are not scalars are left out instead of making the service answer 400", async () => {
    const fetch = service();
    const user = { id: "u1", attributes: { ok: "yes", n: 1, b: false, nan: Number.NaN, inf: Infinity, o: {}, a: [1], u: undefined, nul: null } };
    await new FlagClient(options(fetch, { user })).ready();
    assert.deepEqual(fetch.calls[0].body.context.attributes, { ok: "yes", n: 1, b: false });
  });

  test("a flag called __proto__ is just a flag", async () => {
    const fetch = fakeFetch(() => new Response('{"results":{"__proto__":{"enabled":true,"variant":"x","reason":"VARIANT"},"toString":{"enabled":true,"variant":null,"reason":"ON"}}}'));
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    assert.equal(ff.isEnabled("__proto__"), true);
    assert.equal(ff.getVariant("__proto__", "d"), "x");
    assert.equal(ff.isEnabled("toString"), true);
    assert.equal(ff.isEnabled("constructor"), false);
    ff.close();
  });
});

describe("a user without an id", () => {
  test("is evaluated without userId, and no event is ever sent for them", async () => {
    const fetch = service({ checkout: on, button: variant("blue") });
    const ff = new FlagClient(options(fetch, { user: { attributes: { a: 1 } } }));
    await ff.ready();
    assert.deepEqual(fetch.calls[0].body, { context: { attributes: { a: 1 } } });
    assert.equal(ff.getVariant("button", "red"), "blue");
    ff.track("purchase");
    await ff.flush();
    assert.equal(fetch.to("/v1/events").length, 0);
    ff.close();
  });

  test("an empty id and a missing user are the same thing", async () => {
    for (const user of [{ id: "" }, {}, undefined]) {
      const fetch = service();
      const ff = new FlagClient(options(fetch, { user }));
      await ff.ready();
      assert.deepEqual(fetch.calls[0].body, { context: {} });
      ff.close();
    }
  });
});

describe("when the service cannot be used", () => {
  const broken = {
    "network error": () => {
      throw new TypeError("fetch failed");
    },
    "rejected promise": () => Promise.reject(new Error("boom")),
    "500": () => json({ error: { code: "INTERNAL_ERROR", message: "x" } }, 500),
    "401": () => json({ error: { code: "UNAUTHORIZED", message: "x" } }, 401),
    "html": () => new Response("<html>bad gateway</html>", { status: 502 }),
    "200 but not JSON": () => new Response("{not json", { status: 200 }),
    "200 but empty": () => new Response("", { status: 200 }),
    "200 with the wrong shape": () => json({ nope: true }),
    "results is an array": () => json({ results: [] }),
    "results is null": () => json({ results: null }),
    "body is null": () => json(null),
    "not even a Response": () => ({ status: 200, json: () => Promise.reject(new Error("no")) }),
    "undefined": () => undefined,
    "an answer with results, but a 500": () => json({ results: { checkout: on } }, 500),
    "an answer with results, but a 401": () => json({ results: { checkout: on } }, 401),
  };
  for (const [name, handler] of Object.entries(broken)) {
    test(`${name}: ready() resolves and every call gives the fallback`, async () => {
      const ff = new FlagClient(options(fakeFetch(handler)));
      await ff.ready();
      assert.equal(ff.isEnabled("checkout", true), true);
      assert.equal(ff.isEnabled("checkout"), false);
      assert.equal(ff.getVariant("button", "red"), "red");
      assert.doesNotThrow(() => ff.track("purchase"));
      await ff.flush();
      ff.close();
    });
  }

  test("entries that do not fit the schema are skipped, the others still count", async () => {
    const results = { good: on, noEnabled: { variant: null, reason: "ON" }, wrongEnabled: { enabled: "true", variant: null, reason: "ON" }, wrongVariant: { enabled: true, variant: 5, reason: "VARIANT" }, nul: null, str: "x" };
    const ff = new FlagClient(options(service(results)));
    await ff.ready();
    assert.equal(ff.isEnabled("good"), true);
    for (const key of ["noEnabled", "wrongEnabled", "wrongVariant", "nul", "str"]) assert.equal(ff.isEnabled(key, "fallback"), "fallback", key);
    ff.close();
  });

  test("a request that never answers is given up after timeoutMs, and the request is aborted", async () => {
    const fetch = fakeFetch((_path, _body, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const ff = new FlagClient(options(fetch, { timeoutMs: 20 }));
    await ff.ready();
    assert.equal(fetch.calls[0].signal.aborted, true);
    assert.equal(ff.isEnabled("checkout", true), true);
    ff.close();
  });

  test("constructing with a configuration that cannot work is the only thing that throws", () => {
    assert.throws(() => new FlagClient({ clientKey: "ck" }), TypeError);
    assert.throws(() => new FlagClient({ baseUrl: BASE }), TypeError);
    assert.throws(() => new FlagClient({ baseUrl: "", clientKey: "ck" }), TypeError);
    assert.throws(() => new FlagClient({ baseUrl: BASE, clientKey: "" }), TypeError);
    assert.throws(() => new FlagClient(undefined), TypeError);
    assert.throws(() => new FlagClient(null), TypeError);
  });

  test("the public methods do not throw whatever they are given", async () => {
    const ff = new FlagClient(options(service()));
    await ff.ready();
    for (const bad of [undefined, null, 0, 1, true, {}, [], Symbol("s"), () => 1, "", "x".repeat(100_000)]) {
      assert.doesNotThrow(() => ff.isEnabled(bad));
      assert.doesNotThrow(() => ff.isEnabled(bad, bad));
      assert.doesNotThrow(() => ff.getVariant(bad, bad));
      assert.doesNotThrow(() => ff.track(bad));
      assert.doesNotThrow(() => ff.onChange(bad));
    }
    ff.close();
    assert.doesNotThrow(() => ff.close());
    assert.equal(ff.isEnabled("checkout"), true, "still readable after close");
  });
});

describe("cache", () => {
  test("a successful answer is stored, and used when the next page load cannot reach the service", async () => {
    const storage = memoryStorage();
    const first = new FlagClient(options(service(), { storage }));
    await first.ready();
    first.close();
    assert.equal(storage.data.size, 1);

    const down = fakeFetch(() => {
      throw new TypeError("offline");
    });
    const second = new FlagClient(options(down, { storage }));
    assert.equal(second.isEnabled("checkout"), true, "known at once, before ready()");
    assert.equal(second.getVariant("button", "red"), "blue");
    await second.ready();
    assert.equal(second.isEnabled("checkout"), true, "and still after the failed request");
    second.close();
  });

  test("another user, or other attributes, or another service, do not share a cache entry", async () => {
    const storage = memoryStorage();
    await new FlagClient(options(service(), { storage })).ready();
    const down = () => {
      throw new TypeError("offline");
    };
    for (const [user, baseUrl] of [[{ id: "u2", attributes: { country: "TH" } }, BASE], [{ id: "u1", attributes: { country: "SG" } }, BASE], [{ id: "u1", attributes: { country: "TH" } }, "https://other.example.com"]]) {
      const ff = new FlagClient(options(fakeFetch(down), { storage, user, baseUrl }));
      assert.equal(ff.isEnabled("checkout", "nothing"), "nothing");
      ff.close();
    }
  });

  test("a corrupt or foreign cache entry is ignored", async () => {
    for (const stored of ["{not json", "null", '{"results":[]}', '{"results":{"checkout":{"enabled":"yes"}}}', "42"]) {
      const probe = memoryStorage();
      await new FlagClient(options(service(), { storage: probe })).ready();
      const [key] = [...probe.data.keys()];
      const ff = new FlagClient(options(fakeFetch(() => json(null)), { storage: memoryStorage({ [key]: stored }) }));
      await ff.ready();
      assert.equal(ff.isEnabled("checkout", "nothing"), "nothing", stored);
      ff.close();
    }
  });

  test("storage that throws never gets in the way", async () => {
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("x");
      },
    };
    const ff = new FlagClient(options(service(), { storage: hostile }));
    await ff.ready();
    assert.equal(ff.isEnabled("checkout"), true);
    ff.close();
  });

  test("a localStorage that throws when it is merely looked at is survived", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: blocked");
      },
    });
    try {
      const ff = new FlagClient({ baseUrl: BASE, clientKey: "ck", user: { id: "u1" }, fetch: service(), pollIntervalMs: 0 });
      await ff.ready();
      assert.equal(ff.isEnabled("checkout"), true);
      ff.close();
    } finally {
      delete globalThis.localStorage;
    }
  });

  test("with no storage option it uses localStorage when there is one", async () => {
    const storage = memoryStorage();
    globalThis.localStorage = storage;
    try {
      const ff = new FlagClient({ baseUrl: BASE, clientKey: "ck", user: { id: "u1" }, fetch: service(), pollIntervalMs: 0 });
      await ff.ready();
      ff.close();
      assert.equal(storage.data.size, 1);
    } finally {
      delete globalThis.localStorage;
    }
  });
});

describe("events", () => {
  const eventsOf = (fetch) => fetch.to("/v1/events").flatMap((c) => c.body.events);

  test("the first read of a variant is an exposure, once per flag, however often it is read", async () => {
    const fetch = service({ button: variant("blue"), banner: variant("a"), checkout: on, viewed: variant("v") });
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    for (let i = 0; i < 50; i++) ff.getVariant("button", "red");
    ff.getVariant("banner", "x");
    ff.getVariant("checkout", "x"); // no variant: nothing to expose
    ff.getVariant("ghost", "x");
    ff.isEnabled("button"); // isEnabled does not expose
    ff.isEnabled("viewed"); // ... not even a flag that has a variant, and has only been asked whether it is on
    await ff.flush();
    const events = eventsOf(fetch);
    assert.deepEqual(events.map(({ type, userId, flagKey, variant: v }) => [type, userId, flagKey, v]), [["exposure", "u1", "button", "blue"], ["exposure", "u1", "banner", "a"]]);
    ff.close();
  });

  test("an event answer that is not JSON still counts as sent: nothing is sent twice", async () => {
    const fetch = fakeFetch((path) => (path === "/v1/evaluate" ? evaluated({}) : new Response("", { status: 202 })));
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    ff.track("once");
    await ff.flush();
    await ff.flush();
    assert.equal(fetch.to("/v1/events").length, 1);
    ff.close();
  });

  test("track sends a conversion; events carry an RFC 3339 timestamp and go with the client key", async () => {
    const fetch = service();
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    ff.track("purchase");
    ff.track("signup");
    await ff.flush();
    const [call] = fetch.to("/v1/events");
    assert.equal(call.headers["X-Client-Key"], "ck");
    assert.deepEqual(call.body.events.map((e) => [e.type, e.userId, e.goal]), [["conversion", "u1", "purchase"], ["conversion", "u1", "signup"]]);
    for (const e of call.body.events) assert.match(e.timestamp, RFC3339);
    ff.close();
  });

  test("events are sent by themselves after flushIntervalMs, together", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const fetch = service();
    const ff = new FlagClient(options(fetch, { flushIntervalMs: 2000 }));
    await ff.ready();
    ff.track("a");
    ff.track("b");
    mock.timers.tick(1999);
    await settle();
    assert.equal(fetch.to("/v1/events").length, 0);
    mock.timers.tick(1);
    await settle();
    assert.equal(fetch.to("/v1/events").length, 1);
    assert.equal(fetch.to("/v1/events")[0].body.events.length, 2);
    ff.close();
  });

  test("the 100th queued event sends the batch at once, without waiting for the timer", async () => {
    const fetch = service();
    const ff = new FlagClient(options(fetch, { flushIntervalMs: 3_600_000 }));
    await ff.ready();
    for (let i = 0; i < 99; i++) ff.track(`g${i}`);
    await settle();
    assert.equal(fetch.to("/v1/events").length, 0, "99 wait");
    ff.track("g99");
    await settle();
    assert.equal(fetch.to("/v1/events").length, 1);
    assert.equal(fetch.to("/v1/events")[0].body.events.length, 100);
    ff.close();
  });

  test("a goal that is empty or not a string is not an event (the service would refuse the whole batch)", async () => {
    const fetch = service();
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    for (const bad of ["", undefined, null, 5, {}, []]) ff.track(bad);
    await ff.flush();
    assert.equal(fetch.to("/v1/events").length, 0);
    ff.close();
  });

  test("no request holds more than 100 events, and nothing is lost", async () => {
    const results = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`flag-${i}`, variant("a")]));
    const fetch = service(results);
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    for (let i = 0; i < 250; i++) ff.getVariant(`flag-${i}`, "x");
    for (let i = 0; i < 130; i++) ff.track(`goal-${i}`);
    await ff.flush();
    await settle();
    const calls = fetch.to("/v1/events");
    assert.ok(calls.every((c) => c.body.events.length >= 1 && c.body.events.length <= 100), calls.map((c) => c.body.events.length).join(","));
    assert.equal(eventsOf(fetch).length, 380);
    assert.equal(new Set(eventsOf(fetch).map((e) => e.flagKey ?? e.goal)).size, 380);
    ff.close();
  });

  test("a batch the service could not take is tried again; one it refuses is dropped", async () => {
    let status = 500;
    const fetch = fakeFetch((path) => (path === "/v1/evaluate" ? evaluated({}) : json({ accepted: 1 }, status)));
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    ff.track("a");
    await ff.flush();
    assert.equal(fetch.to("/v1/events").length, 1);
    status = 202;
    await ff.flush();
    assert.equal(fetch.to("/v1/events").length, 2, "the 500 left it queued");
    assert.deepEqual(fetch.to("/v1/events")[1].body.events.map((e) => e.goal), ["a"]);
    await ff.flush();
    assert.equal(fetch.to("/v1/events").length, 2, "and the 202 emptied the queue");

    status = 400;
    ff.track("b");
    await ff.flush();
    status = 202;
    await ff.flush();
    assert.equal(fetch.to("/v1/events").length, 3, "a 400 will not get better by trying again");
    ff.close();
  });

  test("after a failure the events are tried again by themselves, after flushIntervalMs", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let up = false;
    const fetch = fakeFetch((path) => {
      if (path === "/v1/evaluate") return evaluated({});
      if (!up) throw new TypeError("offline");
      return json({ accepted: 1 }, 202);
    });
    const ff = new FlagClient(options(fetch, { flushIntervalMs: 2000 }));
    await ff.ready();
    ff.track("a");
    mock.timers.tick(2000);
    await settle();
    assert.equal(fetch.to("/v1/events").length, 1, "tried and failed");
    up = true;
    mock.timers.tick(1999);
    await settle();
    assert.equal(fetch.to("/v1/events").length, 1);
    mock.timers.tick(1);
    await settle();
    assert.equal(fetch.to("/v1/events").length, 2, "tried again with nobody asking");
    ff.close();
  });

  test("a network failure keeps the events for the next flush", async () => {
    let up = false;
    const fetch = fakeFetch((path) => {
      if (path === "/v1/evaluate") return evaluated({});
      if (!up) throw new TypeError("offline");
      return json({ accepted: 1 }, 202);
    });
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    ff.track("a");
    await ff.flush();
    up = true;
    await ff.flush();
    assert.deepEqual(fetch.to("/v1/events").at(-1).body.events.map((e) => e.goal), ["a"]);
    ff.close();
  });

  test("while the service is down the queue is capped at 1000, and the newest events are the ones kept", async () => {
    let up = false;
    const sent = [];
    const fetch = fakeFetch((path, body) => {
      if (path === "/v1/evaluate") return evaluated({});
      if (!up) throw new TypeError("offline");
      sent.push(...body.events.map((e) => e.goal));
      return json({ accepted: body.events.length }, 202);
    });
    const ff = new FlagClient(options(fetch, { flushIntervalMs: 3_600_000 }));
    await ff.ready();
    for (let i = 0; i < 1500; i++) ff.track(`g${i}`);
    await ff.flush(); // fails: nothing is lost by that
    up = true;
    await ff.flush();
    assert.equal(sent.length, 1000);
    assert.deepEqual(sent, Array.from({ length: 1000 }, (_, i) => `g${i + 500}`));
    ff.close();
  });

  test("close() sends what is queued", async () => {
    const fetch = service();
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    ff.track("bye");
    ff.close();
    await settle();
    assert.deepEqual(eventsOf(fetch).map((e) => e.goal), ["bye"]);
  });

  test("two flushes at once do not send twice", async () => {
    const fetch = service();
    const ff = new FlagClient(options(fetch));
    await ff.ready();
    ff.track("once");
    await Promise.all([ff.flush(), ff.flush(), ff.flush()]);
    assert.equal(eventsOf(fetch).length, 1);
    ff.close();
  });
});

describe("polling", () => {
  test("asks again every pollIntervalMs, one request at a time, and tells onChange only when something changed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let answer = { checkout: off };
    const fetch = fakeFetch(() => evaluated(answer));
    const ff = new FlagClient(options(fetch, { pollIntervalMs: 30_000 }));
    const seen = [];
    ff.onChange(() => seen.push(ff.isEnabled("checkout")));
    await ff.ready();
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(seen, [false], "the first answer differs from the empty start: one change");

    mock.timers.tick(29_999);
    await settle();
    assert.equal(fetch.calls.length, 1);
    mock.timers.tick(1);
    await settle();
    assert.equal(fetch.calls.length, 2);
    assert.equal(seen.length, 1, "same answer: no change");

    answer = { checkout: on };
    mock.timers.tick(30_000);
    await settle();
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(seen, [false, true]);
    assert.equal(ff.isEnabled("checkout"), true);
    ff.close();
  });

  test("a poll is not started while the last one has not been answered", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    const fetch = fakeFetch((_path, _body, _init, n) => (n === 1 ? evaluated({ a: on }) : slow));
    const ff = new FlagClient(options(fetch, { pollIntervalMs: 1000, timeoutMs: 3_600_000 }));
    await ff.ready();
    mock.timers.tick(1000);
    await settle();
    assert.equal(fetch.calls.length, 2);
    mock.timers.tick(10_000);
    await settle();
    assert.equal(fetch.calls.length, 2, "still waiting for the second answer");
    release(evaluated({ a: off }));
    await settle();
    mock.timers.tick(1000);
    await settle();
    assert.equal(fetch.calls.length, 3, "and now it asks again");
    ff.close();
  });

  test("an answer that is not a result set does not wipe what is known", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let answer = () => evaluated({ checkout: on });
    const fetch = fakeFetch(() => answer());
    const ff = new FlagClient(options(fetch, { pollIntervalMs: 1000 }));
    await ff.ready();
    const bad = [() => json({ results: [] }), () => json({ results: null }), () => json({}), () => new Response("oops", { status: 200 }), () => json({ results: { checkout: off } }, 503)];
    for (const [i, make] of bad.entries()) {
      answer = make;
      mock.timers.tick(1000);
      await settle();
      assert.equal(ff.isEnabled("checkout"), true, `bad answer ${i}`);
    }
    assert.equal(fetch.calls.length, 1 + bad.length);
    ff.close();
  });

  test("a failed poll keeps the values it had, and the next poll still happens", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let up = true;
    const fetch = fakeFetch(() => {
      if (!up) throw new TypeError("offline");
      return evaluated({ checkout: on });
    });
    const ff = new FlagClient(options(fetch, { pollIntervalMs: 1000 }));
    await ff.ready();
    up = false;
    mock.timers.tick(1000);
    await settle();
    assert.equal(ff.isEnabled("checkout"), true, "last known value");
    up = true;
    mock.timers.tick(1000);
    await settle();
    assert.equal(fetch.calls.length, 3);
    ff.close();
  });

  test("polling can be switched off, and stops at close()", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const off0 = service();
    const a = new FlagClient(options(off0, { pollIntervalMs: 0 }));
    await a.ready();
    mock.timers.tick(10 ** 9);
    await settle();
    assert.equal(off0.to("/v1/evaluate").length, 1);

    const polled = service();
    const b = new FlagClient(options(polled, { pollIntervalMs: 1000 }));
    await b.ready();
    b.close();
    mock.timers.tick(10 ** 6);
    await settle();
    assert.equal(polled.to("/v1/evaluate").length, 1);
  });

  test("onChange: the returned function unsubscribes, and a listener that throws does not stop the others", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let answer = { a: on };
    const fetch = fakeFetch(() => evaluated(answer));
    const ff = new FlagClient(options(fetch, { pollIntervalMs: 1000 }));
    const calls = [];
    ff.onChange(() => {
      throw new Error("a bug in the page");
    });
    const stop = ff.onChange(() => calls.push("second"));
    await ff.ready();
    assert.deepEqual(calls, ["second"]);
    stop();
    answer = { a: off };
    mock.timers.tick(1000);
    await settle();
    assert.deepEqual(calls, ["second"], "unsubscribed");
    ff.close();
  });
});
