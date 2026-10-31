"""BR-56: CORS for the browser SDK, driven through ASGI like test_handler.py."""

from __future__ import annotations

import pytest

from app.handler import create_app
from app.repository import SqliteRepository
from app.service import Service
from tests.test_handler import CLIENT, send

APP = "https://app.example.com"
ALLOW = "access-control-allow-origin"


def origin(value: str) -> dict[str, bytes]:
    return {"origin": value.encode()}


@pytest.fixture
def app(repo: SqliteRepository):
    return create_app(Service(repo), "test-admin-key", CLIENT, [APP])


@pytest.mark.parametrize("path", ["/v1/evaluate", "/v1/events"])
def test_preflight_from_an_allowed_origin_is_204_without_a_key(app, path: str) -> None:
    r = send(app, "OPTIONS", path, auth="none", headers=origin(APP))
    assert (r.status, r.body) == (204, b"")
    assert r.headers[ALLOW] == APP
    assert r.headers["access-control-allow-methods"] == "POST"
    assert r.headers["access-control-allow-headers"] == "Content-Type, X-Client-Key"
    assert r.headers["access-control-max-age"] == "600"
    assert r.headers["vary"] == "Origin"
    assert "access-control-allow-credentials" not in r.headers


@pytest.mark.parametrize(
    ("path", "value"),
    [
        ("/v1/evaluate", None),
        ("/v1/evaluate", "https://evil.example.org"),
        ("/v1/evaluate", "null"),
        ("/v1/evaluate", APP + "/"),
        ("/v1/evaluate", "http://app.example.com"),
        ("/v1/evaluate", APP.upper()),
        ("/v1/events", "https://evil.example.org"),
        ("/v1/flags", APP),
        ("/v1/flags/x", APP),
        ("/healthz", APP),
        ("/nope", APP),
        ("/v1/evaluate/", APP),
    ],
)
def test_every_other_preflight_is_the_usual_404(app, path: str, value: str | None) -> None:
    r = send(app, "OPTIONS", path, auth="none", headers=None if value is None else origin(value))
    assert (r.status, r.code) == (404, "FLAG_NOT_FOUND")
    assert ALLOW not in r.headers
    assert "access-control-allow-methods" not in r.headers


@pytest.mark.parametrize(
    ("path", "body", "auth", "status"),
    [
        ("/v1/evaluate", '{"flags":[]}', "client", 200),
        ("/v1/evaluate", "[]", "client", 400),
        ("/v1/evaluate", "{}", "none", 401),
        ("/v1/events", '{"events":[{"type":"conversion","userId":"u","goal":"g"}]}', "client", 202),
        ("/v1/events", '{"events":[]}', "client", 400),
    ],
)
def test_post_responses_carry_the_origin_in_every_status(app, path: str, body: str, auth: str, status: int) -> None:
    r = send(app, "POST", path, body, auth=auth, headers=origin(APP))
    assert r.status == status
    assert r.headers[ALLOW] == APP
    assert r.headers["vary"] == "Origin"


def test_no_cors_headers_without_an_allowed_origin_or_on_other_paths(app) -> None:
    assert ALLOW not in send(app, "POST", "/v1/evaluate", '{"flags":[]}', auth="client").headers
    stranger = send(
        app, "POST", "/v1/evaluate", '{"flags":[]}', auth="client", headers=origin("https://evil.example.org")
    )
    assert stranger.status == 200
    assert ALLOW not in stranger.headers
    for path in ("/healthz", "/v1/flags", "/v1/evaluate"):
        assert ALLOW not in send(app, "GET", path, headers=origin(APP)).headers, path


def test_star_allows_every_origin_and_sends_no_vary(repo: SqliteRepository) -> None:
    app = create_app(Service(repo), "test-admin-key", CLIENT, ["*"])
    r = send(app, "OPTIONS", "/v1/events", auth="none", headers=origin("https://anything.example"))
    assert (r.status, r.headers[ALLOW]) == (204, "*")
    assert "vary" not in r.headers
    assert ALLOW not in send(app, "POST", "/v1/evaluate", '{"flags":[]}', auth="client").headers


def test_cors_is_off_by_default(repo: SqliteRepository) -> None:
    app = create_app(Service(repo), "test-admin-key", CLIENT)
    assert send(app, "OPTIONS", "/v1/evaluate", auth="none", headers=origin(APP)).status == 404
    assert ALLOW not in send(app, "POST", "/v1/evaluate", '{"flags":[]}', auth="client", headers=origin(APP)).headers
