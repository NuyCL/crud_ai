// Shared helpers for the black-box contract tests. Zero dependencies (Node 22+).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

export const BASE = (process.env.BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
export const ADMIN_KEY = process.env.ADMIN_KEY ?? "test-admin-key";
export const CLIENT_KEY = process.env.CLIENT_KEY ?? "test-client-key";

/** 1 = MVP1 only (on/off); 2 = everything (variants, rules, rollout, events). */
export const MVP = Number(process.env.CONTRACT_MVP ?? 2);
/** Spread into describe()/test() options for MVP2-only tests. */
export const mvp2 = MVP >= 2 ? {} : { skip: "MVP2 disabled (CONTRACT_MVP=1)" };

const AUTH = {
  admin: { "x-admin-key": ADMIN_KEY },
  client: { "x-client-key": CLIENT_KEY },
  none: {},
  "bad-admin": { "x-admin-key": "wrong-key" },
  "bad-client": { "x-client-key": "wrong-key" },
};

/**
 * Send a request. `body` is JSON-encoded; `rawBody` is sent as-is (for malformed JSON).
 * `auth` is one of admin (default) | client | none | bad-admin | bad-client.
 */
export async function call(method, path, { body, rawBody, auth = "admin" } = {}) {
  const headers = { ...AUTH[auth] };
  let payload;
  if (rawBody !== undefined) payload = rawBody;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, body: json };
}

export const get = (path, opts) => call("GET", path, opts);
export const post = (path, body, opts) => call("POST", path, { body, ...opts });
export const put = (path, body, opts) => call("PUT", path, { body, ...opts });
export const del = (path, opts) => call("DELETE", path, opts);

/** A flag key that is valid, unique per run and short enough for the 64-char limit. */
export function uniqueKey(prefix = "ct") {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Assert an error response: status, machine-readable code, JSON content type, string message. */
export function assertError(res, status, code) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text}`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.body?.error?.code, code, `expected error.code ${code}, got ${res.text}`);
  assert.equal(typeof res.body.error.message, "string");
}

/** Creates flags through the API and deletes them again after the suite. */
export function fixture() {
  const keys = [];
  return {
    /** POST a flag, assert 201, remember it for cleanup, return the response body. */
    async create(input = {}) {
      const body = { key: uniqueKey(), ...input };
      const res = await post("/v1/flags", body);
      assert.equal(res.status, 201, `create failed: ${res.text}`);
      keys.push(res.body.key);
      return res.body;
    },
    track(key) {
      keys.push(key);
    },
    async cleanup() {
      for (const k of keys) await del(`/v1/flags/${k}`);
    },
  };
}

export const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export const REASONS = ["FLAG_NOT_FOUND", "DISABLED", "TARGETING_MISS", "MISSING_USER_ID", "NOT_IN_ROLLOUT", "ON", "VARIANT"];
