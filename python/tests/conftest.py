from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.model import Flag
from app.repository import SqliteRepository
from app.service import Service

VECTORS = Path(__file__).resolve().parents[2] / "tests" / "vectors"


def load_vectors(name: str) -> dict[str, Any]:
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


class Clock:
    """Hands out a later time on every call."""

    def __init__(self) -> None:
        self.t = datetime(2026, 1, 31, 8, 0, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        self.t += timedelta(seconds=1)
        return self.t


@pytest.fixture
def repo() -> Iterator[SqliteRepository]:
    repository = SqliteRepository(":memory:")
    yield repository
    repository.close()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def svc(repo: SqliteRepository, clock: Clock) -> Service:
    return Service(repo, clock)


def create(svc: Service, body: str) -> Flag:
    """Create a flag from JSON text, the way the handler would after decoding."""
    return svc.create_flag(json.loads(body))
