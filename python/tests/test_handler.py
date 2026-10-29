"""The HTTP layer, driven through ASGI directly (no network, no extra dependency)."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import unquote

import pytest

from app.handler import MAX_BODY_BYTES, create_app
from app.repository import SqliteRepository
from app.service import Service

ADMIN, CLIENT = "test-admin-key", "test-client-key"


class Response:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status, self.headers, self.body = status, headers, body

    @property
    def text(self) -> str:
        return self.body.decode()

    @property
    def json(self) -> Any:
        return json.loads(self.body)

    @property
    def code(self) -> str:
        return self.json["error"]["code"]


def send(
    app, method: str, target: str, body: bytes | str = b"", auth: str = "admin", headers: dict[str, bytes] | None = None
) -> Response:
    raw_path, _, query = target.partition("?")
    payload = body.encode() if isinstance(body, str) else body
    all_headers: dict[str, bytes] = {}
    if auth == "admin":
        all_headers["x-admin-key"] = ADMIN.encode()
    elif auth == "client":
        all_headers["x-client-key"] = CLIENT.encode()
    elif auth == "bad":
        all_headers.update({"x-admin-key": b"wrong", "x-client-key": b"wrong"})
    all_headers.update(headers or {})
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": unquote(raw_path),
        "raw_path": raw_path.encode(),
        "query_string": query.encode(),
        "root_path": "",
        "headers": [(k.encode(), v) for k, v in all_headers.items()],
        "client": ("test", 1),
        "server": ("test", 80),
    }
    chunks = [payload[i : i + 65536] for i in range(0, len(payload), 65536)] or [b""]
    out: dict[str, Any] = {"status": 0, "headers": {}, "body": b""}

    async def receive() -> dict[str, Any]:
        if chunks:
            chunk = chunks.pop(0)
            return {"type": "http.request", "body": chunk, "more_body": bool(chunks)}
        return {"type": "http.disconnect"}

    async def emit(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
            out["headers"] = {k.decode(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            out["body"] += message.get("body", b"")

    asyncio.run(app(scope, receive, emit))
    return Response(out["status"], out["headers"], out["body"])


@pytest.fixture
def app(repo: SqliteRepository):
    return create_app(Service(repo), ADMIN, CLIENT)


def test_both_keys_are_required(repo: SqliteRepository) -> None:
    service = Service(repo)
    for admin, client in (("", "c"), ("a", ""), ("", "")):
        with pytest.raises(ValueError, match="both"):
            create_app(service, admin, client)


def test_br13_healthz_needs_no_key(app) -> None:
    r = send(app, "GET", "/healthz", auth="none")
    assert (r.status, r.json) == (200, {"status": "ok"})


def test_br10_br12_admin_endpoints_accept_only_the_admin_key(app) -> None:
    for method, path in (
        ("GET", "/v1/flags"),
        ("POST", "/v1/flags"),
        ("GET", "/v1/flags/x"),
        ("PUT", "/v1/flags/x"),
        ("DELETE", "/v1/flags/x"),
        ("GET", "/v1/flags/x/results?goal=g"),
        ("GET", "/v1/audit-logs"),
    ):
        assert (
            send(app, method, path, "{}", auth="none").status,
            send(app, method, path, "{}", auth="bad").status,
        ) == (401, 401), path
        r = send(app, method, path, "{}", auth="client")
        assert (r.status, r.code) == (403, "FORBIDDEN"), path
        assert send(app, method, path, "{}", auth="none").code == "UNAUTHORIZED"


def test_br11_client_endpoints_accept_either_key(app) -> None:
    for path, body in (
        ("/v1/evaluate", "{}"),
        ("/v1/events", '{"events":[{"type":"conversion","userId":"u","goal":"g"}]}'),
    ):
        assert send(app, "POST", path, body, auth="admin").status in (200, 202)
        assert send(app, "POST", path, body, auth="client").status in (200, 202)
        assert send(app, "POST", path, body, auth="none").status == 401
        assert send(app, "POST", path, body, auth="bad").status == 401


def test_br51_auth_is_checked_before_the_body_is_read(app) -> None:
    assert send(app, "POST", "/v1/flags", "not json", auth="none").status == 401
    assert send(app, "POST", "/v1/flags", "not json", auth="client").status == 403
    assert send(app, "POST", "/v1/flags", "not json").status == 400


def test_non_ascii_key_headers_are_a_wrong_key_not_a_crash(app) -> None:
    for value in ("café".encode("latin-1"), b"\xff\xfe", b"a" * 5000):
        r = send(app, "GET", "/v1/flags", auth="none", headers={"x-admin-key": value})
        assert (r.status, r.code) == (401, "UNAUTHORIZED")
    r = send(app, "GET", "/v1/flags", auth="none", headers={"x-admin-key": ADMIN.encode(), "x-client-key": b"\xe9"})
    assert r.status == 200


def test_status_codes_and_content_type_of_the_happy_path(app) -> None:
    r = send(app, "POST", "/v1/flags", '{"key":"f","enabled":true}')
    assert (r.status, r.headers["content-type"]) == (201, "application/json")
    assert r.json["key"] == "f"
    assert send(app, "GET", "/v1/flags/f").status == 200
    assert send(app, "PUT", "/v1/flags/f", '{"key":"f"}').status == 200
    assert send(app, "GET", "/v1/flags").json["total"] == 1
    assert send(app, "GET", "/v1/audit-logs?flagKey=f").json["total"] == 2
    assert (
        send(app, "POST", "/v1/evaluate", '{"flags":["f"]}', auth="client").json["results"]["f"]["reason"] == "DISABLED"
    )
    assert send(
        app, "POST", "/v1/events", '{"events":[{"type":"conversion","userId":"u","goal":"g"}]}', auth="client"
    ).json == {"accepted": 1}
    d = send(app, "DELETE", "/v1/flags/f")
    assert (d.status, d.body) == (204, b"")
    assert send(app, "GET", "/v1/flags/f").code == "FLAG_NOT_FOUND"


@pytest.mark.parametrize(
    "body",
    [
        "",
        '{"key":"x","unknown":NaN}',
        '{"key":"x","unknown":Infinity}',
        '{"key":"x","unknown":-Infinity}',
        "   ",
        "{",
        "[",
        '{"key":"x"} {"key":"y"}',
        '{"key":"x"} x',
        '{"key":"x"},',
        "NaN",
        '{"key":"x","rolloutPercent":NaN}',
        '{"key":"x","rolloutPercent":Infinity}',
        '{"key":"x","rolloutPercent":-Infinity}',
        '{"key":"x","rolloutPercent":01}',
        '{"key":"x","rolloutPercent":.5}',
        '{"key":"x","rolloutPercent":1.}',
        '{"key":"x","rolloutPercent":+1}',
        '{"key":"x",}',
        "{'key':'x'}",
        '{"key":"x"} // c',
        '{"key":"a\nb"}',
        '﻿{"key":"x"}',
        '{"key":"x"}\x00',
        "[" * 100000,
        '{"a":' * 50000,
        '{"key":"x","rolloutPercent":1' + "0" * 5000 + "}",
    ],
)
def test_br52_bodies_that_are_not_one_json_value_are_validation_errors(app, body: str) -> None:
    r = send(app, "POST", "/v1/flags", body)
    assert (r.status, r.code) == (400, "VALIDATION_ERROR"), body[:40]


@pytest.mark.parametrize(
    "body",
    [
        b'{"key":"x","description":"\xff"}',
        b'{"key":"x","description":"\xc3("}',
        b'{"key":"x","description":"\xed\xa0\x80"}',
        b'{"key":"x","description":"\xc0\xaf"}',
        '{"key":"x"}'.encode("utf-16"),
        '{"key":"x"}'.encode("utf-16-le"),
    ],
)
def test_br52_invalid_utf8_and_utf16_are_rejected_not_repaired(app, body: bytes) -> None:
    r = send(app, "POST", "/v1/flags", body)
    assert (r.status, r.code) == (400, "VALIDATION_ERROR")
    assert send(app, "GET", "/v1/flags/x").status == 404


def test_br52_duplicate_keys_last_wins_and_content_type_is_ignored(app) -> None:
    r = send(app, "POST", "/v1/flags", '{"key":"first","key":"second"}', headers={"content-type": b"text/plain"})
    assert (r.status, r.json["key"]) == (201, "second")
    assert (
        send(
            app, "POST", "/v1/flags", '{"key":"third"}', headers={"content-type": b"application/x-www-form-urlencoded"}
        ).status
        == 201
    )
    assert send(app, "POST", "/v1/flags", '{"key":"fourth"}').status == 201


def test_br52_an_oversized_body_is_rejected_not_crashed(app) -> None:
    padding = " " * (MAX_BODY_BYTES + 1)
    r = send(app, "POST", "/v1/flags", '{"key":"big"}' + padding)
    assert (r.status, r.code) == (400, "VALIDATION_ERROR")
    assert send(app, "POST", "/v1/flags", '{"key":"fits"}' + " " * (MAX_BODY_BYTES - 20)).status == 201


def test_br54_lone_surrogates_are_never_a_server_error(app) -> None:
    replacement = send(app, "POST", "/v1/evaluate", '{"flags":["f"],"context":{"userId":"\\ufffd"}}', auth="client")
    send(
        app,
        "POST",
        "/v1/flags",
        '{"key":"f","enabled":true,"variants":[{"key":"a","weight":50},{"key":"b","weight":50}]}',
    )
    replacement = send(app, "POST", "/v1/evaluate", '{"flags":["f"],"context":{"userId":"\\ufffd"}}', auth="client")
    for lone in ("\\ud800", "\\udc00", "\\ud83d"):
        r = send(app, "POST", "/v1/evaluate", '{"flags":["f"],"context":{"userId":"' + lone + '"}}', auth="client")
        assert r.status == 200
        assert r.json == replacement.json
    created = send(app, "POST", "/v1/flags", '{"key":"g","description":"\\ud800"}')
    assert created.status == 201
    assert send(app, "GET", "/v1/flags/g").json["description"] == "�"
    assert send(app, "GET", "/v1/flags?limit=100").status == 200


@pytest.mark.parametrize("key", ["%FF", "%C3%28", "%ED%A0%80", "%C0%AF", "%00", "%7F", "a%FFb", "%F0%9F%98"])
def test_br55_a_path_key_that_is_not_utf8_is_just_not_found(app, key: str) -> None:
    for method in ("GET", "DELETE"):
        r = send(app, method, f"/v1/flags/{key}")
        assert (r.status, r.code) == (404, "FLAG_NOT_FOUND"), (method, key)
    assert send(app, "GET", f"/v1/flags/{key}/results?goal=g").code == "FLAG_NOT_FOUND"


def test_a_broken_percent_escape_is_a_400_not_a_404(app) -> None:
    for target in ("/v1/flags/%zz", "/v1/flags/a%", "/v1/flags/%4"):
        r = send(app, "GET", target)
        assert (r.status, r.code) == (400, "VALIDATION_ERROR"), target


def test_br53_unknown_routes_answer_with_a_json_error_body_and_need_no_key(app) -> None:
    for method, path in (
        ("GET", "/nope"),
        ("GET", "/v1"),
        ("GET", "/v1/flags/"),
        ("GET", "/v1/flags/a/b"),
        ("PATCH", "/v1/flags"),
        ("POST", "/healthz"),
        ("GET", "/docs"),
        ("GET", "/openapi.json"),
        ("OPTIONS", "/v1/flags"),
        ("GET", "/v1/evaluate"),
        ("DELETE", "/v1/flags"),
    ):
        r = send(app, method, path, auth="none")
        assert (r.status, r.code) == (404, "FLAG_NOT_FOUND"), (method, path)
        assert r.headers["content-type"] == "application/json"


def test_br50_the_first_value_of_a_repeated_query_parameter_counts(app) -> None:
    for key in ("a", "b", "c"):
        send(app, "POST", "/v1/flags", '{"key":"' + key + '"}')
    r = send(app, "GET", "/v1/flags?limit=1&limit=100")
    assert len(r.json["items"]) == 1
    assert send(app, "GET", "/v1/flags?limit=100&limit=abc").status == 200
    assert send(app, "GET", "/v1/flags?limit=abc&limit=1").status == 400
    assert send(app, "GET", "/v1/flags?limit=%zz").status == 200  # a pair with a bad escape is ignored, as in net/url
    assert send(app, "GET", "/v1/flags?limit=2&offset=1").json["total"] == 3


def test_every_error_code_maps_to_its_status(app) -> None:
    send(app, "POST", "/v1/flags", '{"key":"f"}')
    cases = [
        (("POST", "/v1/flags", '{"key":"f"}'), 409, "FLAG_EXISTS"),
        (("POST", "/v1/flags", '{"key":"BAD"}'), 400, "INVALID_KEY"),
        (("PUT", "/v1/flags/f", '{"key":"g"}'), 400, "KEY_IMMUTABLE"),
        (("POST", "/v1/flags", '{"key":"x","variants":[{"key":"a","weight":100}]}'), 400, "INVALID_VARIANTS"),
        (("POST", "/v1/flags", "[]"), 400, "VALIDATION_ERROR"),
        (("GET", "/v1/flags/ghost", ""), 404, "FLAG_NOT_FOUND"),
        (("GET", "/v1/flags/f/results", ""), 400, "VALIDATION_ERROR"),
        (("GET", "/v1/flags/f/results?goal=", ""), 400, "VALIDATION_ERROR"),
    ]
    for (method, path, body), status, code in cases:
        r = send(app, method, path, body)
        assert (r.status, r.code) == (status, code), (method, path)
        assert isinstance(r.json["error"]["message"], str)


def test_an_unexpected_error_becomes_an_opaque_500(caplog: pytest.LogCaptureFixture) -> None:
    class Exploding:
        def __getattr__(self, name: str) -> Any:
            raise RuntimeError("secret internal detail")

    app = create_app(Exploding(), ADMIN, CLIENT)  # type: ignore[arg-type]
    with caplog.at_level("ERROR", logger="ffservice"):
        r = send(app, "GET", "/v1/flags")
    assert (r.status, r.code) == (500, "INTERNAL_ERROR")
    assert "secret" not in r.text
    assert "secret internal detail" in caplog.text


def test_an_encoded_slash_is_part_of_the_key_not_a_path_separator(app) -> None:
    # Go matches /v1/flags/{key} with the key "a/b"; a router fed the decoded path would not match at all.
    assert send(app, "GET", "/v1/flags/a%2Fb", auth="none").status == 401
    assert send(app, "GET", "/v1/flags/a%2Fb", auth="client").status == 403
    assert send(app, "GET", "/v1/flags/a%2fb").code == "FLAG_NOT_FOUND"
    assert send(app, "DELETE", "/v1/flags/a%2Fb").code == "FLAG_NOT_FOUND"
    assert send(app, "GET", "/v1/flags/a%2Fb/results?goal=g").code == "FLAG_NOT_FOUND"
    r = send(app, "PUT", "/v1/flags/a%2Fb", '{"key":"a/b"}')
    assert (r.status, r.code) == (400, "INVALID_KEY")  # the body is validated before the path key is compared
    r = send(app, "PUT", "/v1/flags/a%2Fb", '{"key":"ab"}')
    assert (r.status, r.code) == (400, "KEY_IMMUTABLE")
    assert send(app, "GET", "/v1/flags/a/b").code == "FLAG_NOT_FOUND"  # a real extra segment is no route
    assert send(app, "GET", "/v1/flags/a%252Fb").code == "FLAG_NOT_FOUND"
