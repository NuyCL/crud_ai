"""Configuration from environment variables only (CONVENTIONS.md)."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Config:
    port: int
    db_path: str
    admin_key: str
    client_key: str
    cors_origins: tuple[str, ...] = ()


def load_config(env: Mapping[str, str] | None = None) -> Config:
    """Read PORT (default 8080), DB_PATH (default ./flags.db), ADMIN_KEY and CLIENT_KEY (both required).

    CORS_ORIGINS is a comma-separated list of origins (or "*") that may call evaluate and events from a browser.
    """
    env = os.environ if env is None else env
    missing = [name for name in ("ADMIN_KEY", "CLIENT_KEY") if not env.get(name)]
    if missing:
        raise ValueError(f"missing required environment variable(s): {', '.join(missing)}")
    raw_port = env.get("PORT") or "8080"
    if not raw_port.isascii() or not raw_port.isdigit() or not 1 <= int(raw_port) <= 65535:
        raise ValueError(f"PORT must be a number from 1 to 65535, got {raw_port!r}")
    origins = tuple(o for o in (part.strip() for part in env.get("CORS_ORIGINS", "").split(",")) if o)
    return Config(int(raw_port), env.get("DB_PATH") or "./flags.db", env["ADMIN_KEY"], env["CLIENT_KEY"], origins)
