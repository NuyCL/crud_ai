import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { SqliteRepository } from "../repository/sqlite.js";
import { Service } from "../service/service.js";
import { buildApp, MAX_BODY_BYTES } from "./handler.js";

const ADMIN = "test-admin-key";
const CLIENT = "test-client-key";

function newApp(t: TestContext, service?: Service): FastifyInstance {
  const repo = new SqliteRepository(":memory:");
  const app = buildApp(service ?? new Service(repo), { adminKey: ADMIN, clientKey: CLIENT, logError: () => undefined });
  t.after(async () => {
    await app.close();
    repo.close();
  });
  return app;
}

type Auth = "admin" | "client" | "bad" | "none";
const authHeaders = (auth: Auth): Record<string, string> =>
  auth === "admin" ? { "x-admin-key": ADMIN } : auth === "client" ? { "x-client-key": CLIENT } : auth === "bad" ? { "x-admin-key": "wrong", "x-client-key": "wrong" } : {};

interface Reply {
  status: number;
  type: string;
  text: string;
  json: () => unknown;
  errorCode: () => string;
}

/** Sends a request; `contentType` is only set when there is a body. */
async function send(app: FastifyInstance, method: string, url: string, body?: string, auth: Auth = "admin", contentType = "application/json"): Promise<Reply> {
  const headers: Record<string, string> = { ...authHeaders(auth) };
  if (body !== undefined) headers["content-type"] = contentType;
  const res = await app.inject({ method: method as "GET", url, headers, ...(body === undefined ? {} : { payload: body }) });
  return {
    status: res.statusCode,
    type: String(res.headers["content-type"] ?? ""),
    text: res.body,
    json: () => JSON.parse(res.body) as unknown,
    errorCode: () => {
      const parsed = JSON.parse(res.body) as { error?: { code?: string; message?: unknown } };
      assert.equal(typeof parsed.error?.message, "string", `no message in ${res.body}`);
      return parsed.error?.code ?? "";
    },
  };
}

test("buildApp requires both keys", () => {
  const repo = new SqliteRepository(":memory:");
  for (const cfg of [{ adminKey: "", clientKey: "" }, { adminKey: "a", clientKey: "" }, { adminKey: "", clientKey: "c" }]) {
    assert.throws(() => buildApp(new Service(repo), cfg), /required/);
  }
  repo.close();
});

describe("auth", () => {
  test("BR-13: /healthz needs no key", async (t) => {
    const r = await send(newApp(t), "GET", "/healthz", undefined, "none");
    assert.deepEqual([r.status, r.json()], [200, { status: "ok" }]);
  });

  test("BR-10, BR-12: admin endpoints accept only the admin key", async (t) => {
    const app = newApp(t);
    const endpoints = [
      ["GET", "/v1/flags"], ["POST", "/v1/flags"], ["GET", "/v1/flags/x"], ["PUT", "/v1/flags/x"], ["DELETE", "/v1/flags/x"],
      ["GET", "/v1/flags/x/results?goal=g"], ["GET", "/v1/audit-logs"],
    ] as const;
    for (const [method, url] of endpoints) {
      for (const [auth, status, code] of [["none", 401, "UNAUTHORIZED"], ["bad", 401, "UNAUTHORIZED"], ["client", 403, "FORBIDDEN"]] as const) {
        const r = await send(app, method, url, '{"key":"x"}', auth);
        assert.deepEqual([r.status, r.errorCode()], [status, code], `${method} ${url} with ${auth}`);
      }
    }
  });

  test("BR-11: evaluate and events accept either key", async (t) => {
    const app = newApp(t);
    const bodies: Record<string, string> = { "/v1/evaluate": "{}", "/v1/events": '{"events":[{"type":"conversion","userId":"u","goal":"g"}]}' };
    for (const [url, body] of Object.entries(bodies)) {
      for (const auth of ["client", "admin"] as const) assert.equal(Math.floor((await send(app, "POST", url, body, auth)).status / 100), 2, `${url} ${auth}`);
      for (const auth of ["none", "bad"] as const) {
        const r = await send(app, "POST", url, body, auth);
        assert.deepEqual([r.status, r.errorCode()], [401, "UNAUTHORIZED"], `${url} ${auth}`);
      }
    }
  });

  test("BR-51: auth is checked before the body is read", async (t) => {
    const app = newApp(t);
    assert.equal((await send(app, "POST", "/v1/flags", "{not json", "none")).status, 401);
    assert.equal((await send(app, "POST", "/v1/flags", "{not json", "client")).status, 403);
    assert.equal((await send(app, "POST", "/v1/evaluate", "{not json", "bad")).status, 401);
    assert.equal((await send(app, "POST", "/v1/flags", "x".repeat(MAX_BODY_BYTES + 10), "none")).status, 401, "even an oversized body");
  });

  test("the key is compared exactly: prefixes, case and padding do not match", async (t) => {
    const app = newApp(t);
    for (const key of [ADMIN.slice(0, -1), ADMIN + "x", ADMIN.toUpperCase(), ` ${ADMIN}`, ""]) {
      const res = await app.inject({ method: "GET", url: "/v1/flags", headers: { "x-admin-key": key } });
      assert.equal(res.statusCode, 401, JSON.stringify(key));
    }
  });
});

describe("happy path", () => {
  test("status codes and content types", async (t) => {
    const app = newApp(t);
    const r = await send(app, "POST", "/v1/flags", '{"key":"f","enabled":true}');
    assert.equal(r.status, 201);
    assert.match(r.type, /^application\/json/);
    const expected: [string, string, string | undefined, Auth, number][] = [
      ["GET", "/v1/flags/f", undefined, "admin", 200], ["PUT", "/v1/flags/f", '{"key":"f"}', "admin", 200], ["GET", "/v1/flags?limit=5", undefined, "admin", 200],
      ["GET", "/v1/audit-logs?flagKey=f", undefined, "admin", 200], ["POST", "/v1/evaluate", '{"flags":["f"]}', "client", 200],
      ["POST", "/v1/events", '{"events":[{"type":"conversion","userId":"u","goal":"g"}]}', "client", 202], ["GET", "/healthz", undefined, "none", 200],
    ];
    for (const [method, url, body, auth, status] of expected) assert.equal((await send(app, method, url, body, auth)).status, status, `${method} ${url}`);
    const d = await send(app, "DELETE", "/v1/flags/f");
    assert.deepEqual([d.status, d.text], [204, ""]);
  });

  test("evaluate answers with a results object keyed by flag", async (t) => {
    const app = newApp(t);
    await send(app, "POST", "/v1/flags", '{"key":"on","enabled":true}');
    const r = await send(app, "POST", "/v1/evaluate", '{"flags":["on","ghost"],"context":{"userId":"u"}}', "client");
    assert.deepEqual(r.json(), { results: { on: { enabled: true, variant: null, reason: "ON" }, ghost: { enabled: false, variant: null, reason: "FLAG_NOT_FOUND" } } });
  });

  test("names like __proto__ are real keys of the results (BR-21)", async (t) => {
    const app = newApp(t);
    const r = await send(app, "POST", "/v1/evaluate", '{"flags":["__proto__","constructor"]}', "client");
    assert.match(r.text, /"__proto__":\{"enabled":false/);
    assert.deepEqual(Object.keys((r.json() as { results: object }).results), ["__proto__", "constructor"]);
  });

  test("a __proto__ key in the request body is accepted as an attribute (Fastify's default parser would answer 400)", async (t) => {
    const app = newApp(t);
    await send(app, "POST", "/v1/flags", '{"key":"p","enabled":true,"rules":[{"attribute":"__proto__","operator":"eq","value":"x"}]}');
    const hit = await send(app, "POST", "/v1/evaluate", '{"flags":["p"],"context":{"attributes":{"__proto__":"x"}}}', "client");
    assert.equal((hit.json() as { results: { p: { reason: string } } }).results.p.reason, "ON");
    const miss = await send(app, "POST", "/v1/evaluate", '{"flags":["p"],"context":{"attributes":{"a":"x"}}}', "client");
    assert.equal((miss.json() as { results: { p: { reason: string } } }).results.p.reason, "TARGETING_MISS");
  });
});

describe("BR-52: request bodies", () => {
  test("anything that is not exactly one JSON value is a validation error", async (t) => {
    const app = newApp(t);
    const bad: Record<string, string> = {
      empty: "", malformed: "{oops", truncated: '{"key":', "two documents": '{"key":"a"}{"key":"b"}', "trailing garbage": '{"key":"a"} x',
      "trailing comma": '{"key":"a"},', "whitespace only": " \n ", "UTF-8 BOM": '﻿{"key":"a"}',
    };
    for (const [name, body] of Object.entries(bad)) {
      const r = await send(app, "POST", "/v1/flags", body);
      assert.deepEqual([r.status, r.errorCode()], [400, "VALIDATION_ERROR"], name);
    }
    assert.equal((await send(app, "POST", "/v1/flags", '{"key":"ws"}\n  \n')).status, 201, "trailing whitespace is fine");
  });

  test("a request with no body at all is a validation error, not a crash", async (t) => {
    const app = newApp(t);
    const r = await send(app, "POST", "/v1/flags");
    assert.deepEqual([r.status, r.errorCode()], [400, "VALIDATION_ERROR"]);
  });

  test("Content-Type is not consulted", async (t) => {
    const app = newApp(t);
    for (const [i, ct] of ["text/plain", "application/x-www-form-urlencoded", "application/octet-stream", "application/json; charset=utf-16", "weird/type"].entries()) {
      assert.equal((await send(app, "POST", "/v1/flags", `{"key":"ct${i}"}`, "admin", ct)).status, 201, ct);
    }
    const noType = await app.inject({ method: "POST", url: "/v1/flags", headers: authHeaders("admin"), payload: '{"key":"notype"}' });
    assert.equal(noType.statusCode, 201, "no Content-Type at all");
  });

  test("exactly 1 MiB is accepted, one byte more is a 400 (not 413)", async (t) => {
    const app = newApp(t);
    const json = '{"key":"big"}';
    assert.equal((await send(app, "POST", "/v1/flags", json + " ".repeat(MAX_BODY_BYTES - json.length))).status, 201);
    const over = await send(app, "POST", "/v1/flags", '{"key":"bigger"}' + " ".repeat(MAX_BODY_BYTES - '{"key":"bigger"}'.length + 1));
    assert.deepEqual([over.status, over.errorCode()], [400, "VALIDATION_ERROR"]);
    assert.equal((await send(app, "GET", "/v1/flags/bigger")).status, 404, "nothing was created");
  });
});

describe("errors", () => {
  test("every error code maps to its status, in JSON", async (t) => {
    const app = newApp(t);
    await send(app, "POST", "/v1/flags", '{"key":"taken"}');
    const cases: [string, string, string, number, string][] = [
      ["POST", "/v1/flags", '{"key":"taken"}', 409, "FLAG_EXISTS"], ["POST", "/v1/flags", '{"key":"Bad"}', 400, "INVALID_KEY"],
      ["POST", "/v1/flags", '{"key":"v","variants":[{"key":"a","weight":100}]}', 400, "INVALID_VARIANTS"], ["PUT", "/v1/flags/taken", '{"key":"other"}', 400, "KEY_IMMUTABLE"],
      ["GET", "/v1/flags/ghost", "", 404, "FLAG_NOT_FOUND"], ["GET", "/v1/flags?limit=0", "", 400, "VALIDATION_ERROR"],
      ["GET", "/v1/flags/taken/results", "", 400, "VALIDATION_ERROR"],
    ];
    for (const [method, url, body, status, code] of cases) {
      const r = await send(app, method, url, body === "" ? undefined : body);
      assert.deepEqual([r.status, r.errorCode()], [status, code], `${method} ${url}`);
      assert.match(r.type, /^application\/json/);
    }
  });

  test("BR-53: routes and methods that do not exist answer 404 in our shape, with or without a key", async (t) => {
    const app = newApp(t);
    for (const [method, url] of [["GET", "/nope"], ["GET", "/v1/nope"], ["GET", "/v1/flags/a/b/c"], ["GET", "/v1/flags/"], ["PATCH", "/v1/flags"], ["POST", "/healthz"], ["DELETE", "/v1/evaluate"]] as const) {
      for (const auth of ["admin", "none"] as const) {
        const r = await send(app, method, url, undefined, auth);
        assert.deepEqual([r.status, r.errorCode()], [404, "FLAG_NOT_FOUND"], `${method} ${url} ${auth}`);
      }
    }
  });

  test("a malformed percent-escape in the URL is a 400 in our shape (it bypasses setErrorHandler)", async (t) => {
    const r = await send(newApp(t), "GET", "/v1/flags/%E0%A4%A");
    assert.deepEqual([r.status, r.errorCode()], [400, "VALIDATION_ERROR"]);
  });

  test("a path parameter longer than Fastify's default limit is still just 'not found'", async (t) => {
    const r = await send(newApp(t), "GET", `/v1/flags/${"a".repeat(300)}`);
    assert.deepEqual([r.status, r.errorCode()], [404, "FLAG_NOT_FOUND"]);
  });

  test("an unexpected failure is an opaque 500 INTERNAL_ERROR and is logged", async (t) => {
    const logged: unknown[] = [];
    const repo = new SqliteRepository(":memory:");
    const broken = new Service(repo);
    broken.listFlags = () => {
      throw new TypeError("secret internal detail: /var/lib/db at 0xdeadbeef");
    };
    const app = buildApp(broken, { adminKey: ADMIN, clientKey: CLIENT, logError: (_m, e) => logged.push(e) });
    t.after(async () => { await app.close(); repo.close(); });
    const r = await send(app, "GET", "/v1/flags");
    assert.deepEqual([r.status, r.errorCode()], [500, "INTERNAL_ERROR"]);
    assert.ok(!/secret|deadbeef|TypeError|\/var\//.test(r.text), `leaked: ${r.text}`);
    assert.equal(logged.length, 1);
  });

  test("repeated query parameters: the first value wins (BR-50)", async (t) => {
    const app = newApp(t);
    for (const k of ["a", "b", "c"]) await send(app, "POST", "/v1/flags", JSON.stringify({ key: k }));
    const r = await send(app, "GET", "/v1/flags?limit=1&limit=3&offset=1&offset=0");
    const body = r.json() as { items: { key: string }[]; total: number };
    assert.deepEqual([body.items.map((f) => f.key), body.total], [["b"], 3]);
  });

  test("a repeated flagKey filter uses the first value too", async (t) => {
    const app = newApp(t);
    await send(app, "POST", "/v1/flags", '{"key":"a"}');
    await send(app, "POST", "/v1/flags", '{"key":"b"}');
    const body = (await send(app, "GET", "/v1/audit-logs?flagKey=a&flagKey=b")).json() as { items: { flagKey: string }[] };
    assert.deepEqual(body.items.map((e) => e.flagKey), ["a"]);
  });
});

test("BR-57: only the flag key is percent-decoded; an escape anywhere else is a route that does not exist", async (t) => {
  const app = newApp(t);
  const routes: [string, string][] = [
    ["GET", "/%68ealthz"], ["GET", "/v1/%66lags"], ["GET", "/%76%31/flags"], ["GET", "/v1/audit%2Dlogs"],
    ["POST", "/v1/%65valuate"], ["POST", "/v1/%65vents"], ["GET", "/v1/flags/k/%72esults?goal=g"],
  ];
  for (const [method, url] of routes) {
    for (const auth of ["admin", "client", "none"] as const) {
      const r = await app.inject({ method: method as "GET" | "POST", url, headers: authHeaders(auth), payload: method === "POST" ? "{}" : undefined });
      assert.equal(r.statusCode, 404, `${method} ${url} ${auth}`);
      assert.equal((r.json() as { error: { code: string } }).error.code, "FLAG_NOT_FOUND");
    }
  }
  assert.equal((await app.inject({ method: "POST", url: "/v1/%66lags", headers: authHeaders("admin"), payload: '{"key":"made-by-alias"}' })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/flags/made-by-alias", headers: authHeaders("admin") })).statusCode, 404);
  await app.inject({ method: "POST", url: "/v1/flags", headers: authHeaders("admin"), payload: '{"key":"abc"}' });
  assert.equal((await app.inject({ method: "GET", url: "/v1/flags/%61bc", headers: authHeaders("admin") })).statusCode, 200);
});
