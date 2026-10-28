// Differential test: sends the same pseudo-random sequence of requests to two running services and
// reports every response that differs. It finds behaviour that both implementations pass the
// contract tests with, yet that nobody thought to write a test for.
//
//   node tools/diff-servers/diff.mjs <baseUrlA> <baseUrlB> [--seed=1] [--requests=3000] [--show=10]
//
// Both services must start from an empty database and use ADMIN_KEY=test-admin-key / CLIENT_KEY=test-client-key.
// The sequence is a function of the seed only, so the two services see identical histories and any
// difference is a difference in behaviour. A failing seed reproduces exactly.
//
// Not compared, on purpose: timestamps (their formatting differs legitimately), error messages (the
// spec compares only error.code), p-values beyond 1e-9 relative. Not generated: the inputs listed
// under "accepted differences" in docs/porting/typescript-analysis.md (lone surrogates, repeated
// headers, unclean paths such as "//"), because they are known to differ and nothing pins them down.

const [baseA, baseB] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const opt = (name, fallback) => Number((process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=")[1]);
const SEED = opt("seed", 1);
const REQUESTS = opt("requests", 3000);
const SHOW = opt("show", 10);
if (!baseA || !baseB) {
  console.error("usage: node tools/diff-servers/diff.mjs <baseUrlA> <baseUrlB> [--seed=1] [--requests=3000] [--show=10]");
  process.exit(2);
}

// ------------------------------------------------------------------ random

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const int = (n) => Math.floor(rand() * n);
const pick = (xs) => xs[int(xs.length)];
const chance = (p) => rand() < p;

const GOOD_KEYS = ["alpha", "beta", "gamma", "new-checkout", "dark_mode", "a", "x1", "search-v2"];
const BAD_KEYS = ["Bad", "a b", "", "x".repeat(65), "abc\n", "-lead", "ไทย", "UPPER", "a/b"];
const KEYS = [...GOOD_KEYS, ...GOOD_KEYS, ...GOOD_KEYS, ...BAD_KEYS];
const USERS = ["u1", "u2", "u3", "alice", "bob", "ผู้ใช้-1", "café", "日本語", "😀", "a:b", "user@example.com", ...Array.from({ length: 30 }, (_, i) => `user-${i}`)];
const ATTRS = ["country", "plan", "age", "beta", "tier", "constructor", "__proto__", "toString"];
const SCALARS = ["TH", "SG", "US", "pro", "free", 1, 2, 18, 0, true, false, "", "1", "true"];
const GOALS = ["buy", "signup", "click"];
const TIMESTAMPS = ["2026-01-31T08:00:00Z", "2026-02-30T00:00:00Z", "2026-01-31T8:00:00Z", "2026-01-31T08:00:00,5Z", "2026-01-31T08:00:00+24:00", "2028-02-29T00:00:00.5+07:00", "2026-01-31", "yesterday", "2026-13-01T00:00:00Z"];
const DESCRIPTIONS = ["", "new checkout flow", "ธงฟีเจอร์ 🚩", "😀".repeat(500), "😀".repeat(501), "a".repeat(500), "a".repeat(501), "ก".repeat(500), "x\u0000y", 'quote " and \\ backslash', "</script><&>"];

const scalar = () => pick(SCALARS);
const rule = () => {
  const operator = pick(["eq", "neq", "in", "not_in", "eq", "in", "gt"]);
  const list = operator === "in" || operator === "not_in";
  const value = list ? (chance(0.1) ? scalar() : Array.from({ length: int(4) }, scalar)) : chance(0.08) ? [scalar()] : scalar();
  return chance(0.05) ? { attribute: pick(ATTRS), operator } : { attribute: chance(0.03) ? "" : pick(ATTRS), operator, value };
};
const variants = () => {
  const n = pick([2, 2, 2, 3, 3, 4, 1, 11]);
  const names = ["control", "treatment", "blue", "green", "red", "Bad", "a", "b", "c", "d", "e", "f"];
  const weights = Array.from({ length: n }, () => 1 + int(60));
  if (chance(0.8)) { // make them add up to 100 most of the time
    const sum = weights.reduce((x, y) => x + y, 0);
    for (let i = 0; i < n; i++) weights[i] = Math.max(1, Math.round((weights[i] * 100) / sum));
    weights[0] += 100 - weights.reduce((x, y) => x + y, 0);
  }
  return weights.map((weight, i) => ({ key: chance(0.04) ? pick(names) : names[i], weight: chance(0.03) ? 0.5 : weight }));
};
const flagBody = (key) => {
  const body = { key };
  if (chance(0.7)) body.description = pick(DESCRIPTIONS);
  if (chance(0.8)) body.enabled = chance(0.9) ? chance(0.8) : pick(["true", 1, null]);
  if (chance(0.5)) body.rolloutPercent = chance(0.85) ? pick([0, 1, 10, 25, 50, 75, 99, 100]) : pick([10.5, -1, 101, "50", null, 1e10]);
  if (chance(0.5)) body.rules = Array.from({ length: int(3) }, rule);
  if (chance(0.45)) body.variants = chance(0.9) ? variants() : "blue";
  return body;
};
const context = () => {
  const ctx = {};
  if (chance(0.85)) ctx.userId = pick(USERS);
  if (chance(0.7)) ctx.attributes = Object.fromEntries(Array.from({ length: int(5) }, () => [pick(ATTRS), scalar()]));
  return ctx;
};
const event = () => {
  const e = chance(0.5) ? { type: "exposure", userId: pick(USERS), flagKey: pick(GOOD_KEYS), variant: pick(["control", "treatment", "blue", "green", "a", "b"]) } : { type: "conversion", userId: pick(USERS), goal: pick(GOALS) };
  if (chance(0.15)) e.timestamp = pick(TIMESTAMPS);
  if (chance(0.03)) delete e.userId;
  return e;
};
const page = () => pick(["", "", "?limit=1", "?limit=5&offset=2", "?limit=100", "?limit=0", "?limit=101", "?limit=abc", "?offset=-1", "?limit=2&limit=9", "?limit=007", "?offset=1000000", "?limit="]);

// Random requests almost never put 30 exposures into each variant of one flag, so the statistics
// (BR-42) would go untested. An "experiment" is a short scripted scenario that does: it creates a
// two-variant flag, sends exposures and conversions in batches of up to 100, then asks for the report.
// Sample sizes include the boundary of the 30-exposure minimum, and the treatment is sometimes worse.
const pending = [];
let experiments = 0;
function queueExperiment() {
  const key = `exp-${experiments++}`;
  const goal = pick(GOALS);
  const sizes = [29, 30, 31, 40, 100, 150, 400];
  const nControl = pick(sizes);
  const nTreatment = chance(0.5) ? nControl : pick(sizes);
  const rates = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 1];
  const [rControl, rTreatment] = [pick(rates), pick(rates)];
  const events = [];
  for (const [variant, n, rate] of [["control", nControl, rControl], ["treatment", nTreatment, rTreatment]]) {
    for (let i = 0; i < n; i++) {
      events.push({ type: "exposure", userId: `${key}-${variant}-${i}`, flagKey: key, variant });
      if (rand() < rate) events.push({ type: "conversion", userId: `${key}-${variant}-${i}`, goal });
    }
  }
  // a few users convert without ever being exposed, and a few are exposed twice
  for (let i = 0; i < 5; i++) events.push({ type: "conversion", userId: `${key}-stranger-${i}`, goal });
  for (let i = 0; i < 5; i++) events.push({ type: "exposure", userId: `${key}-control-${i}`, flagKey: key, variant: "treatment" });
  pending.push({ method: "POST", path: "/v1/flags", body: { key, enabled: true, variants: [{ key: "control", weight: 50 }, { key: "treatment", weight: 50 }] }, auth: "admin" });
  for (let i = 0; i < events.length; i += 100) pending.push({ method: "POST", path: "/v1/events", body: { events: events.slice(i, i + 100) }, auth: "client" });
  pending.push({ method: "GET", path: `/v1/flags/${key}/results?goal=${goal}`, auth: "admin" });
  pending.push({ method: "GET", path: `/v1/flags/${key}/results?goal=never`, auth: "admin" });
}

function nextRequest() {
  if (pending.length > 0) return pending.shift();
  if (chance(0.004)) queueExperiment();
  if (pending.length > 0) return pending.shift();
  const r = rand();
  const key = pick(KEYS);
  const enc = encodeURIComponent(key);
  const raw = (method, path, text, auth = "admin", contentType = "application/json") => ({ method, path, rawBody: text, auth, contentType });
  const json = (method, path, body, auth = "admin") => ({ method, path, body, auth });
  const authAdmin = chance(0.94) ? "admin" : pick(["none", "bad", "client"]);
  const authClient = chance(0.93) ? "client" : pick(["none", "bad", "admin"]);
  if (r < 0.20) return json("POST", "/v1/flags", flagBody(key), authAdmin);
  if (r < 0.28) return json("PUT", `/v1/flags/${enc}`, flagBody(chance(0.9) ? key : pick(KEYS)), authAdmin);
  if (r < 0.31) return { method: "DELETE", path: `/v1/flags/${enc}`, auth: authAdmin };
  if (r < 0.37) return { method: "GET", path: `/v1/flags/${enc}`, auth: authAdmin };
  if (r < 0.41) return { method: "GET", path: `/v1/flags${page()}`, auth: authAdmin };
  if (r < 0.44) return { method: "GET", path: `/v1/audit-logs${page()}${chance(0.5) ? (page() ? "&" : "?") + "flagKey=" + enc : ""}`, auth: authAdmin };
  if (r < 0.66) {
    const flags = chance(0.5) ? undefined : Array.from({ length: int(5) }, () => pick(chance(0.1) ? ["__proto__", "constructor", "ghost", ...KEYS] : GOOD_KEYS));
    return json("POST", "/v1/evaluate", { ...(flags ? { flags } : {}), ...(chance(0.95) ? { context: context() } : {}) }, authClient);
  }
  if (r < 0.80) return json("POST", "/v1/events", { events: Array.from({ length: 1 + int(chance(0.9) ? 6 : 120) }, event) }, authClient);
  if (r < 0.88) return { method: "GET", path: `/v1/flags/${encodeURIComponent(pick(GOOD_KEYS))}/results?goal=${pick(GOALS.concat(["", "none"]))}`, auth: authAdmin };
  if (r < 0.92) return raw("POST", pick(["/v1/flags", "/v1/evaluate", "/v1/events"]), pick(["", "{oops", "[]", "null", '{"key":"alpha"}{"key":"beta"}', '{"key":"alpha"} x', "true", '"str"', "1", " "]), pick(["admin", "client"]));
  if (r < 0.95) return raw("POST", "/v1/flags", JSON.stringify(flagBody(key)), "admin", pick(["text/plain", "application/x-www-form-urlencoded", "application/octet-stream"]));
  if (r < 0.97) return { method: pick(["GET", "POST", "PATCH", "DELETE", "PUT"]), path: pick(["/nope", "/v1/nope", "/v1/flags/a/b/c", "/v1/flags/", "/healthz", "/v1/evaluate"]), auth: pick(["admin", "none"]) };
  return { method: "GET", path: `/v1/flags/${"k".repeat(pick([65, 150, 400]))}`, auth: "admin" };
}

// ---------------------------------------------------------------- sending

const AUTH = { admin: { "x-admin-key": "test-admin-key" }, client: { "x-client-key": "test-client-key" }, none: {}, bad: { "x-admin-key": "wrong", "x-client-key": "wrong" } };

async function send(base, req) {
  const headers = { ...AUTH[req.auth] };
  let payload;
  if (req.rawBody !== undefined) payload = req.rawBody;
  else if (req.body !== undefined) payload = JSON.stringify(req.body);
  if (payload !== undefined) headers["content-type"] = req.contentType ?? "application/json";
  try {
    const res = await fetch(base + req.path, { method: req.method, headers, body: payload });
    const text = await res.text();
    let json;
    try { json = text === "" ? undefined : JSON.parse(text); } catch { json = { __unparseable: text.slice(0, 80) }; }
    return { status: res.status, jsonType: /^application\/json/.test(res.headers.get("content-type") ?? ""), json };
  } catch (e) {
    return { status: -1, jsonType: false, json: { __networkError: String(e.cause?.code ?? e.message) } };
  }
}

// ------------------------------------------------------------- comparison

const IGNORED_KEYS = new Set(["createdAt", "updatedAt"]);

/** Canonical copy: sorted keys, timestamps and error messages blanked. Built with defineProperty so a key named __proto__ survives. */
function canon(v, parentKey = "") {
  if (Array.isArray(v)) return v.map((x) => canon(x));
  if (v !== null && typeof v === "object") {
    const out = Object.create(null);
    for (const k of Object.keys(v).sort()) out[k] = IGNORED_KEYS.has(k) ? "<time>" : k === "message" && parentKey === "error" ? "<message>" : canon(v[k], k);
    return out;
  }
  return v;
}

function same(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= Math.max(1e-12, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k]));
  }
  return a === b;
}

// ------------------------------------------------------------------- main

const diffs = [];
const byRoute = new Map();
const statuses = new Map();
let withPValue = 0; // reports that reached the statistics, to show the experiments are exercised
for (let i = 0; i < REQUESTS; i++) {
  const req = nextRequest();
  const [a, b] = [await send(baseA, req), await send(baseB, req)];
  const route = `${req.method} ${req.path.split("?")[0].replace(/\/v1\/flags\/[^/]+/, "/v1/flags/:key")}`;
  byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
  statuses.set(a.status, (statuses.get(a.status) ?? 0) + 1);
  if (a.json?.variants?.some?.((v) => typeof v.pValue === "number")) withPValue++;
  const equal = a.status === b.status && a.jsonType === b.jsonType && same(canon(a.json), canon(b.json));
  if (!equal) diffs.push({ i, req, a, b });
}

console.log(`seed ${SEED}: ${REQUESTS} requests over ${byRoute.size} routes, statuses seen: ${[...statuses].sort((x, y) => x[0] - y[0]).map(([s, n]) => `${s}x${n}`).join(" ")}`);
console.log(`${withPValue} reports contained a computed p-value`);
console.log(`${diffs.length} differing response${diffs.length === 1 ? "" : "s"}`);
for (const d of diffs.slice(0, SHOW)) {
  const shown = d.req.rawBody !== undefined ? JSON.stringify(d.req.rawBody).slice(0, 160) : JSON.stringify(d.req.body ?? "").slice(0, 200);
  console.log(`\n#${d.i} ${d.req.method} ${d.req.path} [auth ${d.req.auth}${d.req.contentType && d.req.contentType !== "application/json" ? ", " + d.req.contentType : ""}] body ${shown}`);
  console.log(`  A ${baseA}: ${d.a.status} json=${d.a.jsonType} ${JSON.stringify(canon(d.a.json)).slice(0, 260)}`);
  console.log(`  B ${baseB}: ${d.b.status} json=${d.b.jsonType} ${JSON.stringify(canon(d.b.json)).slice(0, 260)}`);
}
process.exit(diffs.length === 0 ? 0 : 1);
