"""Business rules through the service, on a real in-memory SQLite repository."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from typing import Any

import pytest

from app.errors import ServiceError
from app.model import Flag
from app.service import Service
from tests.conftest import Clock, create

TWO_ARMS = '"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]'


def code(fn, *args) -> str:
    try:
        fn(*args)
    except ServiceError as e:
        return e.code
    return ""


def ev(svc: Service, body: dict[str, Any]) -> dict[str, dict]:
    return {k: r.to_json() for k, r in svc.evaluate(body).items()}


def audit_actions(svc: Service) -> list[tuple[str, str]]:
    logs, _ = svc.list_audit(None, 100, 0)
    return [(x.flag_key, x.action) for x in reversed(logs)]


def test_br02_duplicate_key_is_rejected_and_nothing_is_audited(svc: Service) -> None:
    create(svc, '{"key":"f","description":"first"}')
    assert code(create, svc, '{"key":"f","description":"second"}') == "FLAG_EXISTS"
    assert svc.get_flag("f").description == "first"
    assert audit_actions(svc) == [("f", "create")]


def test_br04_text_survives_a_store_and_load_byte_for_byte(svc: Service) -> None:
    text = 'café ไทย \U0001f600 \u0000 "q" \\ \n'
    create(svc, json.dumps({"key": "f", "description": text}))
    assert svc.get_flag("f").description == text


def test_br05_unknown_flag_is_not_found(svc: Service) -> None:
    assert code(svc.get_flag, "ghost") == "FLAG_NOT_FOUND"
    assert code(svc.update_flag, "ghost", {"key": "ghost"}) == "FLAG_NOT_FOUND"
    assert code(svc.delete_flag, "ghost") == "FLAG_NOT_FOUND"


def test_br09_update_is_a_full_replace_and_keeps_created_at(svc: Service) -> None:
    created = create(
        svc,
        '{"key":"f","description":"d","enabled":true,"rolloutPercent":10,"rules":[{"attribute":"a","operator":"eq","value":1}]}',
    )
    updated = svc.update_flag("f", {"key": "f", "enabled": False})
    assert (updated.description, updated.enabled, updated.rollout_percent, updated.rules, updated.variants) == (
        "",
        False,
        100,
        [],
        [],
    )
    assert updated.created_at == created.created_at
    assert updated.updated_at > created.updated_at
    assert svc.get_flag("f") == updated


def test_br09_updated_at_never_goes_backwards(repo, clock: Clock) -> None:
    ticks = iter([datetime(2026, 1, 31, 8, 0, 10, tzinfo=UTC), datetime(2026, 1, 31, 8, 0, 5, tzinfo=UTC)])
    svc = Service(repo, lambda: next(ticks))
    created = create(svc, '{"key":"f"}')
    updated = svc.update_flag("f", {"key": "f"})
    assert updated.updated_at == created.updated_at


def test_br03_key_cannot_change_and_nothing_is_written(svc: Service) -> None:
    create(svc, '{"key":"f"}')
    assert code(svc.update_flag, "f", {"key": "g"}) == "KEY_IMMUTABLE"
    assert audit_actions(svc) == [("f", "create")]
    assert code(svc.get_flag, "g") == "FLAG_NOT_FOUND"


def test_br51_validation_comes_before_existence_checks(svc: Service) -> None:
    assert code(svc.update_flag, "ghost", {"key": "BAD"}) == "INVALID_KEY"
    assert code(svc.update_flag, "ghost", {"key": "other"}) == "KEY_IMMUTABLE"
    assert code(svc.update_flag, "ghost", {"key": "ghost", "rolloutPercent": 101}) == "VALIDATION_ERROR"


def test_br06_delete_removes_the_flag_and_allows_reuse_of_the_key(svc: Service) -> None:
    create(svc, '{"key":"f","description":"one"}')
    svc.delete_flag("f")
    assert code(svc.get_flag, "f") == "FLAG_NOT_FOUND"
    create(svc, '{"key":"f","description":"two"}')
    assert svc.get_flag("f").description == "two"


def test_br21_evaluating_a_deleted_flag_reports_flag_not_found(svc: Service) -> None:
    create(svc, '{"key":"f","enabled":true}')
    assert ev(svc, {"flags": ["f"]})["f"]["reason"] == "ON"
    svc.delete_flag("f")
    assert ev(svc, {"flags": ["f"]})["f"] == {"enabled": False, "variant": None, "reason": "FLAG_NOT_FOUND"}


def test_br07_each_change_writes_one_audit_entry_with_before_and_after(svc: Service) -> None:
    create(svc, '{"key":"f","description":"v1"}')
    svc.update_flag("f", {"key": "f", "description": "v2"})
    svc.delete_flag("f")
    logs, total = svc.list_audit("f", 10, 0)
    assert total == 3
    delete, update, creation = logs
    assert (creation.action, creation.before) == ("create", None)
    assert json.loads(creation.after)["description"] == "v1"
    assert (json.loads(update.before)["description"], json.loads(update.after)["description"]) == ("v1", "v2")
    assert (delete.action, delete.after) == ("delete", None)
    assert json.loads(delete.before)["description"] == "v2"
    assert set(json.loads(creation.after)) == {
        "key",
        "description",
        "enabled",
        "rules",
        "rolloutPercent",
        "variants",
        "createdAt",
        "updatedAt",
    }


def test_br07_rejected_changes_are_not_audited(svc: Service) -> None:
    create(svc, '{"key":"f"}')
    for fn, args in (
        (create, (svc, '{"key":"f"}')),
        (create, (svc, '{"key":"BAD"}')),
        (svc.update_flag, ("f", {"key": "g"})),
        (svc.delete_flag, ("ghost",)),
    ):
        assert code(fn, *args) != ""
    assert audit_actions(svc) == [("f", "create")]


def test_a_failure_inside_the_transaction_leaves_no_flag_behind(
    repo, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    svc = Service(repo, clock)

    def boom(self, entry):
        raise RuntimeError("disk full")

    monkeypatch.setattr("app.repository._SqliteTx.append_audit", boom)
    with pytest.raises(RuntimeError):
        create(svc, '{"key":"f"}')
    monkeypatch.undo()
    assert code(svc.get_flag, "f") == "FLAG_NOT_FOUND"
    assert svc.list_audit(None, 10, 0) == ([], 0)


def test_br23_flags_selects_what_is_evaluated(svc: Service) -> None:
    create(svc, '{"key":"a","enabled":true}')
    create(svc, '{"key":"b","enabled":false}')
    assert set(ev(svc, {})) == {"a", "b"}
    assert ev(svc, {"flags": []}) == {}
    assert set(ev(svc, {"flags": ["a", "ghost", "a"]})) == {"a", "ghost"}
    assert ev(svc, {"flags": ["ghost"]})["ghost"]["reason"] == "FLAG_NOT_FOUND"
    assert ev(svc, {})["b"]["reason"] == "DISABLED"


def test_br22_evaluate_writes_nothing(svc: Service) -> None:
    create(svc, '{"key":"f","enabled":true,' + TWO_ARMS + "}")
    before = (svc.list_flags(10, 0), svc.list_audit(None, 10, 0), svc.results("f", "g"))
    for i in range(20):
        svc.evaluate({"flags": ["f"], "context": {"userId": f"u{i}"}})
    assert (svc.list_flags(10, 0), svc.list_audit(None, 10, 0), svc.results("f", "g")) == before


def test_br44_a_batch_with_one_bad_event_stores_nothing(svc: Service) -> None:
    create(svc, '{"key":"f","enabled":true,' + TWO_ARMS + "}")
    batch = {"events": [{"type": "exposure", "userId": "u", "flagKey": "f", "variant": "control"}, {"type": "oops"}]}
    assert code(svc.record_events, batch) == "VALIDATION_ERROR"
    assert svc.results("f", "g").variants[0].exposures == 0
    good = {"events": batch["events"][:1]}
    assert svc.record_events(good) == 1
    assert svc.results("f", "g").variants[0].exposures == 1


def test_br46_results_errors_and_shape(svc: Service) -> None:
    assert code(svc.results, "ghost", "g") == "FLAG_NOT_FOUND"
    assert code(svc.results, "ghost", "") == "VALIDATION_ERROR"  # the goal is checked first
    create(svc, '{"key":"plain"}')
    assert svc.results("plain", "g").to_json() == {"flagKey": "plain", "goal": "g", "variants": []}
    create(svc, '{"key":"f",' + TWO_ARMS + "}")
    assert svc.results("f", "g").to_json()["variants"][0] == {
        "variant": "control",
        "exposures": 0,
        "conversions": 0,
        "rate": 0.0,
        "pValue": None,
        "significant": False,
    }


def record(svc: Service, *groups: list[dict]) -> None:
    events = [e for g in groups for e in g]
    for i in range(0, len(events), 100):  # a request holds at most 100 events (BR-43)
        svc.record_events({"events": events[i : i + 100]})


def exposures(flag: str, prefix: str, variant: str, n: int) -> list[dict]:
    return [{"type": "exposure", "userId": f"{prefix}{i}", "flagKey": flag, "variant": variant} for i in range(n)]


def conversions(goal: str, prefix: str, n: int) -> list[dict]:
    return [{"type": "conversion", "userId": f"{prefix}{i}", "goal": goal} for i in range(n)]


def two_arm_flag(svc: Service, key: str = "f") -> None:
    create(svc, '{"key":"' + key + '","enabled":true,' + TWO_ARMS + "}")


def test_br40_br41_counting_rules(svc: Service) -> None:
    two_arm_flag(svc)
    record(svc, exposures("f", "c", "control", 3), exposures("f", "c", "treatment", 3))  # same users again: first wins
    record(svc, conversions("buy", "c", 2), conversions("buy", "c", 2), conversions("buy", "nobody", 5))
    control, treatment = svc.results("f", "buy").variants
    assert (control.exposures, control.conversions, treatment.exposures) == (3, 2, 0)
    assert control.rate == pytest.approx(2 / 3)


def test_br42_small_samples_report_no_p_value(svc: Service) -> None:
    two_arm_flag(svc)
    record(svc, exposures("f", "c", "control", 29), exposures("f", "t", "treatment", 29), conversions("buy", "t", 29))
    assert all(r.p_value is None and not r.significant for r in svc.results("f", "buy").variants)
    record(svc, exposures("f", "x", "control", 1))  # control now has 30, treatment still 29
    assert svc.results("f", "buy").variants[1].p_value is None
    record(svc, exposures("f", "y", "treatment", 1))
    assert svc.results("f", "buy").variants[1].p_value is not None


def test_br42_two_proportion_z_test(svc: Service) -> None:
    two_arm_flag(svc)
    record(
        svc,
        exposures("f", "c", "control", 200),
        exposures("f", "t", "treatment", 200),
        conversions("buy", "c", 20),
        conversions("buy", "t", 40),
    )
    control, treatment = svc.results("f", "buy").variants
    assert (control.p_value, control.significant) == (None, False)
    assert (control.rate, treatment.rate) == (pytest.approx(0.1), pytest.approx(0.2))
    # pooled p = 0.15, se = 0.035707, z = 2.80056, erfc(z / sqrt 2) = 0.0051014 (also asserted in Go's test)
    assert treatment.p_value == pytest.approx(0.005101399646004991, abs=1e-9)
    assert treatment.significant is True


def test_br42_the_test_is_two_sided(svc: Service) -> None:
    two_arm_flag(svc)
    record(
        svc,
        exposures("f", "c", "control", 200),
        exposures("f", "t", "treatment", 200),
        conversions("buy", "c", 40),
        conversions("buy", "t", 20),
    )
    treatment = svc.results("f", "buy").variants[1]
    assert treatment.p_value == pytest.approx(0.005101399646004991, abs=1e-9)
    assert treatment.significant is True


def test_br42_identical_rates_and_no_variation_have_no_significance(svc: Service) -> None:
    two_arm_flag(svc, "same")
    record(
        svc,
        exposures("same", "c", "control", 100),
        exposures("same", "t", "treatment", 100),
        conversions("buy", "c", 30),
        conversions("buy", "t", 30),
    )
    row = svc.results("same", "buy").variants[1]
    assert row.p_value == pytest.approx(1.0, abs=1e-12)
    assert row.significant is False

    two_arm_flag(svc, "none")
    record(svc, exposures("none", "c", "control", 40), exposures("none", "t", "treatment", 40))
    row = svc.results("none", "never-converted").variants[
        1
    ]  # a goal no other experiment used (goals are shared by users)
    assert (row.p_value, row.significant) == (None, False)  # standard error 0


def test_br42_p_value_is_never_nan(svc: Service) -> None:
    two_arm_flag(svc)
    record(
        svc,
        exposures("f", "c", "control", 30),
        exposures("f", "t", "treatment", 30),
        conversions("buy", "c", 30),
        conversions("buy", "t", 30),
    )
    row = svc.results("f", "buy").variants[1]
    assert row.p_value is None or not math.isnan(row.p_value)


def test_listing_pages_in_key_order_with_total(svc: Service) -> None:
    for key in ("c", "a", "b"):
        create(svc, '{"key":"' + key + '"}')
    flags, total = svc.list_flags(2, 1)
    assert ([f.key for f in flags], total) == (["b", "c"], 3)


def test_timestamps_are_utc_rfc_3339_with_milliseconds(svc: Service) -> None:
    f: Flag = create(svc, '{"key":"f"}')
    assert f.to_json()["createdAt"] == "2026-01-31T08:00:01.000Z"


@pytest.mark.parametrize(
    ("treatment_conversions", "p_value", "significant"),
    [(33, 0.05521070303825936, False), (34, 0.04051697280293331, True)],
)
def test_br42_significance_is_p_below_0_05(
    svc: Service, treatment_conversions: int, p_value: float, significant: bool
) -> None:
    two_arm_flag(svc)
    record(
        svc,
        exposures("f", "c", "control", 200),
        exposures("f", "t", "treatment", 200),
        conversions("buy", "c", 20),
        conversions("buy", "t", treatment_conversions),
    )
    row = svc.results("f", "buy").variants[1]
    assert row.p_value == pytest.approx(p_value, abs=1e-9)
    assert row.significant is significant
