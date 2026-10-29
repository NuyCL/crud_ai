"""Decides what a flag means for a user.

A pure function of its arguments: no I/O, no clock, no randomness. The rules are defined in
spec/evaluation.md and checked against tests/vectors.
"""

from __future__ import annotations

from collections.abc import Mapping

from app import model
from app.model import Context, EvaluationResult, Flag, Rule

BUCKETS = 10000

_FNV_OFFSET = 2166136261
_FNV_PRIME = 16777619


def fnv1a32(s: str) -> int:
    """32-bit FNV-1a of the UTF-8 bytes of s.

    Python ints do not overflow, so the product is masked back to 32 bits by hand. `encode` raises on a
    lone surrogate; the handler removes those before they get here (BR-54).
    """
    h = _FNV_OFFSET
    for byte in s.encode("utf-8"):
        h ^= byte
        h = (h * _FNV_PRIME) & 0xFFFFFFFF
    return h


def bucket(flag_key: str, salt: str, user_id: str) -> int:
    """Map (flag_key, salt, user_id) to 0..9999."""
    return fnv1a32(f"{flag_key}:{salt}:{user_id}") % BUCKETS


def _off(reason: str) -> EvaluationResult:
    return EvaluationResult(enabled=False, reason=reason)


def evaluate(flag: Flag | None, ctx: Context) -> EvaluationResult:
    """Evaluate flag for ctx. None means the flag does not exist."""
    if flag is None:
        return _off(model.REASON_FLAG_NOT_FOUND)
    if not flag.enabled:
        return _off(model.REASON_DISABLED)
    for rule in flag.rules:
        if not _rule_matches(rule, ctx.attributes):
            return _off(model.REASON_TARGETING_MISS)

    needs_bucket = flag.rollout_percent < 100 or len(flag.variants) > 0
    if needs_bucket and ctx.user_id == "":
        return _off(model.REASON_MISSING_USER_ID)
    if flag.rollout_percent < 100 and bucket(flag.key, "rollout", ctx.user_id) >= flag.rollout_percent * 100:
        return _off(model.REASON_NOT_IN_ROLLOUT)
    if not flag.variants:
        return EvaluationResult(enabled=True, reason=model.REASON_ON)

    b = bucket(flag.key, "variant", ctx.user_id)
    threshold = 0
    for variant in flag.variants:
        threshold += variant.weight * 100
        if b < threshold:
            return EvaluationResult(enabled=True, variant=variant.key, reason=model.REASON_VARIANT)
    # Unreachable while the weights sum to 100, which the service guarantees.
    return _off(model.REASON_DISABLED)


def _rule_matches(rule: Rule, attrs: Mapping[str, model.Scalar]) -> bool:
    """A missing attribute makes every operator fail, including neq and not_in."""
    if rule.attribute not in attrs:
        return False
    got = attrs[rule.attribute]
    match rule.operator:
        case "eq":
            return _scalar_equal(got, rule.value)
        case "neq":
            return not _scalar_equal(got, rule.value)
        case "in":
            return _contains(rule.value, got)
        case "not_in":
            return not _contains(rule.value, got)
    return False


def _contains(items: object, got: model.Scalar) -> bool:
    if not isinstance(items, list):
        return False
    return any(_scalar_equal(got, item) for item in items)


def _scalar_equal(a: object, b: object) -> bool:
    """Equality without conversion: "1" is not 1, true is not "true", and true is not 1.

    bool is a subclass of int in Python (`True == 1`), so it is tested first. int and float are one type
    (numbers are IEEE 754 doubles).
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return float(a) == float(b)
    return False
