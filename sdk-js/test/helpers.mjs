// Test helpers: a fake fetch that records every request, and a flag-service answer builder.
import { setImmediate as tick } from "node:timers/promises";

export const BASE = "https://flags.example.com";

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The shape of the service's answer to POST /v1/evaluate. */
export const evaluated = (results) => json({ results });
export const on = { enabled: true, variant: null, reason: "ON" };
export const off = { enabled: false, variant: null, reason: "DISABLED" };
export const variant = (name) => ({ enabled: true, variant: name, reason: "VARIANT" });

/**
 * A fetch that answers with `handler(path, body, init)` (a Response, or a thrown error for a network failure) and
 * keeps every call: `calls` has { path, body, headers, signal } in order.
 */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const path = String(url).replace(BASE, "");
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    const call = { path, body, headers: init?.headers ?? {}, method: init?.method, signal: init?.signal, url: String(url) };
    calls.push(call);
    return handler(path, body, init, calls.length);
  };
  fn.calls = calls;
  fn.to = (path) => calls.filter((c) => c.path === path);
  return fn;
}

/** An in-memory stand-in for localStorage. */
export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    data,
  };
}

/** Let pending promise callbacks and I/O callbacks run. */
export const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

export const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
