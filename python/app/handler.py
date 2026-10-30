"""HTTP: routing, authentication, JSON in and out, and the mapping from service errors to status codes.

It holds no business rules. FastAPI is used for routing and the ASGI plumbing only: every body is read
and parsed by hand, because the spec (BR-52) wants behaviour that FastAPI's own request validation does
not give: any Content-Type, strict RFC 8259 JSON, valid UTF-8, one value, and an error in our own shape.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from collections.abc import Sequence
from typing import Any
from urllib.parse import unquote_to_bytes

from fastapi import FastAPI, Request, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.errors import (
    CODE_FLAG_NOT_FOUND,
    CODE_FORBIDDEN,
    CODE_INTERNAL,
    CODE_UNAUTHORIZED,
    CODE_VALIDATION,
    ServiceError,
    validation_error,
)
from app.model import format_time
from app.parse import clean, parse_page
from app.service import Service

MAX_BODY_BYTES = 1 << 20

log = logging.getLogger("ffservice")

_STATUS = {"UNAUTHORIZED": 401, "FORBIDDEN": 403, "FLAG_NOT_FOUND": 404, "FLAG_EXISTS": 409}
_BROKEN_ESCAPE = re.compile(rb"%(?![0-9A-Fa-f]{2})")


def _json_response(status: int, body: Any) -> Response:
    # ensure_ascii (the default) writes every non-ASCII character as an escape, so the response is pure ASCII
    # and cannot fail on a character that has no UTF-8 encoding.
    return Response(
        json.dumps(body, separators=(",", ":")).encode("ascii"), status_code=status, media_type="application/json"
    )


def _error_response(status: int, code: str, message: str) -> Response:
    return _json_response(status, {"error": {"code": code, "message": message}})


_SLASH_STAND_IN = "\ue000"


def _route_path(raw_path: bytes) -> str:
    """The path the router sees. The ASGI server has already turned "%2F" into "/", so /v1/flags/a%2Fb would
    become /v1/flags/a/b and miss the route. Go's router matches /v1/flags/{key} with the key "a/b", so each
    "%2F" is kept as a private-use stand-in character that `_key` turns back into "/"."""
    segments = []
    for segment in raw_path.split(b"/"):
        segment = segment.replace(b"%2F", _SLASH_STAND_IN.encode()).replace(b"%2f", _SLASH_STAND_IN.encode())
        segments.append(unquote_to_bytes(segment).decode("utf-8", "replace"))
    return "/".join(segments)


def _key(path_key: str) -> str:
    return path_key.replace(_SLASH_STAND_IN, "/")


def _digest(value: bytes) -> bytes:
    return hashlib.sha256(value).digest()


def _parse_query(raw: bytes) -> dict[str, list[str]]:
    """Split a query string like Go's net/url: `&` separates pairs, `+` is a space, a pair with a bad escape or
    a `;` is dropped, and a repeated name keeps all its values in order (the first one counts, BR-50)."""
    out: dict[str, list[str]] = {}
    for pair in raw.split(b"&"):
        if not pair or b";" in pair or _BROKEN_ESCAPE.search(pair):
            continue
        name, _, value = pair.partition(b"=")
        decoded = [unquote_to_bytes(part.replace(b"+", b" ")).decode("utf-8", "replace") for part in (name, value)]
        out.setdefault(decoded[0], []).append(decoded[1])
    return out


async def _read_json(request: Request) -> Any:
    """Read the whole body (even an oversized one: answering while the client is still uploading resets the
    connection) and parse it as one strict JSON value (BR-52)."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size <= MAX_BODY_BYTES:
            chunks.append(chunk)
    if size > MAX_BODY_BYTES:
        raise validation_error("request body is larger than 1 MiB")
    try:
        text = b"".join(chunks).decode("utf-8")  # strict: invalid UTF-8 (and a CESU-8 surrogate) is an error
        return clean(json.loads(text, parse_constant=_reject_constant))  # a BOM is not valid JSON either
    except (ValueError, RecursionError):  # JSONDecodeError and UnicodeDecodeError are ValueErrors
        raise validation_error("request body must be valid JSON") from None


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")  # json.loads accepts NaN, Infinity and -Infinity by default


_CORS_PATHS = frozenset({b"/v1/evaluate", b"/v1/events"})


def create_app(service: Service, admin_key: str, client_key: str, cors_origins: Sequence[str] = ()) -> FastAPI:
    """Build the HTTP application. Both keys are required (BR-10). cors_origins: BR-56, empty means CORS is off."""
    if not admin_key or not client_key:
        raise ValueError("both an admin key and a client key are required")
    admin_digest, client_digest = _digest(admin_key.encode()), _digest(client_key.encode())

    # Documentation routes off, no redirect from /v1/flags/ to /v1/flags (BR-53: an unknown route is a 404).
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)

    def header_matches(request: Request, name: str, expected: bytes) -> bool:
        # Starlette decodes header bytes as latin-1, so encoding them back is lossless and cannot fail.
        # Comparing digests keeps the comparison constant-time whatever the lengths.
        value = request.headers.get(name, "").encode("latin-1")
        return hmac.compare_digest(_digest(value), expected)

    def require_admin(request: Request) -> None:
        if header_matches(request, "x-admin-key", admin_digest):
            return
        if header_matches(request, "x-client-key", client_digest):
            raise ServiceError(CODE_FORBIDDEN, "this key cannot use the admin API")
        raise ServiceError(CODE_UNAUTHORIZED, "missing or invalid admin key")

    def require_client_or_admin(request: Request) -> None:
        if not (
            header_matches(request, "x-admin-key", admin_digest)
            or header_matches(request, "x-client-key", client_digest)
        ):
            raise ServiceError(CODE_UNAUTHORIZED, "missing or invalid key")

    def cors_headers(request: Request, raw_path: bytes) -> dict[str, str] | None:
        """BR-56: the headers for a POST or preflight on a client endpoint from an allowed Origin, else None."""
        origin = request.headers.get("origin")
        if not origin or raw_path not in _CORS_PATHS or request.method not in ("OPTIONS", "POST"):
            return None
        if "*" in cors_origins:
            return {"access-control-allow-origin": "*"}
        if origin in cors_origins:
            return {"access-control-allow-origin": origin, "vary": "Origin"}
        return None

    @app.middleware("http")
    async def guard(request: Request, call_next: Any) -> Response:
        # "%zz" is not a path at all (400). "%FF" is a well-formed escape for bytes that are not UTF-8: no flag
        # has such a key, so it falls through to the normal 404 (BR-55).
        raw_path = request.scope.get("raw_path") or b""
        if _BROKEN_ESCAPE.search(raw_path):
            return _error_response(400, CODE_VALIDATION, "malformed request")
        if b"%2" in raw_path:
            request.scope["path"] = _route_path(raw_path)
        cors = cors_headers(request, raw_path)
        if cors is not None and request.method == "OPTIONS":  # a preflight is answered here, without a key
            return Response(
                status_code=204,
                headers={
                    **cors,
                    "access-control-allow-methods": "POST",
                    "access-control-allow-headers": "Content-Type, X-Client-Key",
                    "access-control-max-age": "600",
                },
            )
        try:
            response = await call_next(request)
        except Exception as exc:  # anything unexpected is an opaque 500; the details go to the log only
            log.error("internal error serving %s %s: %r", request.method, request.url.path, exc)
            response = _error_response(500, CODE_INTERNAL, "internal error")
        response.headers.update(cors or {})
        return response

    @app.exception_handler(ServiceError)
    async def on_service_error(_request: Request, exc: ServiceError) -> Response:
        return _error_response(_STATUS.get(exc.code, 400), exc.code, exc.message)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_error(_request: Request, _exc: StarletteHTTPException) -> Response:
        # unknown path, or a known path with another method (405): both are "no such route" (BR-53)
        return _error_response(404, CODE_FLAG_NOT_FOUND, "no such route")

    @app.get("/healthz")
    async def healthz() -> Response:
        return _json_response(200, {"status": "ok"})

    @app.get("/v1/flags")
    async def list_flags(request: Request) -> Response:
        require_admin(request)
        limit, offset = parse_page(_parse_query(request.scope["query_string"]))
        flags, total = service.list_flags(limit, offset)
        return _json_response(200, {"items": [f.to_json() for f in flags], "total": total})

    @app.post("/v1/flags")
    async def create_flag(request: Request) -> Response:
        require_admin(request)
        flag = service.create_flag(await _read_json(request))
        return _json_response(201, flag.to_json())

    @app.get("/v1/flags/{key}")
    async def get_flag(key: str, request: Request) -> Response:
        require_admin(request)
        return _json_response(200, service.get_flag(_key(key)).to_json())

    @app.put("/v1/flags/{key}")
    async def update_flag(key: str, request: Request) -> Response:
        require_admin(request)
        return _json_response(200, service.update_flag(_key(key), await _read_json(request)).to_json())

    @app.delete("/v1/flags/{key}")
    async def delete_flag(key: str, request: Request) -> Response:
        require_admin(request)
        service.delete_flag(_key(key))
        return Response(status_code=204)

    @app.get("/v1/flags/{key}/results")
    async def results(key: str, request: Request) -> Response:
        require_admin(request)
        goal = _parse_query(request.scope["query_string"]).get("goal", [""])[0]
        return _json_response(200, service.results(_key(key), goal).to_json())

    @app.get("/v1/audit-logs")
    async def list_audit(request: Request) -> Response:
        require_admin(request)
        query = _parse_query(request.scope["query_string"])
        limit, offset = parse_page(query)
        flag_key = query["flagKey"][0] if "flagKey" in query else None
        logs, total = service.list_audit(flag_key, limit, offset)
        items = [
            {
                "id": a.id,
                "flagKey": a.flag_key,
                "action": a.action,
                "before": json.loads(a.before) if a.before is not None else None,
                "after": json.loads(a.after) if a.after is not None else None,
                "createdAt": format_time(a.created_at),
            }
            for a in logs
        ]
        return _json_response(200, {"items": items, "total": total})

    @app.post("/v1/evaluate")
    async def evaluate(request: Request) -> Response:
        require_client_or_admin(request)
        outcome = service.evaluate(await _read_json(request))
        return _json_response(200, {"results": {key: r.to_json() for key, r in outcome.items()}})

    @app.post("/v1/events")
    async def events(request: Request) -> Response:
        require_client_or_admin(request)
        return _json_response(202, {"accepted": service.record_events(await _read_json(request))})

    return app
