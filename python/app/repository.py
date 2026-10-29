"""Storage of flags, the audit log and experiment events. The service depends on the Protocols here, not on SQLite."""

from __future__ import annotations

import contextlib
import json
import sqlite3
from collections.abc import Iterator
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Protocol

from app import model
from app.model import AuditLog, Event, Flag, Rule, Variant, format_time


class NotFoundError(Exception):
    """The flag does not exist."""


class ExistsError(Exception):
    """Inserting a flag whose key is taken."""


class Tx(Protocol):
    """The operations that must commit or roll back together: a flag change and its audit entry."""

    def get_flag(self, key: str) -> Flag: ...
    def insert_flag(self, flag: Flag) -> None: ...
    def update_flag(self, flag: Flag) -> None: ...
    def delete_flag(self, key: str) -> None: ...
    def append_audit(self, entry: AuditLog) -> None: ...


class Repository(Protocol):
    """Everything the service needs from storage."""

    def transaction(self) -> AbstractContextManager[Tx]:
        """Run the body in a transaction: leaving it with an exception rolls everything back."""
        ...

    def get_flag(self, key: str) -> Flag: ...
    def list_flags(self, limit: int, offset: int) -> tuple[list[Flag], int]:
        """One page ordered by key ascending, and the total count."""
        ...

    def list_all_flags(self) -> list[Flag]: ...
    def list_audit(self, flag_key: str | None, limit: int, offset: int) -> tuple[list[AuditLog], int]:
        """One page, newest first. A flag_key of None means every flag."""
        ...

    def record_events(self, events: list[Event]) -> None:
        """Store all events or none. First exposure of a (flag, user) wins; a (goal, user) conversion counts once."""
        ...

    def variant_counts(self, flag_key: str, goal: str) -> tuple[dict[str, int], dict[str, int]]:
        """Per variant key: the number of exposed users, and how many of them converted on goal."""
        ...

    def close(self) -> None: ...


_SCHEMA = """
CREATE TABLE IF NOT EXISTS flags (
    key             TEXT PRIMARY KEY,
    description     TEXT NOT NULL,
    enabled         INTEGER NOT NULL,
    rules           TEXT NOT NULL,
    rollout_percent INTEGER NOT NULL,
    variants        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_key   TEXT NOT NULL,
    action     TEXT NOT NULL,
    before     TEXT,
    after      TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_flag_key ON audit_logs (flag_key, id);
CREATE TABLE IF NOT EXISTS exposures (
    flag_key TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    variant  TEXT NOT NULL,
    PRIMARY KEY (flag_key, user_id)
);
CREATE TABLE IF NOT EXISTS conversions (
    goal    TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (goal, user_id)
);
"""

_FLAG_COLUMNS = "key, description, enabled, rules, rollout_percent, variants, created_at, updated_at"


def _parse_time(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)


def _flag_from_row(row: sqlite3.Row | tuple) -> Flag:
    key, description, enabled, rules, rollout, variants, created_at, updated_at = row
    return Flag(
        key=key,
        description=description,
        enabled=bool(enabled),
        rules=[Rule(r["attribute"], r["operator"], r["value"]) for r in json.loads(rules)],
        rollout_percent=rollout,
        variants=[Variant(v["key"], v["weight"]) for v in json.loads(variants)],
        created_at=_parse_time(created_at),
        updated_at=_parse_time(updated_at),
    )


def _stamp(t: datetime | None) -> str:
    if t is None:
        raise ValueError("the service must set createdAt and updatedAt before storing a flag")
    return format_time(t)


def _dumps(value: object) -> str:
    return json.dumps(value, separators=(",", ":"))


def _get_flag(conn: sqlite3.Connection, key: str) -> Flag:
    row = conn.execute(f"SELECT {_FLAG_COLUMNS} FROM flags WHERE key = ?", (key,)).fetchone()
    if row is None:
        raise NotFoundError(key)
    return _flag_from_row(row)


class _SqliteTx:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def get_flag(self, key: str) -> Flag:
        return _get_flag(self._conn, key)

    def insert_flag(self, flag: Flag) -> None:
        if self._conn.execute("SELECT 1 FROM flags WHERE key = ?", (flag.key,)).fetchone() is not None:
            raise ExistsError(flag.key)
        self._conn.execute(
            f"INSERT INTO flags ({_FLAG_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                flag.key,
                flag.description,
                int(flag.enabled),
                _dumps([r.to_json() for r in flag.rules]),
                flag.rollout_percent,
                _dumps([v.to_json() for v in flag.variants]),
                _stamp(flag.created_at),
                _stamp(flag.updated_at),
            ),
        )

    def update_flag(self, flag: Flag) -> None:
        cursor = self._conn.execute(
            "UPDATE flags SET description = ?, enabled = ?, rules = ?, rollout_percent = ?, variants = ?,"
            " updated_at = ? WHERE key = ?",
            (
                flag.description,
                int(flag.enabled),
                _dumps([r.to_json() for r in flag.rules]),
                flag.rollout_percent,
                _dumps([v.to_json() for v in flag.variants]),
                _stamp(flag.updated_at),
                flag.key,
            ),
        )
        if cursor.rowcount == 0:
            raise NotFoundError(flag.key)

    def delete_flag(self, key: str) -> None:
        if self._conn.execute("DELETE FROM flags WHERE key = ?", (key,)).rowcount == 0:
            raise NotFoundError(key)

    def append_audit(self, entry: AuditLog) -> None:
        self._conn.execute(
            "INSERT INTO audit_logs (flag_key, action, before, after, created_at) VALUES (?, ?, ?, ?, ?)",
            (entry.flag_key, entry.action, entry.before, entry.after, format_time(entry.created_at)),
        )


class SqliteRepository:
    """SQLite through the standard library.

    One connection, shared by the whole process. The service is called from the event loop's single thread,
    so statements never interleave; `check_same_thread=False` only lets tests and shutdown touch it from
    another thread. Autocommit (`isolation_level=None`) is switched off per transaction by hand, because the
    default "legacy" mode of the sqlite3 module opens transactions implicitly and unpredictably.
    """

    def __init__(self, path: str) -> None:
        self._conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._conn.execute("PRAGMA busy_timeout = 5000")
        if path != ":memory:":
            self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        self._conn.close()

    @contextlib.contextmanager
    def _begin(self) -> Iterator[sqlite3.Connection]:
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            yield self._conn
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise
        self._conn.execute("COMMIT")

    @contextlib.contextmanager
    def transaction(self) -> Iterator[Tx]:
        with self._begin() as conn:
            yield _SqliteTx(conn)

    def get_flag(self, key: str) -> Flag:
        return _get_flag(self._conn, key)

    def list_flags(self, limit: int, offset: int) -> tuple[list[Flag], int]:
        # one read transaction so that the count and the page describe the same state
        self._conn.execute("BEGIN")
        try:
            total = self._conn.execute("SELECT COUNT(*) FROM flags").fetchone()[0]
            rows = self._conn.execute(
                f"SELECT {_FLAG_COLUMNS} FROM flags ORDER BY key ASC LIMIT ? OFFSET ?", (limit, offset)
            ).fetchall()
        finally:
            self._conn.execute("ROLLBACK")
        return [_flag_from_row(r) for r in rows], total

    def list_all_flags(self) -> list[Flag]:
        rows = self._conn.execute(f"SELECT {_FLAG_COLUMNS} FROM flags ORDER BY key ASC").fetchall()
        return [_flag_from_row(r) for r in rows]

    def list_audit(self, flag_key: str | None, limit: int, offset: int) -> tuple[list[AuditLog], int]:
        where, args = ("", []) if flag_key is None else (" WHERE flag_key = ?", [flag_key])
        self._conn.execute("BEGIN")
        try:
            total = self._conn.execute(f"SELECT COUNT(*) FROM audit_logs{where}", args).fetchone()[0]
            rows = self._conn.execute(
                f"SELECT id, flag_key, action, before, after, created_at FROM audit_logs{where}"
                " ORDER BY id DESC LIMIT ? OFFSET ?",
                [*args, limit, offset],
            ).fetchall()
        finally:
            self._conn.execute("ROLLBACK")
        logs = [
            AuditLog(id=r[0], flag_key=r[1], action=r[2], before=r[3], after=r[4], created_at=_parse_time(r[5]))
            for r in rows
        ]
        return logs, total

    def record_events(self, events: list[Event]) -> None:
        with self._begin() as conn:
            for e in events:
                if e.type == model.EVENT_EXPOSURE:
                    conn.execute(
                        "INSERT OR IGNORE INTO exposures (flag_key, user_id, variant) VALUES (?, ?, ?)",
                        (e.flag_key, e.user_id, e.variant),
                    )
                elif e.type == model.EVENT_CONVERSION:
                    conn.execute("INSERT OR IGNORE INTO conversions (goal, user_id) VALUES (?, ?)", (e.goal, e.user_id))
                else:
                    raise ValueError(f"unknown event type {e.type!r}")

    def variant_counts(self, flag_key: str, goal: str) -> tuple[dict[str, int], dict[str, int]]:
        self._conn.execute("BEGIN")
        try:
            exposures = dict(
                self._conn.execute(
                    "SELECT variant, COUNT(*) FROM exposures WHERE flag_key = ? GROUP BY variant", (flag_key,)
                ).fetchall()
            )
            conversions = dict(
                self._conn.execute(
                    "SELECT e.variant, COUNT(*) FROM exposures e"
                    " JOIN conversions c ON c.user_id = e.user_id AND c.goal = ?"
                    " WHERE e.flag_key = ? GROUP BY e.variant",
                    (goal, flag_key),
                ).fetchall()
            )
        finally:
            self._conn.execute("ROLLBACK")
        return exposures, conversions
