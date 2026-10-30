from __future__ import annotations

import pytest

from app.config import Config, load_config


def test_defaults() -> None:
    assert load_config({"ADMIN_KEY": "a", "CLIENT_KEY": "c"}) == Config(8080, "./flags.db", "a", "c")


def test_values_are_read() -> None:
    assert load_config({"ADMIN_KEY": "a", "CLIENT_KEY": "c", "PORT": "9000", "DB_PATH": "/tmp/x.db"}) == Config(
        9000, "/tmp/x.db", "a", "c"
    )


@pytest.mark.parametrize("env", [{}, {"ADMIN_KEY": "a"}, {"CLIENT_KEY": "c"}, {"ADMIN_KEY": "", "CLIENT_KEY": "c"}])
def test_both_keys_are_required(env: dict[str, str]) -> None:
    with pytest.raises(ValueError, match="KEY"):
        load_config(env)


@pytest.mark.parametrize("port", ["0", "65536", "-1", "abc", "8080x", "٨٠", "1.5"])
def test_port_must_be_a_number_from_1_to_65535(port: str) -> None:
    with pytest.raises(ValueError, match="PORT"):
        load_config({"ADMIN_KEY": "a", "CLIENT_KEY": "c", "PORT": port})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", ()),
        (" , ", ()),
        ("https://a.example", ("https://a.example",)),
        (" https://a.example , https://b.example,", ("https://a.example", "https://b.example")),
        ("*", ("*",)),
    ],
)
def test_cors_origins_are_split_trimmed_and_empty_items_dropped(raw: str, expected: tuple[str, ...]) -> None:
    assert load_config({"ADMIN_KEY": "a", "CLIENT_KEY": "c", "CORS_ORIGINS": raw}).cors_origins == expected
