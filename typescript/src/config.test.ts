import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("defaults", () => {
  assert.deepEqual(loadConfig({ ADMIN_KEY: "a", CLIENT_KEY: "c" }), { port: 8080, dbPath: "./flags.db", adminKey: "a", clientKey: "c", corsOrigins: [] });
});

test("overrides, and empty values count as unset", () => {
  assert.deepEqual(loadConfig({ PORT: "9000", DB_PATH: "/tmp/x.db", ADMIN_KEY: "a", CLIENT_KEY: "c" }), { port: 9000, dbPath: "/tmp/x.db", adminKey: "a", clientKey: "c", corsOrigins: [] });
  assert.equal(loadConfig({ PORT: "", DB_PATH: "", ADMIN_KEY: "a", CLIENT_KEY: "c" }).port, 8080);
});

test("both keys are required", () => {
  for (const env of [{}, { CLIENT_KEY: "c" }, { ADMIN_KEY: "a" }, { ADMIN_KEY: "", CLIENT_KEY: "c" }]) assert.throws(() => loadConfig(env), /ADMIN_KEY and CLIENT_KEY/);
});

test("PORT must be an integer from 1 to 65535", () => {
  for (const port of ["0", "65536", "abc", "80.5", "-1", " ", "1e3x"]) assert.throws(() => loadConfig({ PORT: port, ADMIN_KEY: "a", CLIENT_KEY: "c" }), /PORT/, port);
  assert.equal(loadConfig({ PORT: "65535", ADMIN_KEY: "a", CLIENT_KEY: "c" }).port, 65535);
});

test("CORS_ORIGINS is split on commas, trimmed, and empty items are dropped", () => {
  const base = { ADMIN_KEY: "a", CLIENT_KEY: "c" };
  assert.deepEqual(loadConfig({ ...base, CORS_ORIGINS: "" }).corsOrigins, []);
  assert.deepEqual(loadConfig({ ...base, CORS_ORIGINS: " , " }).corsOrigins, []);
  assert.deepEqual(loadConfig({ ...base, CORS_ORIGINS: " https://a.example , https://b.example," }).corsOrigins, ["https://a.example", "https://b.example"]);
  assert.deepEqual(loadConfig({ ...base, CORS_ORIGINS: "*" }).corsOrigins, ["*"]);
});
