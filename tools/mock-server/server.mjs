// In-memory reference of the HTTP contract, used ONLY to prove that
// tests/contract/ is correct and that it can fail. It is not a deliverable
// implementation: the real ones live in go/, typescript/, java/, python/, rust/.
//
//   node tools/mock-server/server.mjs        (PORT, ADMIN_KEY, CLIENT_KEY from env)
//
// Set MOCK_BUG=<name> to inject a known defect and watch the tests catch it:
//   utf16-description   count description length in UTF-16 units, not code points
//   no-audit-on-delete  skip the audit entry for deletes
//   put-merges          PUT merges instead of replacing
//   exposure-last-wins  later exposures overwrite earlier ones
//   weights-not-checked accept variants whose weights do not sum to 100
//   client-gets-401     client key on admin API answers 401 instead of 403
//   offset-ignored      list endpoints ignore `offset`
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const ADMIN_KEY = process.env.ADMIN_KEY ?? "test-admin-key";
const CLIENT_KEY = process.env.CLIENT_KEY ?? "test-client-key";
const BUG = process.env.MOCK_BUG ?? "";
const CORS = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VARIANT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TS_RE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))$/;
const MAX_BODY_BYTES = 1024 * 1024;

const flags = new Map();
const audit = [];
const exposures = new Map(); // `${flagKey}\0${userId}` -> variant
const conversions = new Set(); // `${goal}\0${userId}`

// ------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (code, message) => new HttpError(400, code, message);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v) => ["string", "number", "boolean"].includes(typeof v);
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const now = () => new Date().toISOString();

function send(res, status, body) {
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function authorize(req, { adminOnly }) {
  const admin = req.headers["x-admin-key"] === ADMIN_KEY;
  const client = req.headers["x-client-key"] === CLIENT_KEY;
  if (admin) return;
  if (adminOnly) {
    if (client && BUG !== "client-gets-401") throw new HttpError(403, "FORBIDDEN", "client key cannot use the admin API");
    throw new HttpError(401, "UNAUTHORIZED", "missing or invalid admin key");
  }
  if (!client) throw new HttpError(401, "UNAUTHORIZED", "missing or invalid key");
}

// BR-55: a path key that is not valid UTF-8 can never name a flag, so it is "not found", not an error.
function decodeKey(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "\u0000invalid";
  }
}

// BR-52: any Content-Type, one JSON value, at most 1 MiB. The whole body is read before
// answering so that a client still uploading does not see a reset connection.
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size <= MAX_BODY_BYTES) chunks.push(c);
  }
  if (size > MAX_BODY_BYTES) throw bad("VALIDATION_ERROR", "body is larger than 1 MiB");
  try {
    // fatal: invalid UTF-8 is an error, not U+FFFD; ignoreBOM keeps a BOM so JSON.parse rejects it
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw bad("VALIDATION_ERROR", "body is not valid JSON");
  }
}

// RFC 3339 that is also correct on the calendar. Date.parse alone is too lenient: it accepts
// Feb 30, hour 24, dates without a time, and times without a zone.
function validTimestamp(s) {
  const m = TS_RE.exec(s);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month, 0); // day 0 of the next month = last day of this one
  if (day < 1 || day > lastDay.getUTCDate()) return false;
  return m[7] === undefined || (Number(m[7]) <= 23 && Number(m[8]) <= 59);
}

function page(url) {
  const num = (name, def, min, max) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return def;
    if (!/^\d+$/.test(raw)) throw bad("VALIDATION_ERROR", `${name} must be an integer`);
    const n = Number(raw);
    if (n < min || n > max) throw bad("VALIDATION_ERROR", `${name} out of range`);
    return n;
  };
  const offset = num("offset", 0, 0, Infinity);
  return { limit: num("limit", 20, 1, 100), offset: BUG === "offset-ignored" ? 0 : offset };
}

// ----------------------------------------------------------- validation

function codePoints(s) {
  return BUG === "utf16-description" ? s.length : [...s].length;
}

function validateRule(r) {
  if (!isObj(r)) throw bad("VALIDATION_ERROR", "rule must be an object");
  if (typeof r.attribute !== "string" || r.attribute === "") throw bad("VALIDATION_ERROR", "rule.attribute");
  if (!["eq", "neq", "in", "not_in"].includes(r.operator)) throw bad("VALIDATION_ERROR", "rule.operator");
  if (r.value === undefined || r.value === null) throw bad("VALIDATION_ERROR", "rule.value");
  if (r.operator === "in" || r.operator === "not_in") {
    if (!Array.isArray(r.value) || r.value.length === 0 || !r.value.every(isScalar)) {
      throw bad("VALIDATION_ERROR", "rule.value must be a non-empty array of scalars");
    }
  } else if (!isScalar(r.value)) {
    throw bad("VALIDATION_ERROR", "rule.value must be a scalar");
  }
}

function validateVariants(v) {
  if (!Array.isArray(v)) throw bad("VALIDATION_ERROR", "variants must be an array");
  if (v.length === 0) return;
  if (v.length < 2 || v.length > 10) throw bad("INVALID_VARIANTS", "need 2-10 variants");
  const seen = new Set();
  let sum = 0;
  for (const x of v) {
    if (!isObj(x)) throw bad("INVALID_VARIANTS", "variant must be an object");
    if (typeof x.key !== "string" || !VARIANT_KEY_RE.test(x.key)) throw bad("INVALID_VARIANTS", "variant.key");
    if (seen.has(x.key)) throw bad("INVALID_VARIANTS", "duplicate variant key");
    seen.add(x.key);
    if (!isInt(x.weight) || x.weight < 1 || x.weight > 100) throw bad("INVALID_VARIANTS", "variant.weight");
    sum += x.weight;
  }
  if (sum !== 100 && BUG !== "weights-not-checked") throw bad("INVALID_VARIANTS", "weights must sum to 100");
}

function parseFlagInput(b) {
  if (!isObj(b)) throw bad("VALIDATION_ERROR", "body must be an object");
  if (typeof b.key !== "string") throw bad("VALIDATION_ERROR", "key is required");
  if (!KEY_RE.test(b.key)) throw bad("INVALID_KEY", "key must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  if (b.description !== undefined) {
    if (typeof b.description !== "string") throw bad("VALIDATION_ERROR", "description must be a string");
    if (codePoints(b.description) > 500) throw bad("VALIDATION_ERROR", "description too long");
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw bad("VALIDATION_ERROR", "enabled must be boolean");
  if (b.rolloutPercent !== undefined && (!isInt(b.rolloutPercent) || b.rolloutPercent < 0 || b.rolloutPercent > 100)) {
    throw bad("VALIDATION_ERROR", "rolloutPercent must be an integer 0-100");
  }
  if (b.rules !== undefined) {
    if (!Array.isArray(b.rules)) throw bad("VALIDATION_ERROR", "rules must be an array");
    b.rules.forEach(validateRule);
  }
  if (b.variants !== undefined) validateVariants(b.variants);
  return b;
}

// ----------------------------------------------------------- evaluation

const same = (a, b) => typeof a === typeof b && a === b;
function fnv1a32(input) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(input, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const bucket = (flagKey, salt, userId) => fnv1a32(`${flagKey}:${salt}:${userId}`) % 10000;

function ruleMatches(rule, attrs) {
  if (!attrs || !Object.hasOwn(attrs, rule.attribute)) return false;
  const got = attrs[rule.attribute];
  switch (rule.operator) {
    case "eq": return same(got, rule.value);
    case "neq": return !same(got, rule.value);
    case "in": return rule.value.some((v) => same(got, v));
    default: return !rule.value.some((v) => same(got, v));
  }
}

function evaluate(flag, ctx) {
  const off = (reason) => ({ enabled: false, variant: null, reason });
  if (!flag) return off("FLAG_NOT_FOUND");
  if (!flag.enabled) return off("DISABLED");
  if (!flag.rules.every((r) => ruleMatches(r, ctx.attributes))) return off("TARGETING_MISS");
  const userId = ctx.userId ?? "";
  if ((flag.rolloutPercent < 100 || flag.variants.length > 0) && userId === "") return off("MISSING_USER_ID");
  if (flag.rolloutPercent < 100 && bucket(flag.key, "rollout", userId) >= flag.rolloutPercent * 100) return off("NOT_IN_ROLLOUT");
  if (flag.variants.length === 0) return { enabled: true, variant: null, reason: "ON" };
  const b = bucket(flag.key, "variant", userId);
  let threshold = 0;
  for (const v of flag.variants) {
    threshold += v.weight * 100;
    if (b < threshold) return { enabled: true, variant: v.key, reason: "VARIANT" };
  }
  return off("DISABLED"); // unreachable when weights sum to 100
}

function parseEvaluate(b) {
  if (!isObj(b)) throw bad("VALIDATION_ERROR", "body must be an object");
  if (b.flags !== undefined && (!Array.isArray(b.flags) || !b.flags.every((k) => typeof k === "string"))) {
    throw bad("VALIDATION_ERROR", "flags must be an array of strings");
  }
  const ctx = b.context ?? {};
  if (!isObj(ctx)) throw bad("VALIDATION_ERROR", "context must be an object");
  if (ctx.userId !== undefined && typeof ctx.userId !== "string") throw bad("VALIDATION_ERROR", "userId must be a string");
  if (ctx.attributes !== undefined) {
    if (!isObj(ctx.attributes) || !Object.values(ctx.attributes).every(isScalar)) {
      throw bad("VALIDATION_ERROR", "attributes must be an object of scalars");
    }
  }
  return { keys: b.flags, ctx };
}

// -------------------------------------------------------------- events

const nonEmpty = (v) => typeof v === "string" && v !== "";

function validateEvent(e) {
  if (!isObj(e)) throw bad("VALIDATION_ERROR", "event must be an object");
  if (e.type !== "exposure" && e.type !== "conversion") throw bad("VALIDATION_ERROR", "event.type");
  if (!nonEmpty(e.userId)) throw bad("VALIDATION_ERROR", "event.userId");
  if (e.type === "exposure" && (!nonEmpty(e.flagKey) || !nonEmpty(e.variant))) throw bad("VALIDATION_ERROR", "exposure needs flagKey and variant");
  if (e.type === "conversion" && !nonEmpty(e.goal)) throw bad("VALIDATION_ERROR", "conversion needs goal");
  if (e.timestamp !== undefined && (typeof e.timestamp !== "string" || !validTimestamp(e.timestamp))) {
    throw bad("VALIDATION_ERROR", "event.timestamp must be RFC 3339");
  }
}

// erfc via Abramowitz-Stegun 7.1.26 style rational approximation (|err| < 1.5e-7)
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * x);
  const y = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return y;
}

function results(flag, goal) {
  const rows = flag.variants.map((v) => {
    let exposed = 0;
    let converted = 0;
    for (const [k, variant] of exposures) {
      const [fk, user] = k.split("\0");
      if (fk !== flag.key || variant !== v.key) continue;
      exposed++;
      if (conversions.has(`${goal}\0${user}`)) converted++;
    }
    return { variant: v.key, exposures: exposed, conversions: converted, rate: exposed ? converted / exposed : 0, pValue: null, significant: false };
  });
  const [c, ...rest] = rows;
  for (const t of rest) {
    if (c.exposures < 30 || t.exposures < 30) continue;
    const pooled = (c.conversions + t.conversions) / (c.exposures + t.exposures);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / c.exposures + 1 / t.exposures));
    if (se === 0) continue;
    t.pValue = erfc(Math.abs((t.rate - c.rate) / se) / Math.SQRT2);
    t.significant = t.pValue < 0.05;
  }
  return { flagKey: flag.key, goal, variants: rows };
}

// -------------------------------------------------------------- routes

function record(flagKey, action, before, after) {
  audit.push({ id: audit.length + 1, flagKey, action, before: before && clone(before), after: after && clone(after), createdAt: now() });
}

function build(input, existing) {
  const t = now();
  return {
    key: input.key,
    description: input.description ?? "",
    enabled: input.enabled ?? false,
    rules: input.rules ?? [],
    rolloutPercent: input.rolloutPercent ?? 100,
    variants: input.variants ?? [],
    createdAt: existing?.createdAt ?? t,
    updatedAt: t,
  };
}

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const m = req.method;
  // "%zz" is not a path at all (a well-formed "%FF" is: it is a key nobody has, BR-55)
  if (/%(?![0-9A-Fa-f]{2})/.test(url.pathname)) throw bad("VALIDATION_ERROR", "malformed request");
  // "/v1/flags/" is not "/v1/flags": a trailing slash makes it a different, non-existent route.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) throw new HttpError(404, "FLAG_NOT_FOUND", "no such route");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/healthz" && m === "GET") return send(res, 200, { status: "ok" });

  if (parts[0] !== "v1") throw new HttpError(404, "FLAG_NOT_FOUND", "no such route");

  // ---- evaluate
  if (parts[1] === "evaluate" && parts.length === 2 && m === "POST") {
    authorize(req, { adminOnly: false });
    const { keys, ctx } = parseEvaluate(await readJson(req));
    // No prototype: the client chooses these names, and out["__proto__"] = x on a plain object would
    // replace its prototype instead of adding an entry.
    const out = Object.create(null);
    for (const k of keys ?? [...flags.keys()]) out[k] = evaluate(flags.get(k), ctx);
    return send(res, 200, { results: out });
  }

  // ---- events
  if (parts[1] === "events" && parts.length === 2 && m === "POST") {
    authorize(req, { adminOnly: false });
    const b = await readJson(req);
    if (!isObj(b) || !Array.isArray(b.events) || b.events.length < 1 || b.events.length > 100) {
      throw bad("VALIDATION_ERROR", "events must be an array of 1-100");
    }
    b.events.forEach(validateEvent);
    for (const e of b.events) {
      if (e.type === "exposure") {
        const k = `${e.flagKey}\0${e.userId}`;
        if (BUG === "exposure-last-wins" || !exposures.has(k)) exposures.set(k, e.variant);
      } else {
        conversions.add(`${e.goal}\0${e.userId}`);
      }
    }
    return send(res, 202, { accepted: b.events.length });
  }

  // ---- admin API: a request is authenticated only once it matches a real admin route (BR-53)
  const isAdminRoute =
    (parts[1] === "audit-logs" && parts.length === 2 && m === "GET") ||
    (parts[1] === "flags" && parts.length === 2 && (m === "GET" || m === "POST")) ||
    (parts[1] === "flags" && parts[3] === "results" && parts.length === 4 && m === "GET") ||
    (parts[1] === "flags" && parts.length === 3 && ["GET", "PUT", "DELETE"].includes(m));
  if (!isAdminRoute) throw new HttpError(404, "FLAG_NOT_FOUND", "no such route");
  authorize(req, { adminOnly: true });

  if (parts[1] === "audit-logs" && parts.length === 2 && m === "GET") {
    const { limit, offset } = page(url);
    const fk = url.searchParams.get("flagKey");
    const all = audit.filter((a) => fk === null || a.flagKey === fk).reverse();
    return send(res, 200, { items: all.slice(offset, offset + limit), total: all.length });
  }

  if (parts[1] === "flags" && parts.length === 2) {
    if (m === "GET") {
      const { limit, offset } = page(url);
      const all = [...flags.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return send(res, 200, { items: all.slice(offset, offset + limit), total: all.length });
    }
    if (m === "POST") {
      const input = parseFlagInput(await readJson(req));
      if (flags.has(input.key)) throw new HttpError(409, "FLAG_EXISTS", "flag already exists");
      const flag = build(input);
      flags.set(flag.key, flag);
      record(flag.key, "create", null, flag);
      return send(res, 201, flag);
    }
  }

  if (parts[1] === "flags" && parts[3] === "results" && parts.length === 4 && m === "GET") {
    const goal = url.searchParams.get("goal");
    if (!nonEmpty(goal)) throw bad("VALIDATION_ERROR", "goal is required");
    const flag = flags.get(decodeKey(parts[2]));
    if (!flag) throw new HttpError(404, "FLAG_NOT_FOUND", "flag not found");
    return send(res, 200, results(flag, goal));
  }

  if (parts[1] === "flags" && parts.length === 3) {
    const key = decodeKey(parts[2]);
    if (m === "GET") {
      const f = flags.get(key);
      if (!f) throw new HttpError(404, "FLAG_NOT_FOUND", "flag not found");
      return send(res, 200, f);
    }
    if (m === "PUT") {
      const input = parseFlagInput(await readJson(req));
      if (input.key !== key) throw bad("KEY_IMMUTABLE", "key cannot change");
      const old = flags.get(key);
      if (!old) throw new HttpError(404, "FLAG_NOT_FOUND", "flag not found");
      const merged = BUG === "put-merges" ? { ...old, ...input } : input;
      const flag = build(merged, old);
      flags.set(key, flag);
      record(key, "update", old, flag);
      return send(res, 200, flag);
    }
    if (m === "DELETE") {
      const old = flags.get(key);
      if (!old) throw new HttpError(404, "FLAG_NOT_FOUND", "flag not found");
      flags.delete(key);
      if (BUG !== "no-audit-on-delete") record(key, "delete", old, null);
      return send(res, 204);
    }
  }

  throw new HttpError(404, "FLAG_NOT_FOUND", "no such route");
}

// CORS (BR-56): only the two client endpoints, only for an allowed Origin; everything else is untouched.
const CORS_PATHS = new Set(["/v1/evaluate", "/v1/events"]);
function cors(req, res) {
  const origin = req.headers.origin;
  const onClientPath = CORS_PATHS.has(req.url.split("?")[0]) || (BUG === "cors-everywhere" && req.url.startsWith("/v1/"));
  if (CORS.length === 0 || !origin || !onClientPath) return false;
  const star = CORS.includes("*");
  if (!star && !CORS.includes(origin)) return false;
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-origin", star ? "*" : origin);
    if (!star) res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "POST");
    res.setHeader("access-control-allow-headers", "Content-Type, X-Client-Key");
    res.setHeader("access-control-max-age", "600");
    res.writeHead(204).end();
    return true;
  }
  if (req.method === "POST" || (BUG === "cors-everywhere" && req.method === "GET")) {
    res.setHeader("access-control-allow-origin", star ? "*" : origin);
    if (!star && BUG !== "cors-no-vary") res.setHeader("vary", "Origin");
  }
  return false;
}

http
  .createServer((req, res) => {
    if (cors(req, res)) return;
    route(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      console.error(err);
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal error" } });
    });
  })
  .listen(PORT, () => console.log(`mock contract server on :${PORT}${BUG ? ` (MOCK_BUG=${BUG})` : ""}`));
