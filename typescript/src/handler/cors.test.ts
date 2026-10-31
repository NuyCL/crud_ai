import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { SqliteRepository } from "../repository/sqlite.js";
import { Service } from "../service/service.js";
import { buildApp } from "./handler.js";

const APP = "https://app.example.com";
const CLIENT = "test-client-key";

function newApp(t: TestContext, corsOrigins?: string[]): FastifyInstance {
  const repo = new SqliteRepository(":memory:");
  const app = buildApp(new Service(repo), { adminKey: "test-admin-key", clientKey: CLIENT, corsOrigins, logError: () => undefined });
  t.after(async () => {
    await app.close();
    repo.close();
  });
  return app;
}

const send = (app: FastifyInstance, method: "OPTIONS" | "POST" | "GET", url: string, origin?: string, payload?: string, key = true): Promise<LightMyRequestResponse> =>
  app.inject({
    method,
    url,
    payload,
    headers: { ...(origin === undefined ? {} : { origin }), ...(method === "POST" && key ? { "x-client-key": CLIENT } : {}) },
  });

const cors = (r: LightMyRequestResponse) => r.headers["access-control-allow-origin"];

test("BR-56: a preflight from an allowed origin is 204 with the CORS headers and needs no key", async (t) => {
  const app = newApp(t, [APP]);
  for (const url of ["/v1/evaluate", "/v1/events"]) {
    const r = await send(app, "OPTIONS", url, APP);
    assert.equal(r.statusCode, 204);
    assert.equal(r.body, "");
    assert.equal(cors(r), APP);
    assert.equal(r.headers["access-control-allow-methods"], "POST");
    assert.equal(r.headers["access-control-allow-headers"], "Content-Type, X-Client-Key");
    assert.equal(r.headers["access-control-max-age"], "600");
    assert.equal(r.headers["vary"], "Origin");
    assert.equal(r.headers["access-control-allow-credentials"], undefined);
  }
});

test("BR-56: every other preflight is the usual 404", async (t) => {
  const app = newApp(t, [APP]);
  const cases: [string, string | undefined][] = [
    ["/v1/evaluate", undefined], ["/v1/evaluate", "https://evil.example.org"], ["/v1/evaluate", "null"],
    ["/v1/evaluate", `${APP}/`], ["/v1/evaluate", "http://app.example.com"], ["/v1/evaluate", APP.toUpperCase()],
    ["/v1/events", "https://evil.example.org"], ["/v1/flags", APP], ["/v1/flags/x", APP], ["/healthz", APP], ["/nope", APP], ["/v1/evaluate/", APP],
  ];
  for (const [url, origin] of cases) {
    const r = await send(app, "OPTIONS", url, origin);
    assert.equal(r.statusCode, 404, `${url} ${origin}`);
    assert.equal(cors(r), undefined, `${url} ${origin}`);
    assert.equal(r.headers["access-control-allow-methods"], undefined, `${url} ${origin}`);
  }
});

test("BR-56: POST responses carry the origin whatever the status", async (t) => {
  const app = newApp(t, [APP]);
  const ok = { type: "conversion", userId: "u", goal: "g" };
  const cases: [string, string, number, boolean?][] = [
    ["/v1/evaluate", '{"flags":[]}', 200], ["/v1/evaluate", "[]", 400], ["/v1/evaluate", "{}", 401, false],
    ["/v1/events", JSON.stringify({ events: [ok] }), 202], ["/v1/events", '{"events":[]}', 400],
  ];
  for (const [url, body, status, key] of cases) {
    const r = await send(app, "POST", url, APP, body, key);
    assert.equal(r.statusCode, status, `${url} ${body}`);
    assert.equal(cors(r), APP, `${url} ${status}`);
    assert.equal(r.headers["vary"], "Origin");
  }
});

test("BR-56: no CORS headers without an allowed Origin, on other paths, or when CORS is off", async (t) => {
  const app = newApp(t, [APP]);
  const body = '{"flags":[]}';
  assert.equal(cors(await send(app, "POST", "/v1/evaluate", undefined, body)), undefined);
  const stranger = await send(app, "POST", "/v1/evaluate", "https://evil.example.org", body);
  assert.equal(stranger.statusCode, 200);
  assert.equal(cors(stranger), undefined);
  for (const url of ["/healthz", "/v1/flags", "/v1/evaluate"]) assert.equal(cors(await send(app, "GET", url, APP)), undefined, url);

  for (const off of [undefined, []]) {
    const closed = newApp(t, off);
    assert.equal((await send(closed, "OPTIONS", "/v1/evaluate", APP)).statusCode, 404);
    assert.equal(cors(await send(closed, "POST", "/v1/evaluate", APP, body)), undefined);
  }
});

test("BR-56: '*' allows every origin and sends no Vary", async (t) => {
  const app = newApp(t, ["*"]);
  const pre = await send(app, "OPTIONS", "/v1/events", "https://anything.example");
  assert.equal(pre.statusCode, 204);
  assert.equal(cors(pre), "*");
  assert.equal(pre.headers["vary"], undefined);
  assert.equal(cors(await send(app, "POST", "/v1/evaluate", undefined, '{"flags":[]}')), undefined);
});
