"""The business rules (BR-xx in spec/business-rules.md) on top of the repository.

Knows nothing about HTTP: failures are ServiceError values carrying a machine-readable code, and the
handler maps codes to status codes.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from app import model
from app.errors import CODE_FLAG_EXISTS, CODE_FLAG_NOT_FOUND, CODE_KEY_IMMUTABLE, ServiceError, validation_error
from app.evaluation import evaluate
from app.model import AuditLog, EvaluationResult, Flag, Results, VariantResult
from app.parse import parse_evaluate_request, parse_events, parse_flag_input
from app.repository import ExistsError, NotFoundError, Repository

# The smallest number of exposures per variant for which a p-value is reported (BR-42).
MIN_SAMPLE_FOR_SIGNIFICANCE = 30


def _now() -> datetime:
    t = datetime.now(UTC)
    return t.replace(microsecond=t.microsecond // 1000 * 1000)


class Service:
    """The application's use cases."""

    def __init__(self, repo: Repository, now: Callable[[], datetime] = _now) -> None:
        self._repo = repo
        self._now = now

    # ---------------------------------------------------------------- flags

    def create_flag(self, raw: Any) -> Flag:
        """Validate raw (a decoded JSON body) and store a new flag with its audit entry (BR-01, BR-02, BR-07, BR-08)."""
        flag = parse_flag_input(raw)
        at = self._now()
        flag.created_at = flag.updated_at = at
        try:
            with self._repo.transaction() as tx:
                tx.insert_flag(flag)
                tx.append_audit(_audit_entry(model.ACTION_CREATE, flag.key, None, flag, at))
        except ExistsError:
            raise ServiceError(CODE_FLAG_EXISTS, f"flag {flag.key!r} already exists") from None
        return flag

    def get_flag(self, key: str) -> Flag:
        try:
            return self._repo.get_flag(key)
        except NotFoundError:
            raise _not_found(key) from None

    def list_flags(self, limit: int, offset: int) -> tuple[list[Flag], int]:
        return self._repo.list_flags(limit, offset)

    def update_flag(self, key: str, raw: Any) -> Flag:
        """Replace the flag at key (BR-03, BR-05, BR-09). Fields the body leaves out go back to their defaults."""
        flag = parse_flag_input(raw)
        if flag.key != key:
            raise ServiceError(CODE_KEY_IMMUTABLE, f"key cannot be changed from {key!r} to {flag.key!r}")
        at = self._now()
        try:
            with self._repo.transaction() as tx:
                old = tx.get_flag(key)
                flag.created_at = old.created_at
                # never let updatedAt go backwards
                flag.updated_at = max(at, old.updated_at) if old.updated_at else at
                tx.update_flag(flag)
                tx.append_audit(_audit_entry(model.ACTION_UPDATE, key, old, flag, at))
        except NotFoundError:
            raise _not_found(key) from None
        return flag

    def delete_flag(self, key: str) -> None:
        """Remove a flag and record it in the audit log (BR-06)."""
        at = self._now()
        try:
            with self._repo.transaction() as tx:
                old = tx.get_flag(key)
                tx.delete_flag(key)
                tx.append_audit(_audit_entry(model.ACTION_DELETE, key, old, None, at))
        except NotFoundError:
            raise _not_found(key) from None

    def list_audit(self, flag_key: str | None, limit: int, offset: int) -> tuple[list[AuditLog], int]:
        return self._repo.list_audit(flag_key, limit, offset)

    # ------------------------------------------------------------- evaluate

    def evaluate(self, raw: Any) -> dict[str, EvaluationResult]:
        """Evaluate flags for the context in raw. Writes nothing (BR-22)."""
        req = parse_evaluate_request(raw)
        results: dict[str, EvaluationResult] = {}
        if req.flags is None:
            for flag in self._repo.list_all_flags():
                results[flag.key] = evaluate(flag, req.context)
            return results
        for key in req.flags:
            try:
                flag: Flag | None = self._repo.get_flag(key)
            except NotFoundError:
                flag = None  # an unknown flag is a normal answer, not a failure (BR-21)
            results[key] = evaluate(flag, req.context)
        return results

    # --------------------------------------------------------------- events

    def record_events(self, raw: Any) -> int:
        """Validate and store a batch; returns how many events it contained (BR-43, BR-44)."""
        events = parse_events(raw)
        self._repo.record_events(events)
        return len(events)

    def results(self, flag_key: str, goal: str) -> Results:
        """The experiment report of a flag for a goal (BR-42, BR-46)."""
        if goal == "":
            raise validation_error("goal is required")
        flag = self.get_flag(flag_key)
        exposures, conversions = self._repo.variant_counts(flag_key, goal)
        rows = []
        for v in flag.variants:
            row = VariantResult(v.key, exposures.get(v.key, 0), conversions.get(v.key, 0))
            if row.exposures > 0:
                row.rate = row.conversions / row.exposures
            rows.append(row)
        # Every variant is compared with the first one, the control.
        for row in rows[1:]:
            row.p_value = _two_proportion_p_value(rows[0], row)
            row.significant = row.p_value is not None and row.p_value < 0.05
        return Results(flag_key=flag_key, goal=goal, variants=rows)


def _not_found(key: str) -> ServiceError:
    return ServiceError(CODE_FLAG_NOT_FOUND, f"flag {key!r} not found")


def _audit_entry(action: str, key: str, before: Flag | None, after: Flag | None, at: datetime) -> AuditLog:
    """Snapshot before and after as JSON, in the same shape the API returns for a flag."""

    def snapshot(flag: Flag | None) -> str | None:
        return None if flag is None else json.dumps(flag.to_json(), separators=(",", ":"))

    return AuditLog(flag_key=key, action=action, created_at=at, before=snapshot(before), after=snapshot(after))


def _two_proportion_p_value(control: VariantResult, treatment: VariantResult) -> float | None:
    """The pooled, two-sided two-proportion z-test of BR-42; None if a group is too small or the standard error is 0."""
    if control.exposures < MIN_SAMPLE_FOR_SIGNIFICANCE or treatment.exposures < MIN_SAMPLE_FOR_SIGNIFICANCE:
        return None
    n1, n2 = float(control.exposures), float(treatment.exposures)
    pooled = (control.conversions + treatment.conversions) / (n1 + n2)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
    if se == 0:
        return None
    z = (treatment.rate - control.rate) / se
    return math.erfc(abs(z) / math.sqrt(2))
