"""Data types shared by every layer. The JSON shape follows spec/openapi.yaml."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

# A scalar in a rule or an attribute is a str, a float or a bool. Numbers are always floats so that
# equality never depends on how the number was written in JSON; bool is checked before number
# everywhere because Python's bool is a subclass of int.
Scalar = str | float | bool

REASON_FLAG_NOT_FOUND = "FLAG_NOT_FOUND"
REASON_DISABLED = "DISABLED"
REASON_TARGETING_MISS = "TARGETING_MISS"
REASON_MISSING_USER_ID = "MISSING_USER_ID"
REASON_NOT_IN_ROLLOUT = "NOT_IN_ROLLOUT"
REASON_ON = "ON"
REASON_VARIANT = "VARIANT"

ACTION_CREATE = "create"
ACTION_UPDATE = "update"
ACTION_DELETE = "delete"

EVENT_EXPOSURE = "exposure"
EVENT_CONVERSION = "conversion"


def format_time(t: datetime) -> str:
    """RFC 3339 in UTC with millisecond precision, e.g. 2026-01-31T08:00:00.250Z."""
    return f"{t:%Y-%m-%dT%H:%M:%S}.{t.microsecond // 1000:03d}Z"


@dataclass(frozen=True, slots=True)
class Rule:
    """One targeting condition: a scalar value for eq/neq, a non-empty list of scalars for in/not_in."""

    attribute: str
    operator: str
    value: Scalar | list[Scalar]

    def to_json(self) -> dict[str, Any]:
        return {"attribute": self.attribute, "operator": self.operator, "value": self.value}


@dataclass(frozen=True, slots=True)
class Variant:
    """One arm of an experiment. The weights of a flag's variants sum to 100."""

    key: str
    weight: int

    def to_json(self) -> dict[str, Any]:
        return {"key": self.key, "weight": self.weight}


@dataclass(slots=True)
class Flag:
    key: str
    description: str = ""
    enabled: bool = False
    rules: list[Rule] = field(default_factory=list)
    rollout_percent: int = 100
    variants: list[Variant] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "description": self.description,
            "enabled": self.enabled,
            "rules": [r.to_json() for r in self.rules],
            "rolloutPercent": self.rollout_percent,
            "variants": [v.to_json() for v in self.variants],
            "createdAt": format_time(self.created_at) if self.created_at else None,
            "updatedAt": format_time(self.updated_at) if self.updated_at else None,
        }


@dataclass(frozen=True, slots=True)
class Context:
    """What a flag is evaluated for. user_id is not an attribute: rules cannot target it."""

    user_id: str = ""
    attributes: dict[str, Scalar] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class EvaluationResult:
    enabled: bool
    reason: str
    variant: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "variant": self.variant, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class AuditLog:
    """One successful change to a flag. before/after are the whole flag as JSON, or None."""

    flag_key: str
    action: str
    created_at: datetime
    before: str | None = None
    after: str | None = None
    id: int = 0


@dataclass(frozen=True, slots=True)
class Event:
    """A validated exposure (flag_key, variant) or conversion (goal)."""

    type: str
    user_id: str
    flag_key: str = ""
    variant: str = ""
    goal: str = ""


@dataclass(slots=True)
class VariantResult:
    variant: str
    exposures: int
    conversions: int
    rate: float = 0.0
    p_value: float | None = None
    significant: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "variant": self.variant,
            "exposures": self.exposures,
            "conversions": self.conversions,
            "rate": self.rate,
            "pValue": self.p_value,
            "significant": self.significant,
        }


@dataclass(slots=True)
class Results:
    flag_key: str
    goal: str
    variants: list[VariantResult]

    def to_json(self) -> dict[str, Any]:
        return {"flagKey": self.flag_key, "goal": self.goal, "variants": [v.to_json() for v in self.variants]}
