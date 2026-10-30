// CORS for the browser SDK (BR-56). The tests read the same CORS_ORIGINS variable the service is started with:
//   unset or empty   -> CORS is off: nothing changes (OPTIONS stays 404, no CORS headers)
//   "*"              -> every origin is allowed
//   "a,b,..."        -> exactly these origins; every one of them is tested (give two to cover the list parsing)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { call, get, post, assertError } from "./lib.mjs";

const setting = (process.env.CORS_ORIGINS ?? "").trim();
const mode = setting === "" ? "off" : setting === "*" ? "star" : "list";
const listed = setting.split(",").map((o) => o.trim()).filter((o) => o !== "");
const allowedList = mode === "list" ? listed.filter((o) => o !== "*") : [];
const allowed = allowedList[0] ?? "https://app.example.com";
const stranger = "https://evil.example.org";

const withOrigin = (origin, extra = {}) => ({ headers: { origin }, ...extra });
const header = (res, name) => res.headers.get(name);
const hasNoCors = (res, label) => {
  for (const name of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials"]) {
    assert.equal(header(res, name), null, `${label}: ${name}`);
  }
};
const preflight = (path, origin = allowed) =>
  call("OPTIONS", path, { auth: "none", headers: { ...(origin === null ? {} : { origin }), "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-client-key" } });

describe("CORS preflight (BR-56)", { skip: mode === "off" ? "CORS_ORIGINS is not set" : false }, () => {
  for (const path of ["/v1/evaluate", "/v1/events"]) {
    test(`OPTIONS ${path} from an allowed origin: 204, no body, no key needed`, async () => {
      const res = await preflight(path);
      assert.equal(res.status, 204, res.text);
      assert.equal(res.text, "");
      assert.equal(header(res, "access-control-allow-origin"), mode === "star" ? "*" : allowed);
      assert.match(header(res, "access-control-allow-methods") ?? "", /^POST$/i);
      const headers = (header(res, "access-control-allow-headers") ?? "").toLowerCase().split(",").map((s) => s.trim());
      assert.ok(headers.includes("content-type") && headers.includes("x-client-key"), headers.join());
      assert.ok(!headers.includes("x-admin-key"), "the admin key must not be usable from a browser");
      assert.equal(header(res, "access-control-max-age"), "600");
      assert.equal(header(res, "access-control-allow-credentials"), null);
      if (mode === "list") assert.match(header(res, "vary") ?? "", /origin/i);
    });
  }

  test("OPTIONS with no Origin is not a CORS request: 404 as for any unknown route (BR-53)", async () => {
    for (const path of ["/v1/evaluate", "/v1/events"]) assertError(await preflight(path, null), 404, "FLAG_NOT_FOUND");
  });

  test("OPTIONS on any other path is 404, even from an allowed origin: the admin API has no CORS", async () => {
    for (const path of ["/v1/flags", "/v1/flags/some-flag", "/v1/flags/some-flag/results", "/v1/audit-logs", "/healthz", "/nope"]) {
      const res = await preflight(path);
      assertError(res, 404, "FLAG_NOT_FOUND");
      hasNoCors(res, path);
    }
  });
});

describe("every listed origin is allowed, not just the first (BR-56)", { skip: allowedList.length < 2 ? "needs two origins in CORS_ORIGINS" : false }, () => {
  test("each listed origin gets its own value back, on a preflight and on a POST", async () => {
    for (const origin of allowedList) {
      for (const path of ["/v1/evaluate", "/v1/events"]) {
        const pre = await preflight(path, origin);
        assert.equal(pre.status, 204, `${origin} ${path}`);
        assert.equal(header(pre, "access-control-allow-origin"), origin);
      }
      const res = await post("/v1/evaluate", { flags: [] }, { auth: "client", ...withOrigin(origin) });
      assert.equal(header(res, "access-control-allow-origin"), origin);
      assert.match(header(res, "vary") ?? "", /origin/i);
    }
  });
});

describe("CORS preflight for an origin that is not allowed (BR-56)", { skip: mode !== "list" ? "needs a CORS_ORIGINS list" : false }, () => {
  test("404 with no CORS headers", async () => {
    for (const origin of [stranger, "null", `${allowed}/`, allowed.replace("https://", "http://"), allowed.toUpperCase(), `${allowed}.evil.org`]) {
      for (const path of ["/v1/evaluate", "/v1/events"]) {
        const res = await preflight(path, origin);
        assertError(res, 404, "FLAG_NOT_FOUND");
        hasNoCors(res, `${origin} ${path}`);
      }
    }
  });
});

describe("CORS headers on the real responses (BR-56)", { skip: mode === "off" ? "CORS_ORIGINS is not set" : false }, () => {
  const expected = mode === "star" ? "*" : allowed;
  const evaluate = (body, opts = {}) => post("/v1/evaluate", body, { auth: "client", ...withOrigin(allowed), ...opts });
  const event = { type: "conversion", userId: "cors-user", goal: "cors-goal" };

  test("POST /v1/evaluate: 200, 400 and 401 all carry Access-Control-Allow-Origin", async () => {
    for (const [res, status] of [
      [await evaluate({ flags: [] }), 200],
      [await evaluate([]), 400],
      [await evaluate({}, { auth: "none" }), 401],
      [await evaluate({}, { auth: "bad-client" }), 401],
    ]) {
      assert.equal(res.status, status, res.text);
      assert.equal(header(res, "access-control-allow-origin"), expected, `status ${status}`);
      assert.equal(header(res, "access-control-allow-credentials"), null);
      if (mode === "list") assert.match(header(res, "vary") ?? "", /origin/i, `status ${status}`);
    }
  });

  test("POST /v1/events: 202, 400 and 401 all carry Access-Control-Allow-Origin", async () => {
    for (const [res, status] of [
      [await post("/v1/events", { events: [event] }, { auth: "client", ...withOrigin(allowed) }), 202],
      [await post("/v1/events", { events: [] }, { auth: "client", ...withOrigin(allowed) }), 400],
      [await post("/v1/events", { events: [event] }, { auth: "none", ...withOrigin(allowed) }), 401],
    ]) {
      assert.equal(res.status, status, res.text);
      assert.equal(header(res, "access-control-allow-origin"), expected, `status ${status}`);
    }
  });

  test("a request with no Origin, or an empty one, gets no CORS headers", async () => {
    hasNoCors(await post("/v1/evaluate", { flags: [] }, { auth: "client" }), "evaluate");
    hasNoCors(await post("/v1/evaluate", { flags: [] }, { auth: "client", ...withOrigin("") }), "empty Origin");
  });

  test("a query string does not change the path; a trailing slash does (404 without CORS)", async () => {
    const withQuery = await post("/v1/evaluate?x=1", { flags: [] }, { auth: "client", ...withOrigin(allowed) });
    assert.equal(withQuery.status, 200);
    assert.equal(header(withQuery, "access-control-allow-origin"), expected);
    const pre = await preflight("/v1/events?x=1");
    assert.equal(pre.status, 204);
    const slash = await post("/v1/evaluate/", { flags: [] }, { auth: "client", ...withOrigin(allowed) });
    assertError(slash, 404, "FLAG_NOT_FOUND");
    hasNoCors(slash, "trailing slash");
  });

  test("methods other than POST and OPTIONS on a client path are 404 without CORS", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await call(method, "/v1/evaluate", { auth: "client", ...withOrigin(allowed) });
      assertError(res, 404, "FLAG_NOT_FOUND");
      hasNoCors(res, method);
    }
  });

  test("the admin API, /healthz and unknown routes get no CORS headers, whatever the Origin", async () => {
    hasNoCors(await get("/v1/flags", withOrigin(allowed)), "GET /v1/flags");
    hasNoCors(await get("/healthz", withOrigin(allowed)), "/healthz");
    hasNoCors(await get("/v1/evaluate", withOrigin(allowed)), "GET /v1/evaluate (no such route)");
    hasNoCors(await get("/nope", withOrigin(allowed)), "/nope");
  });
});

describe("responses for an origin that is not allowed (BR-56)", { skip: mode !== "list" ? "needs a CORS_ORIGINS list" : false }, () => {
  test("the request is served as usual, without CORS headers (the browser, not the service, refuses it)", async () => {
    const res = await post("/v1/evaluate", { flags: [] }, { auth: "client", ...withOrigin(stranger) });
    assert.equal(res.status, 200);
    hasNoCors(res, "evaluate");
    hasNoCors(await post("/v1/events", { events: [{ type: "conversion", userId: "u", goal: "g" }] }, { auth: "client", ...withOrigin(stranger) }), "events");
  });
});

describe("star mode with an origin that nobody listed (BR-56)", { skip: mode !== "star" ? "needs CORS_ORIGINS=*" : false }, () => {
  test("every origin gets *, with no Vary", async () => {
    const pre = await preflight("/v1/evaluate", stranger);
    assert.equal(pre.status, 204);
    assert.equal(header(pre, "access-control-allow-origin"), "*");
    assert.equal(header(pre, "vary"), null);
    const res = await post("/v1/evaluate", { flags: [] }, { auth: "client", ...withOrigin(stranger) });
    assert.equal(header(res, "access-control-allow-origin"), "*");
  });
});

describe("CORS is off by default (BR-56)", { skip: mode !== "off" ? "CORS_ORIGINS is set" : false }, () => {
  test("OPTIONS stays 404 and no CORS header is ever sent", async () => {
    for (const path of ["/v1/evaluate", "/v1/events"]) {
      const res = await preflight(path);
      assertError(res, 404, "FLAG_NOT_FOUND");
      hasNoCors(res, path);
    }
    hasNoCors(await post("/v1/evaluate", { flags: [] }, { auth: "client", ...withOrigin(allowed) }), "evaluate");
  });
});
