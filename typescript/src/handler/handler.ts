// The HTTP layer: routing, authentication, JSON in and out, and the mapping from ServiceError to
// status codes. It holds no business rules.
//
// Fastify's defaults contradict the spec in several places (see docs/porting/typescript-analysis.md,
// section 4, every row verified by experiment). Each override below names the rule it serves.
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ServiceError, validationError } from "../service/errors.js";
import type { ErrorCode } from "../service/errors.js";
import { parsePage } from "../service/parse.js";
import type { Service } from "../service/service.js";

/** BR-52: a request body may be at most 1 MiB. */
export const MAX_BODY_BYTES = 1024 * 1024;

type Code = ErrorCode | "INTERNAL_ERROR";

export interface HandlerConfig {
  adminKey: string;
  clientKey: string;
  /** BR-56: origins that may call evaluate and events from a browser; "*" allows all; none (default) turns CORS off. */
  corsOrigins?: readonly string[];
  /** Called with unexpected failures, which are never shown to the client. Defaults to console.error. */
  logError?: (message: string, error: unknown) => void;
}

const errorBody = (code: Code, message: string) => ({ error: { code, message } });

type ErrorStatus = 400 | 401 | 403 | 404 | 409;

/** Every code that is not listed is a validation problem, which is a 400. */
function statusFor(code: ErrorCode): ErrorStatus {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "FLAG_NOT_FOUND":
      return 404;
    case "FLAG_EXISTS":
      return 409;
    default:
      return 400;
  }
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

export function buildApp(svc: Service, cfg: HandlerConfig): FastifyInstance {
  if (cfg.adminKey === "" || cfg.clientKey === "") throw new Error("both an admin key and a client key are required");
  const logError = cfg.logError ?? ((message: string, error: unknown) => console.error(message, error));

  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BODY_BYTES,
    // Fastify answers 400 when a path parameter is longer than 100 characters. A flag key that long
    // is simply not found (BR-05), so lift the limit to what the HTTP parser itself allows (16 KiB).
    routerOptions: { maxParamLength: 16384 },
    // Errors Fastify raises before routing (for example a malformed percent-escape in the URL) would
    // otherwise bypass setErrorHandler and use Fastify's own response shape.
    // (The cast: the reply type of this callback is a generic that does not accept a plain status code.)
    frameworkErrors: (_error, request, reply) => {
      // BR-55: "%FF" is a well-formed escape that decodes to bytes which are not UTF-8: no flag has
      // such a key, so it is a 404. A broken escape such as "%zz" or a trailing "%" is a 400.
      const path = request.url.split("?")[0] ?? "";
      if (!/%(?![0-9A-Fa-f]{2})/.test(path)) return (reply as FastifyReply).code(404).send(errorBody("FLAG_NOT_FOUND", "flag not found"));
      return (reply as FastifyReply).code(400).send(errorBody("VALIDATION_ERROR", "malformed request"));
    },
  });

  // BR-52: the body is always read as JSON, whatever the Content-Type says. By default Fastify
  // answers 415 for form content types or a missing one, hands text/plain through as a raw string,
  // and rejects any body containing a "__proto__" key. Our own parser has none of those behaviours.
  app.removeAllContentTypeParsers();
  // fatal: invalid UTF-8 is an error, not U+FFFD. ignoreBOM: keep a BOM so that JSON.parse rejects it.
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    try {
      done(null, JSON.parse(utf8.decode(body as Buffer))); // JSON.parse rejects anything after the first value
    } catch {
      done(validationError("request body must be valid JSON"));
    }
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ServiceError) return reply.code(statusFor(error.code)).send(errorBody(error.code, error.message));
    const status = (error as Partial<FastifyError>).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      // 413 for a body over the limit, among others: the spec asks for 400 (BR-52).
      const tooLarge = (error as Partial<FastifyError>).code === "FST_ERR_CTP_BODY_TOO_LARGE";
      return reply.code(400).send(errorBody("VALIDATION_ERROR", tooLarge ? "request body is larger than 1 MiB" : "malformed request"));
    }
    logError("unexpected error", error);
    return reply.code(500).send(errorBody("INTERNAL_ERROR", "internal error")); // no details for the client
  });

  // BR-53: a route that does not exist answers in our error shape, not Fastify's.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(errorBody("FLAG_NOT_FOUND", "no such route")));

  // BR-56: CORS only for POST /v1/evaluate and /v1/events and only for an allowed Origin. A preflight is
  // answered here without a key; every other request goes on untouched.
  const corsOrigins = cfg.corsOrigins ?? [];
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const path = request.url.split("?")[0];
    if (origin === undefined || (path !== "/v1/evaluate" && path !== "/v1/events")) return;
    if (request.method !== "OPTIONS" && request.method !== "POST") return;
    const allow = corsOrigins.includes("*") ? "*" : corsOrigins.includes(origin) ? origin : undefined;
    if (allow === undefined) return;
    void reply.header("access-control-allow-origin", allow);
    if (allow !== "*") void reply.header("vary", "Origin");
    if (request.method === "OPTIONS") {
      void reply.header("access-control-allow-methods", "POST");
      void reply.header("access-control-allow-headers", "Content-Type, X-Client-Key");
      void reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }
  });

  // ------------------------------------------------------------------ auth

  const adminKey = sha256(cfg.adminKey);
  const clientKey = sha256(cfg.clientKey);
  // Compare digests: always the same length, and constant time.
  const matches = (header: unknown, expected: Buffer): boolean => timingSafeEqual(sha256(typeof header === "string" ? header : ""), expected);
  const isAdmin = (r: FastifyRequest): boolean => matches(r.headers["x-admin-key"], adminKey);
  const isClient = (r: FastifyRequest): boolean => matches(r.headers["x-client-key"], clientKey);

  // These are onRequest hooks, which run before the body is read: a request without a valid key
  // is rejected even if its body is malformed (BR-51).

  /** BR-10, BR-12: only the admin key. A valid client key is known but not allowed here: 403. */
  const adminOnly = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (isAdmin(request)) return undefined;
    if (isClient(request)) return reply.code(403).send(errorBody("FORBIDDEN", "this key cannot use the admin API"));
    return reply.code(401).send(errorBody("UNAUTHORIZED", "missing or invalid admin key"));
  };

  /** BR-11: either key. */
  const clientOrAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (isAdmin(request) || isClient(request)) return undefined;
    return reply.code(401).send(errorBody("UNAUTHORIZED", "missing or invalid key"));
  };

  // --------------------------------------------------------------- helpers

  /** req.body is undefined when no body was sent at all, which the parser never sees. */
  const bodyOf = (request: FastifyRequest): unknown => {
    if (request.body === undefined) throw validationError("request body must be valid JSON");
    return request.body;
  };

  /** The query string as the spec reads it: repeated parameters give their first value (BR-50). */
  const queryOf = (request: FastifyRequest): URLSearchParams => new URL(request.url, "http://localhost").searchParams;

  const keyOf = (request: FastifyRequest): string => (request.params as { key: string }).key;

  /**
   * Fastify matches "/v1/flags/" with the route "/v1/flags/:key" and an empty key, where Go's
   * "{key}" needs at least one character. There is no such route (BR-53): answer before the auth
   * hook can turn it into a 401.
   */
  const nonEmptyKey = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> =>
    keyOf(request) === "" ? reply.code(404).send(errorBody("FLAG_NOT_FOUND", "no such route")) : undefined;

  // ------------------------------------------------------------- endpoints

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/v1/flags", { onRequest: adminOnly }, async (request) => {
    const { limit, offset } = parsePage(queryOf(request));
    return svc.listFlags(limit, offset);
  });

  app.post("/v1/flags", { onRequest: adminOnly }, async (request, reply) => reply.code(201).send(svc.createFlag(bodyOf(request))));

  app.get("/v1/flags/:key", { onRequest: [nonEmptyKey, adminOnly] }, async (request) => svc.getFlag(keyOf(request)));

  app.put("/v1/flags/:key", { onRequest: [nonEmptyKey, adminOnly] }, async (request) => svc.updateFlag(keyOf(request), bodyOf(request)));

  app.delete("/v1/flags/:key", { onRequest: [nonEmptyKey, adminOnly] }, async (request, reply) => {
    svc.deleteFlag(keyOf(request));
    return reply.code(204).send();
  });

  app.get("/v1/flags/:key/results", { onRequest: [nonEmptyKey, adminOnly] }, async (request) => svc.results(keyOf(request), queryOf(request).get("goal") ?? ""));

  app.get("/v1/audit-logs", { onRequest: adminOnly }, async (request) => {
    const params = queryOf(request);
    const { limit, offset } = parsePage(params);
    return svc.listAudit(params.has("flagKey") ? (params.get("flagKey") ?? "") : undefined, limit, offset);
  });

  // Object.fromEntries defines own properties, so a flag name such as "__proto__" stays a key.
  app.post("/v1/evaluate", { onRequest: clientOrAdmin }, async (request) => ({ results: Object.fromEntries(svc.evaluate(bodyOf(request))) }));

  app.post("/v1/events", { onRequest: clientOrAdmin }, async (request, reply) => reply.code(202).send({ accepted: svc.recordEvents(bodyOf(request)) }));

  return app;
}
