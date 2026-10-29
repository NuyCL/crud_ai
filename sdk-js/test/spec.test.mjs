// The SDK is written from spec/openapi.yaml, so what it hard-codes must agree with the file. No YAML parser is
// available (no dependencies), so the few facts needed are cut out of the text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const spec = readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");

const list = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

test("the Reason type lists exactly the reasons in components.schemas.EvaluationResult", () => {
  const inSpec = list(/EvaluationResult:[\s\S]*?reason:\s*type: string\s*enum:\s*\[([^\]]+)\]/.exec(spec)?.[1] ?? "");
  const inTypes = [...(/export type Reason =([^;]+);/.exec(types)?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(inSpec.length > 0, "found the enum in the spec");
  assert.deepEqual(inTypes, inSpec);
});

test("the event types are the ones components.schemas.Event allows", () => {
  const inSpec = list(/Event:\s*type: object[\s\S]*?type:\s*\{ type: string, enum: \[([^\]]+)\]/.exec(spec)?.[1] ?? "");
  assert.deepEqual(inSpec, ["exposure", "conversion"]);
  for (const name of inSpec) assert.ok(types.includes(`type: "${name}"`), name);
});

test("a batch is as large as POST /v1/events allows", () => {
  const max = Number(/\/v1\/events:[\s\S]*?maxItems:\s*(\d+)/.exec(spec)?.[1]);
  assert.equal(Number(/const MAX_BATCH = (\d+)/.exec(client)?.[1]), max);
});

test("the client key travels in the header the spec names, to the paths the spec has", () => {
  const header = /securitySchemes:[\s\S]*?ClientKey:\s*type: apiKey\s*in: header\s*name:\s*([A-Za-z-]+)/.exec(spec)?.[1];
  assert.ok(header, "found the security scheme");
  assert.ok(client.includes(`"${header}"`), `${header} is sent`);
  for (const path of ["/v1/evaluate", "/v1/events"]) {
    assert.ok(new RegExp(`^  ${path}:`, "m").test(spec), `${path} is in the spec`);
    assert.ok(client.includes(`"${path}"`), `${path} is called`);
  }
});

test("the request and response types have the properties the spec has", () => {
  const evaluateProps = [...(/\/v1\/evaluate:[\s\S]*?properties:\s*flags:[\s\S]*?context:/.exec(spec)?.[0] ?? "").matchAll(/^\s{16}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(evaluateProps.sort(), ["context", "flags"]);
  assert.match(types, /interface EvaluateRequest \{\s*flags\?: string\[\];\s*context\?: Context;/);
  for (const field of ["enabled", "variant", "reason"]) assert.match(types, new RegExp(`interface EvaluationResult \\{[^}]*${field}`));
  for (const field of ["type", "userId", "flagKey", "variant", "goal", "timestamp"]) assert.ok(new RegExp(`${field}:`).test(spec.slice(spec.indexOf("    Event:"))), `${field} is in the spec`);
});
