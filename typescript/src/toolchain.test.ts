// Proves the toolchain works before any service code exists: TypeScript compiles this file,
// node:test runs it, and the two native/third-party dependencies load.
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";

test("better-sqlite3 opens an in-memory database", () => {
  const db = new Database(":memory:");
  assert.equal((db.prepare("select 1 + 1 as two").get() as { two: number }).two, 2);
  db.close();
});

test("fastify can be created and closed", async () => {
  const app = Fastify();
  await app.ready();
  await app.close();
});
