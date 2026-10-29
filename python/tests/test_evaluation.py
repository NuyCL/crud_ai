"""Properties the vectors only sample, and the Python-specific traps."""

from __future__ import annotations

import copy

from app.evaluation import evaluate
from app.model import Context, Flag, Rule, Variant


def flag(**kw) -> Flag:
    base = {"key": "f", "enabled": True, "rollout_percent": 100}
    return Flag(**{**base, **kw})


def rule_flag(value, operator="eq") -> Flag:
    return flag(rules=[Rule("x", operator, value)])


def reason(f: Flag, **attrs) -> str:
    return evaluate(f, Context(attributes=attrs)).reason


def test_the_same_input_always_gives_the_same_answer() -> None:
    f = flag(rollout_percent=50, variants=[Variant("a", 50), Variant("b", 50)])
    first = evaluate(f, Context("user-1"))
    assert all(evaluate(f, Context("user-1")) == first for _ in range(100))


def test_evaluating_does_not_change_the_flag_or_the_context() -> None:
    f = flag(rules=[Rule("country", "in", ["TH", "SG"])])
    ctx = Context("u", {"country": "TH"})
    before = copy.deepcopy((f, ctx))
    evaluate(f, ctx)
    assert (f, ctx) == before


def test_true_is_not_one_and_false_is_not_zero() -> None:
    # In Python `True == 1` and `isinstance(True, int)`: the classic port bug.
    assert reason(rule_flag(1.0), x=True) == "TARGETING_MISS"
    assert reason(rule_flag(True), x=1.0) == "TARGETING_MISS"
    assert reason(rule_flag(0.0), x=False) == "TARGETING_MISS"
    assert reason(rule_flag(False), x=0.0) == "TARGETING_MISS"
    assert reason(rule_flag(True), x=True) == "ON"
    assert reason(rule_flag(0.0), x=0.0) == "ON"


def test_a_bool_is_not_in_a_list_of_numbers_and_not_in_includes_it() -> None:
    assert reason(rule_flag([1.0, 2.0, 3.0], "in"), x=True) == "TARGETING_MISS"
    assert reason(rule_flag([1.0, 2.0, 3.0], "not_in"), x=True) == "ON"
    assert reason(rule_flag([True], "in"), x=1.0) == "TARGETING_MISS"


def test_a_string_is_not_a_number() -> None:
    assert reason(rule_flag(1.0), x="1") == "TARGETING_MISS"
    assert reason(rule_flag("1"), x=1.0) == "TARGETING_MISS"


def test_numbers_are_doubles_and_an_int_equals_the_same_float() -> None:
    assert reason(rule_flag(1), x=1.0) == "ON"  # an int that reached the evaluator from a caller other than the parser
    assert reason(rule_flag(9007199254740992.0), x=float(9007199254740993)) == "ON"
    assert reason(rule_flag(0.0), x=-0.0) == "ON"


def test_names_that_are_python_attributes_are_ordinary_attributes() -> None:
    neq = rule_flag("x", "neq")
    neq.rules[0] = Rule("__class__", "neq", "x")
    assert evaluate(neq, Context(attributes={})).reason == "TARGETING_MISS"
    assert evaluate(neq, Context(attributes={"__class__": "y"})).reason == "ON"
