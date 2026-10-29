from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.model import AuditLog, Event, Flag, Rule, Variant
from app.repository import ExistsError, NotFoundError, SqliteRepository

T0 = datetime(2026, 1, 31, 8, 0, 0, 250000, tzinfo=UTC)


def make(key: str = "f", **kw) -> Flag:
    return Flag(key=key, created_at=T0, updated_at=T0, **kw)


def put(repo: SqliteRepository, flag: Flag) -> None:
    with repo.transaction() as tx:
        tx.insert_flag(flag)


def audit(key: str = "f", action: str = "create", before: str | None = None, after: str | None = None) -> AuditLog:
    return AuditLog(flag_key=key, action=action, created_at=T0, before=before, after=after)


def test_insert_then_get_round_trips_every_field(repo: SqliteRepository) -> None:
    f = make(
        description="café ก \U0001f600 \x00 end",
        enabled=True,
        rollout_percent=37,
        rules=[Rule("country", "in", ["TH", 1.5, True]), Rule("age", "neq", 18.0)],
        variants=[Variant("b", 30), Variant("a", 70)],
    )
    put(repo, f)
    assert repo.get_flag("f") == f


def test_empty_rules_and_variants_come_back_as_empty_lists(repo: SqliteRepository) -> None:
    put(repo, make())
    got = repo.get_flag("f")
    assert got.rules == []
    assert got.variants == []


def test_get_unknown_flag_is_not_found(repo: SqliteRepository) -> None:
    with pytest.raises(NotFoundError):
        repo.get_flag("ghost")


def test_insert_duplicate_key_is_exists_and_keeps_the_original(repo: SqliteRepository) -> None:
    put(repo, make(description="first"))
    with pytest.raises(ExistsError), repo.transaction() as tx:
        tx.insert_flag(make(description="second"))
    assert repo.get_flag("f").description == "first"


def test_update_replaces_fields_but_keeps_created_at(repo: SqliteRepository) -> None:
    put(repo, make(description="old"))
    later = datetime(2026, 2, 1, tzinfo=UTC)
    with repo.transaction() as tx:
        tx.update_flag(
            Flag(
                key="f", description="new", enabled=True, created_at=datetime(2000, 1, 1, tzinfo=UTC), updated_at=later
            )
        )
    got = repo.get_flag("f")
    assert (got.description, got.enabled, got.created_at, got.updated_at) == ("new", True, T0, later)


def test_update_and_delete_of_unknown_flag_are_not_found(repo: SqliteRepository) -> None:
    with pytest.raises(NotFoundError), repo.transaction() as tx:
        tx.update_flag(make("ghost"))
    with pytest.raises(NotFoundError), repo.transaction() as tx:
        tx.delete_flag("ghost")


def test_delete_removes_the_flag(repo: SqliteRepository) -> None:
    put(repo, make())
    with repo.transaction() as tx:
        tx.delete_flag("f")
    with pytest.raises(NotFoundError):
        repo.get_flag("f")


def test_list_flags_is_sorted_by_key_and_paged_with_total(repo: SqliteRepository) -> None:
    for key in ("c", "a", "e", "b", "d"):
        put(repo, make(key))
    flags, total = repo.list_flags(2, 1)
    assert ([f.key for f in flags], total) == (["b", "c"], 5)
    flags, total = repo.list_flags(10, 5)
    assert (flags, total) == ([], 5)
    assert [f.key for f in repo.list_all_flags()] == ["a", "b", "c", "d", "e"]


def test_a_failed_transaction_rolls_back_flag_and_audit_together(repo: SqliteRepository) -> None:
    def fail_midway() -> None:
        with repo.transaction() as tx:
            tx.insert_flag(make())
            tx.append_audit(audit())
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        fail_midway()
    with pytest.raises(NotFoundError):
        repo.get_flag("f")
    assert repo.list_audit(None, 10, 0) == ([], 0)


def test_a_transaction_that_raises_does_not_strand_the_connection(repo: SqliteRepository) -> None:
    for _ in range(3):
        with pytest.raises(KeyboardInterrupt), repo.transaction():
            raise KeyboardInterrupt  # a BaseException, not an Exception
    put(repo, make())  # would fail with "cannot start a transaction within a transaction"
    assert repo.get_flag("f").key == "f"


def test_audit_is_newest_first_filtered_and_keeps_null_before_after(repo: SqliteRepository) -> None:
    with repo.transaction() as tx:
        tx.append_audit(audit("a", "create", None, '{"k":1}'))
        tx.append_audit(audit("b", "create", None, '{"k":2}'))
        tx.append_audit(audit("a", "delete", '{"k":1}', None))
    logs, total = repo.list_audit(None, 10, 0)
    assert (total, [(x.flag_key, x.action) for x in logs]) == (3, [("a", "delete"), ("b", "create"), ("a", "create")])
    assert logs[0].before == '{"k":1}'
    assert logs[0].after is None
    assert logs[2].before is None
    assert [x.id for x in logs] == sorted((x.id for x in logs), reverse=True)
    only_a, total_a = repo.list_audit("a", 10, 0)
    assert (total_a, [x.action for x in only_a]) == (2, ["delete", "create"])
    page, total_page = repo.list_audit(None, 1, 1)
    assert (total_page, [x.flag_key for x in page]) == (3, ["b"])
    assert repo.list_audit("", 10, 0) == ([], 0)  # an empty filter is a filter, not "no filter"


def exposure(user: str, variant: str, flag: str = "f") -> Event:
    return Event("exposure", user, flag_key=flag, variant=variant)


def conversion(user: str, goal: str = "buy") -> Event:
    return Event("conversion", user, goal=goal)


def test_first_exposure_wins_and_duplicates_count_once(repo: SqliteRepository) -> None:
    repo.record_events([exposure("u1", "a"), exposure("u1", "b"), exposure("u1", "a"), exposure("u2", "b")])
    exposures, _ = repo.variant_counts("f", "buy")
    assert exposures == {"a": 1, "b": 1}


def test_conversions_count_once_per_user_and_only_for_exposed_users(repo: SqliteRepository) -> None:
    repo.record_events([exposure("u1", "a"), exposure("u2", "a"), exposure("u3", "b")])
    repo.record_events(
        [conversion("u1"), conversion("u1"), conversion("u3"), conversion("stranger"), conversion("u2", "other")]
    )
    exposures, conversions = repo.variant_counts("f", "buy")
    assert exposures == {"a": 2, "b": 1}
    assert conversions == {"a": 1, "b": 1}


def test_record_events_is_all_or_nothing(repo: SqliteRepository) -> None:
    with pytest.raises(ValueError, match="unknown event type"):
        repo.record_events([exposure("u1", "a"), Event("click", "u1")])
    assert repo.variant_counts("f", "buy") == ({}, {})


def test_data_survives_reopening_a_file_database(tmp_path: Path) -> None:
    path = str(tmp_path / "flags.db")
    first = SqliteRepository(path)
    put(first, make(description="kept"))
    first.close()
    second = SqliteRepository(path)
    assert second.get_flag("f").description == "kept"
    second.close()


def test_database_paths_with_special_characters_work(tmp_path: Path) -> None:
    for name in ("a b#c.db", "50%.db", "q?x.db", "café.db"):
        repo = SqliteRepository(str(tmp_path / name))
        put(repo, make())
        repo.close()
        assert (tmp_path / name).exists(), name


def test_wal_mode_is_on_for_a_file_database(tmp_path: Path) -> None:
    path = tmp_path / "wal.db"
    SqliteRepository(str(path)).close()
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
