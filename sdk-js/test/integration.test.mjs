// The SDK against a real service. By default it starts tools/mock-server on a free port; set FF_BASE_URL to test
// against any running service instead (started with ADMIN_KEY=test-admin-key CLIENT_KEY=test-client-key, empty database).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { FlagClient } from "../dist/index.js";

const ADMIN = "test-admin-key";
const CLIENT = "test-client-key";
const external = process.env.FF_BASE_URL?.replace(/\/+$/, "");
let baseUrl = external;
let server;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

before(async () => {
  if (external) return;
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [new URL("../../tools/mock-server/server.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), ADMIN_KEY: ADMIN, CLIENT_KEY: CLIENT },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the mock server did not start");
});

after(() => server?.kill());

const admin = async (method, path, body) => {
  const res = await fetch(baseUrl + path, { method, headers: { "X-Admin-Key": ADMIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
};
const unique = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const sdk = (id, attributes, extra = {}) => new FlagClient({ baseUrl, clientKey: CLIENT, user: { id, attributes }, pollIntervalMs: 0, storage: null, ...extra });

describe("against a running service", () => {
  test("a flag created through the admin API is read by the SDK, rules included", async () => {
    const key = unique("rule");
    assert.equal((await admin("POST", "/v1/flags", { key, enabled: true, rules: [{ attribute: "country", operator: "in", value: ["TH", "SG"] }] })).status, 201);
    const th = sdk("u1", { country: "TH" });
    const us = sdk("u1", { country: "US" });
    await Promise.all([th.ready(), us.ready()]);
    assert.equal(th.isEnabled(key), true);
    assert.equal(us.isEnabled(key, true), false, "the service said no: the fallback does not apply");
    assert.equal(th.isEnabled(unique("nope"), true), true, "unknown flag: the fallback does");
    th.close();
    us.close();
    await admin("DELETE", `/v1/flags/${key}`);
  });

  test("a disabled flag is off and a flag that is not there is the fallback", async () => {
    const key = unique("off");
    await admin("POST", "/v1/flags", { key, enabled: false });
    const ff = sdk("u1");
    await ff.ready();
    assert.equal(ff.isEnabled(key, true), false);
    ff.close();
    await admin("DELETE", `/v1/flags/${key}`);
  });

  test("1000 users are spread over the variants in about the proportions asked for, and every user is counted once", async () => {
    const key = unique("exp");
    const created = await admin("POST", "/v1/flags", { key, enabled: true, variants: [{ key: "control", weight: 70 }, { key: "treatment", weight: 30 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
    const counts = { control: 0, treatment: 0 };
    const converted = { control: 0, treatment: 0 };
    for (let i = 0; i < users.length; i += 100) {
      await Promise.all(
        users.slice(i, i + 100).map(async (id, j) => {
          const ff = sdk(id, undefined, { flushIntervalMs: 3_600_000 });
          await ff.ready();
          const v = ff.getVariant(key, "none");
          assert.ok(v in counts, `user ${id} got ${v}`);
          counts[v]++;
          assert.equal(ff.getVariant(key, "none"), v, "same user, same variant");
          if ((i + j) % 4 === 0) {
            ff.track("purchase");
            converted[v]++;
          }
          await ff.flush();
          ff.close();
        }),
      );
    }
    assert.equal(counts.control + counts.treatment, 1000);
    assert.ok(Math.abs(counts.control / 1000 - 0.7) <= 0.05, `control share ${counts.control / 1000}`);

    const { status, body } = await admin("GET", `/v1/flags/${key}/results?goal=purchase`);
    assert.equal(status, 200);
    const row = (name) => body.variants.find((v) => v.variant === name);
    assert.equal(row("control").exposures, counts.control, "each user is one exposure, however often the variant was read");
    assert.equal(row("treatment").exposures, counts.treatment);
    assert.equal(row("control").conversions, converted.control);
    assert.equal(row("treatment").conversions, converted.treatment);
    await admin("DELETE", `/v1/flags/${key}`);
  });

  test("a polling SDK sees a change made through the admin API, and onChange tells it", async () => {
    const key = unique("poll");
    await admin("POST", "/v1/flags", { key, enabled: false });
    const ff = sdk("u1", undefined, { pollIntervalMs: 50 });
    let changes = 0;
    ff.onChange(() => changes++);
    await ff.ready();
    assert.equal(ff.isEnabled(key), false);
    const before = changes;
    await admin("PUT", `/v1/flags/${key}`, { key, enabled: true });
    for (let i = 0; i < 100 && !ff.isEnabled(key); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ff.isEnabled(key), true);
    assert.ok(changes > before);
    ff.close();
    await admin("DELETE", `/v1/flags/${key}`);
  });

  test("with a wrong client key nothing works and nothing throws", async () => {
    const key = unique("auth");
    await admin("POST", "/v1/flags", { key, enabled: true });
    const ff = new FlagClient({ baseUrl, clientKey: "wrong", user: { id: "u1" }, pollIntervalMs: 0, storage: null });
    await ff.ready();
    assert.equal(ff.isEnabled(key, "fallback"), "fallback");
    assert.doesNotThrow(() => ff.track("purchase"));
    await ff.flush();
    ff.close();
    await admin("DELETE", `/v1/flags/${key}`);
  });

  test("the admin key is refused where the SDK would send it: it is not even an option", () => {
    assert.throws(() => new FlagClient({ baseUrl, user: { id: "u1" } }), TypeError);
  });

  test("a service that is not there: ready() resolves, the fallbacks serve", async () => {
    const port = await freePort();
    const ff = new FlagClient({ baseUrl: `http://127.0.0.1:${port}`, clientKey: CLIENT, user: { id: "u1" }, pollIntervalMs: 0, storage: null, timeoutMs: 500 });
    await ff.ready();
    assert.equal(ff.isEnabled("anything", true), true);
    assert.equal(ff.getVariant("anything", "red"), "red");
    ff.track("purchase");
    await ff.flush();
    ff.close();
  });
});
