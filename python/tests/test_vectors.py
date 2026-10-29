"""The vectors shared with every other language (tests/vectors). They are the arbiter, not these tests."""

from __future__ import annotations

import math

import pytest

from app.evaluation import bucket, evaluate, fnv1a32
from app.model import Context, EvaluationResult, Flag, Rule, Variant
from app.parse import as_scalar
from tests.conftest import load_vectors


def _flag(d: dict | None) -> Flag | None:
    if d is None:
        return None
    return Flag(
        key=d["key"],
        description=d.get("description", ""),
        enabled=d["enabled"],
        rules=[Rule(r["attribute"], r["operator"], _value(r["value"])) for r in d.get("rules", [])],
        rollout_percent=d["rolloutPercent"],
        variants=[Variant(v["key"], v["weight"]) for v in d.get("variants", [])],
    )


def _value(v: object) -> object:
    return [as_scalar(x) for x in v] if isinstance(v, list) else as_scalar(v)


def _context(d: dict) -> Context:
    return Context(d.get("userId", ""), {k: as_scalar(v) for k, v in (d.get("attributes") or {}).items()})


FNV = load_vectors("fnv1a32.json")["cases"]
BUCKETING = load_vectors("bucketing.json")["cases"]
EVALUATION = load_vectors("evaluation.json")["cases"]
ERFC = load_vectors("erfc.json")


def test_the_vector_files_are_not_empty() -> None:
    assert len(FNV) > 0
    assert len(BUCKETING) > 0
    assert len(EVALUATION) > 0
    assert len(ERFC["cases"]) > 0


@pytest.mark.parametrize("case", FNV, ids=lambda c: repr(c["input"][:20]))
def test_fnv1a32(case: dict) -> None:
    assert fnv1a32(case["input"]) == case["hash"]


def test_every_row_of_bucketing() -> None:
    for c in BUCKETING:
        assert fnv1a32(c["input"]) == c["hash"], c["input"]
        assert bucket(c["flagKey"], c["salt"], c["userId"]) == c["bucket"], c["input"]


@pytest.mark.parametrize("case", EVALUATION, ids=lambda c: c["id"])
def test_evaluation(case: dict) -> None:
    e = case["expected"]
    want = EvaluationResult(enabled=e["enabled"], variant=e["variant"], reason=e["reason"])
    assert evaluate(_flag(case["flag"]), _context(case["context"])) == want


def test_erfc_vectors_match_within_the_stated_tolerances() -> None:
    for c in ERFC["cases"]:
        tolerance = max(ERFC["absoluteTolerance"], ERFC["relativeTolerance"] * c["erfc"])
        assert abs(math.erfc(c["x"]) - c["erfc"]) <= tolerance, c
