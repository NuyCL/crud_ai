"""Validation of request bodies and query strings (BR-xx in spec/business-rules.md).

The parsers take the result of `json.loads` (dict, list, str, int, float, bool, None). Python's json module
returns 10 as int and 10.0 and 1e1 as float; BR-30 treats them alike, so numbers are normalised here.
Booleans are tested before numbers throughout: `isinstance(True, int)` is true in Python.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from app import model
from app.errors import CODE_INVALID_KEY, ServiceError, validation_error, variants_error
from app.model import Context, Event, Flag, Rule, Scalar, Variant

# fullmatch, not `^...$`: Python's `$` also matches before a trailing newline, so "abc\n" would pass.
# [0-9] and not \d: \d matches every Unicode decimal digit (Arabic-Indic, full-width, ...).
KEY_PATTERN = "[a-z0-9][a-z0-9_-]{0,63}"
VARIANT_KEY_PATTERN = "[a-z0-9][a-z0-9_-]{0,31}"
_KEY_RE = re.compile(KEY_PATTERN)
_VARIANT_KEY_RE = re.compile(VARIANT_KEY_PATTERN)
_DIGITS_RE = re.compile("[0-9]+")
_TIMESTAMP_RE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))"
)

MAX_DESCRIPTION_CODE_POINTS = 500
MIN_VARIANTS, MAX_VARIANTS = 2, 10
MAX_EVENTS = 100
_INT_LIMIT = 1_000_000_000
_INT32_MAX = 2**31 - 1


def as_int(v: object) -> int | None:
    """A JSON number without a fractional part (10 or 10.0) that fits comfortably in an int."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if -_INT_LIMIT <= v <= _INT_LIMIT else None
    if isinstance(v, float):
        if not math.isfinite(v) or v != math.trunc(v) or abs(v) > _INT_LIMIT:
            return None
        return int(v)
    return None


def as_scalar(v: object) -> Scalar | None:
    """str, float or bool. null, arrays and objects are not scalars; neither is a number beyond a double."""
    if isinstance(v, bool | str):
        return v
    if isinstance(v, int | float):
        try:
            f = float(v)  # an int with 400 digits does not fit a double: OverflowError
        except OverflowError:
            return None
        return f if math.isfinite(f) else None
    return None


def _non_empty_string(v: object) -> str | None:
    return v if isinstance(v, str) and v != "" else None


def parse_flag_input(raw: object) -> Flag:
    """Validate a create/replace body (BR-01, BR-04, BR-08, BR-30..35) and apply the defaults."""
    if not isinstance(raw, dict):
        raise validation_error("body must be a JSON object")
    key = raw.get("key")
    if not isinstance(key, str):
        raise validation_error("key is required and must be a string")
    if not _KEY_RE.fullmatch(key):
        raise ServiceError(CODE_INVALID_KEY, f"key must match {KEY_PATTERN}")
    flag = Flag(key=key)

    if "description" in raw:
        description = raw["description"]
        if not isinstance(description, str):
            raise validation_error("description must be a string")
        # len() counts Unicode code points: not bytes, and not UTF-16 units (BR-04).
        if len(description) > MAX_DESCRIPTION_CODE_POINTS:
            raise validation_error(f"description must be at most {MAX_DESCRIPTION_CODE_POINTS} characters")
        flag.description = description
    if "enabled" in raw:
        if not isinstance(raw["enabled"], bool):
            raise validation_error("enabled must be a boolean")
        flag.enabled = raw["enabled"]
    if "rolloutPercent" in raw:
        percent = as_int(raw["rolloutPercent"])
        if percent is None or not 0 <= percent <= 100:
            raise validation_error("rolloutPercent must be an integer from 0 to 100")
        flag.rollout_percent = percent
    if "rules" in raw:
        flag.rules = _parse_rules(raw["rules"])
    if "variants" in raw:
        flag.variants = _parse_variants(raw["variants"])
    return flag


def _parse_rules(v: object) -> list[Rule]:
    if not isinstance(v, list):
        raise validation_error("rules must be an array")
    rules: list[Rule] = []
    for i, item in enumerate(v):
        if not isinstance(item, dict):
            raise validation_error(f"rules[{i}] must be an object")
        attribute = _non_empty_string(item.get("attribute"))
        if attribute is None:
            raise validation_error(f"rules[{i}].attribute must be a non-empty string")
        operator = item.get("operator")
        if operator not in ("eq", "neq", "in", "not_in"):  # also rejects a non-string, e.g. a list
            raise validation_error(f"rules[{i}].operator must be one of eq, neq, in, not_in")
        try:
            value = _parse_rule_value(operator, item.get("value"))
        except ValueError as e:
            raise validation_error(f"rules[{i}].value: {e}") from None
        rules.append(Rule(attribute=attribute, operator=operator, value=value))
    return rules


def _parse_rule_value(operator: str, v: object) -> Scalar | list[Scalar]:
    if operator in ("in", "not_in"):
        if not isinstance(v, list) or not v:
            raise ValueError("must be a non-empty array of scalars")
        items: list[Scalar] = []
        for item in v:
            scalar = as_scalar(item)
            if scalar is None:
                raise ValueError("must be a non-empty array of scalars")
            items.append(scalar)
        return items
    scalar = as_scalar(v)
    if scalar is None:
        raise ValueError("must be a string, number or boolean")
    return scalar


def _parse_variants(v: object) -> list[Variant]:
    if not isinstance(v, list):
        raise validation_error("variants must be an array")
    if not v:
        return []
    if not MIN_VARIANTS <= len(v) <= MAX_VARIANTS:
        raise variants_error(f"a flag with variants needs {MIN_VARIANTS} to {MAX_VARIANTS} of them")
    variants: list[Variant] = []  # keeps the order the client sent
    seen: set[str] = set()
    total = 0
    for i, item in enumerate(v):
        if not isinstance(item, dict):
            raise variants_error(f"variants[{i}] must be an object")
        key = item.get("key")
        if not isinstance(key, str) or not _VARIANT_KEY_RE.fullmatch(key):
            raise variants_error(f"variants[{i}].key must match {VARIANT_KEY_PATTERN}")
        if key in seen:
            raise variants_error(f"variant key {key!r} is used twice")
        seen.add(key)
        weight = as_int(item.get("weight"))
        if weight is None or not 1 <= weight <= 100:
            raise variants_error(f"variants[{i}].weight must be an integer from 1 to 100")
        total += weight
        variants.append(Variant(key=key, weight=weight))
    if total != 100:
        raise variants_error(f"weights must add up to 100, got {total}")
    return variants


@dataclass(slots=True)
class EvaluateRequest:
    """A validated POST /v1/evaluate body. `flags` is None when every flag is to be evaluated (BR-23)."""

    flags: list[str] | None = None
    context: Context = field(default_factory=Context)


def parse_evaluate_request(raw: object) -> EvaluateRequest:
    """Validate an evaluate body (BR-20)."""
    if not isinstance(raw, dict):
        raise validation_error("body must be a JSON object")
    req = EvaluateRequest()
    if "flags" in raw:
        flags = raw["flags"]
        if not isinstance(flags, list) or not all(isinstance(f, str) for f in flags):
            raise validation_error("flags must be an array of strings")
        req.flags = list(flags)
    if "context" in raw:
        ctx = raw["context"]
        if not isinstance(ctx, dict):
            raise validation_error("context must be an object")
        user_id = ""
        attributes: dict[str, Scalar] = {}
        if "userId" in ctx:
            if not isinstance(ctx["userId"], str):
                raise validation_error("context.userId must be a string")
            user_id = ctx["userId"]
        if "attributes" in ctx:
            attrs = ctx["attributes"]
            if not isinstance(attrs, dict):
                raise validation_error("context.attributes must be an object")
            for name, value in attrs.items():
                scalar = as_scalar(value)
                if scalar is None:
                    raise validation_error(f"context.attributes.{name} must be a string, number or boolean")
                attributes[name] = scalar
        req.context = Context(user_id=user_id, attributes=attributes)
    return req


def parse_events(raw: object) -> list[Event]:
    """Validate a POST /v1/events body (BR-43). Nothing is returned unless every event is valid."""
    if not isinstance(raw, dict):
        raise validation_error("body must be a JSON object")
    items = raw.get("events")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_EVENTS:
        raise validation_error(f"events must be an array of 1 to {MAX_EVENTS} events")
    events: list[Event] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise validation_error(f"events[{i}] must be an object")
        kind = item.get("type")
        if kind not in (model.EVENT_EXPOSURE, model.EVENT_CONVERSION):
            raise validation_error(f"events[{i}].type must be exposure or conversion")
        user_id = _non_empty_string(item.get("userId"))
        if user_id is None:
            raise validation_error(f"events[{i}].userId must be a non-empty string")
        if kind == model.EVENT_EXPOSURE:
            flag_key = _non_empty_string(item.get("flagKey"))
            if flag_key is None:
                raise validation_error(f"events[{i}].flagKey is required for an exposure")
            variant = _non_empty_string(item.get("variant"))
            if variant is None:
                raise validation_error(f"events[{i}].variant is required for an exposure")
            event = Event(type=kind, user_id=user_id, flag_key=flag_key, variant=variant)
        else:
            goal = _non_empty_string(item.get("goal"))
            if goal is None:
                raise validation_error(f"events[{i}].goal is required for a conversion")
            event = Event(type=kind, user_id=user_id, goal=goal)
        if "timestamp" in item and not (isinstance(item["timestamp"], str) and valid_timestamp(item["timestamp"])):
            raise validation_error(f"events[{i}].timestamp must be an RFC 3339 string")
        events.append(event)
    return events


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
        return 29 if leap else 28
    return 30 if month in (4, 6, 9, 11) else 31


def valid_timestamp(s: str) -> bool:
    """RFC 3339 date-time that also exists on the calendar (BR-43).

    The grammar is checked with [0-9] (not \\d) and fullmatch (not `$`), then the ranges by hand:
    `datetime.fromisoformat` is more lenient and accepts forms RFC 3339 does not.
    """
    m = _TIMESTAMP_RE.fullmatch(s)
    if m is None:
        return False
    year, month, day, hour, minute, second = (int(g) for g in m.groups()[:6])
    if not (1 <= month <= 12 and 1 <= day <= _days_in_month(year, month)):
        return False
    if hour > 23 or minute > 59 or second > 59:
        return False
    offset_hours, offset_minutes = m.group(7), m.group(8)
    return offset_hours is None or (int(offset_hours) <= 23 and int(offset_minutes) <= 59)


def parse_page(query: dict[str, list[str]]) -> tuple[int, int]:
    """Read limit and offset from a parsed query string (BR-50). The first value of a repeated name counts."""

    def number(name: str, default: int, low: int, high: int) -> int:
        values = query.get(name)
        if not values:
            return default
        if not _DIGITS_RE.fullmatch(values[0]):
            raise validation_error(f"{name} must be an integer")
        n = int(values[0]) if len(values[0]) < 19 else high + 1  # a 4000-digit number must not be converted
        if not low <= n <= high:
            raise validation_error(f"{name} must be between {low} and {high}")
        return n

    return number("limit", 20, 1, 100), number("offset", 0, 0, _INT32_MAX)


def clean(value: Any) -> Any:
    """Replace each lone surrogate in a decoded JSON value with U+FFFD, in strings and in object keys (BR-54).

    `json.loads` accepts "\\ud800" and returns a str that cannot be encoded as UTF-8: it would crash
    the hash, SQLite and the response. Go's decoder substitutes U+FFFD for the same input, so doing the
    same makes both services answer alike.
    """
    if isinstance(value, str):
        return _SURROGATE_RE.sub("�", value) if _SURROGATE_RE.search(value) else value
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, dict):
        return {clean(k): clean(v) for k, v in value.items()}
    return value


_SURROGATE_RE = re.compile("[\ud800-\udfff]")
