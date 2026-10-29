"""Validation (BR-01, BR-04, BR-08, BR-20, BR-30..35, BR-43, BR-50) at the parser level."""

from __future__ import annotations

import json

import pytest

from app.errors import ServiceError
from app.parse import (
    clean,
    parse_evaluate_request,
    parse_events,
    parse_flag_input,
    parse_page,
    valid_timestamp,
)


def code_of(fn, *args) -> str:
    try:
        fn(*args)
    except ServiceError as e:
        return e.code
    return ""


def flag_code(text: str) -> str:
    return code_of(parse_flag_input, json.loads(text))


@pytest.mark.parametrize(
    ("key", "ok"),
    [
        ("a", True),
        ("0", True),
        ("a-b_c", True),
        ("a" * 64, True),
        ("a" * 65, False),
        ("", False),
        ("-a", False),
        ("_a", False),
        ("A", False),
        ("aB", False),
        ("Ab", False),
        ("a-B", False),
        ("a b", False),
        ("a.b", False),
        ("a/b", False),
        ("a\n", False),  # `$` would accept a trailing newline
        ("٣", False),  # an Arabic-Indic digit: \d would accept it
        ("café", False),
        ("ก", False),
    ],
)
def test_br01_key_format(key: str, ok: bool) -> None:
    assert (flag_code(json.dumps({"key": key})) == "") is ok


def test_br01_key_must_be_a_string() -> None:
    for text in ("{}", '{"key":1}', '{"key":null}', '{"key":["a"]}', '{"key":true}'):
        assert flag_code(text) == "VALIDATION_ERROR", text
    assert flag_code('{"key":"A"}') == "INVALID_KEY"


def test_body_must_be_an_object() -> None:
    for text in ("[]", "1", '"a"', "null", "true"):
        assert flag_code(text) == "VALIDATION_ERROR", text


def test_br08_defaults() -> None:
    f = parse_flag_input({"key": "k"})
    assert (f.description, f.enabled, f.rollout_percent, f.rules, f.variants) == ("", False, 100, [], [])


def test_br04_description_counts_code_points() -> None:
    assert flag_code(json.dumps({"key": "k", "description": "x" * 500})) == ""
    assert flag_code(json.dumps({"key": "k", "description": "x" * 501})) == "VALIDATION_ERROR"
    assert flag_code(json.dumps({"key": "k", "description": "\U0001f600" * 500})) == ""  # 1000 UTF-16 units, 2000 bytes
    assert flag_code(json.dumps({"key": "k", "description": "\U0001f600" * 501})) == "VALIDATION_ERROR"
    assert flag_code(json.dumps({"key": "k", "description": "ก" * 500})) == ""


@pytest.mark.parametrize(
    "text",
    [
        '{"key":"k","description":1}',
        '{"key":"k","description":null}',
        '{"key":"k","enabled":"true"}',
        '{"key":"k","enabled":1}',
        '{"key":"k","enabled":null}',
        '{"key":"k","rules":{}}',
        '{"key":"k","rules":null}',
        '{"key":"k","variants":null}',
        '{"key":"k","rolloutPercent":null}',
    ],
)
def test_br04_wrong_types_are_rejected(text: str) -> None:
    assert flag_code(text) == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    ("literal", "ok"),
    [
        ("0", True),
        ("100", True),
        ("50", True),
        ("10.0", True),
        ("1e1", True),
        ("1E1", True),
        ("1e+1", True),
        ("-0", True),
        ("-0.0", True),
        ("5.0E0", True),
        ("101", False),
        ("-1", False),
        ("10.5", False),
        ("1e999", False),
        ("1e3", False),
        ('"10"', False),
        ("true", False),
        ("null", False),
        ("[10]", False),
        ("1e-1", False),
        ("100.0000001", False),
        ("99999999999999999999999999", False),
        ("1" + "0" * 400, False),
    ],
)
def test_br30_rollout_percent(literal: str, ok: bool) -> None:
    assert (flag_code('{"key":"k","rolloutPercent":' + literal + "}") == "") is ok, literal


def test_br31_to_br34_variants() -> None:
    def v(items: str) -> str:
        return flag_code('{"key":"k","variants":' + items + "}")

    a, b = '{"key":"a","weight":50}', '{"key":"b","weight":50}'
    assert v("[]") == ""
    assert v(f"[{a},{b}]") == ""
    assert v(f"[{a}]") == "INVALID_VARIANTS"
    assert v('[{"key":"a","weight":100}]') == "INVALID_VARIANTS"  # one variant is not an experiment
    assert v(f'[{a},{{"key":"b","weight":49}}]') == "INVALID_VARIANTS"
    assert v(f'[{a},{{"key":"a","weight":50}}]') == "INVALID_VARIANTS"
    assert v(f'[{a},{{"key":"b","weight":0}}]') == "INVALID_VARIANTS"
    assert v(f'[{a},{{"key":"b","weight":50.5}}]') == "INVALID_VARIANTS"
    assert v(f'[{a},{{"key":"b","weight":true}}]') == "INVALID_VARIANTS"
    assert v(f'[{a},{{"key":"B","weight":50}}]') == "INVALID_VARIANTS"
    assert v(f'[{a},{{"key":"{"b" * 33}","weight":50}}]') == "INVALID_VARIANTS"
    assert v(f'[{a},{{"key":"{"b" * 32}","weight":50}}]') == ""
    assert v(f'[{a},{{"key":"b","weight":50.0}}]') == ""
    assert v("{}") == "VALIDATION_ERROR"
    many = ",".join(f'{{"key":"v{i}","weight":10}}' for i in range(10))
    assert v(f"[{many}]") == ""
    assert v(f'[{many},{{"key":"x","weight":1}}]') == "INVALID_VARIANTS"
    # 11 variants whose weights do add up to 100: only the count can reject them
    eleven = ",".join(f'{{"key":"v{i}","weight":{10 if i == 0 else 9}}}' for i in range(11))
    assert v(f"[{eleven}]") == "INVALID_VARIANTS"
    assert v(f"[{a},[],{b}]") == "INVALID_VARIANTS"


def test_br33_variant_order_is_kept() -> None:
    f = parse_flag_input(json.loads('{"key":"k","variants":[{"key":"z","weight":10},{"key":"a","weight":90}]}'))
    assert [x.key for x in f.variants] == ["z", "a"]


def test_br35_rules() -> None:
    def r(rule: str) -> str:
        return flag_code('{"key":"k","rules":[' + rule + "]}")

    assert r('{"attribute":"a","operator":"eq","value":"x"}') == ""
    assert r('{"attribute":"a","operator":"neq","value":1.5}') == ""
    assert r('{"attribute":"a","operator":"eq","value":true}') == ""
    assert r('{"attribute":"a","operator":"in","value":["x",1,false]}') == ""
    assert r('{"attribute":"a","operator":"not_in","value":["x"]}') == ""
    for bad in (
        '{"attribute":"","operator":"eq","value":"x"}',
        '{"attribute":1,"operator":"eq","value":"x"}',
        '{"operator":"eq","value":"x"}',
        '{"attribute":"a","operator":"gt","value":1}',
        '{"attribute":"a","operator":["eq"],"value":1}',
        '{"attribute":"a","operator":"eq"}',
        '{"attribute":"a","operator":"eq","value":null}',
        '{"attribute":"a","operator":"eq","value":["x"]}',
        '{"attribute":"a","operator":"eq","value":{}}',
        '{"attribute":"a","operator":"in","value":"x"}',
        '{"attribute":"a","operator":"in","value":[]}',
        '{"attribute":"a","operator":"in","value":[null]}',
        '{"attribute":"a","operator":"in","value":[[1]]}',
        '{"attribute":"a","operator":"eq","value":1e999}',
        '{"attribute":"a","operator":"eq","value":1' + "0" * 400 + "}",
        "1",
        "[]",
        "null",
    ):
        assert r(bad) == "VALIDATION_ERROR", bad


def test_rule_values_become_floats_and_booleans_stay_booleans() -> None:
    f = parse_flag_input(json.loads('{"key":"k","rules":[{"attribute":"a","operator":"in","value":[1,2.5,true,"s"]}]}'))
    value = f.rules[0].value
    assert value == [1.0, 2.5, True, "s"]
    assert [type(x) for x in value] == [float, float, bool, str]


def test_br20_evaluate_request() -> None:
    assert code_of(parse_evaluate_request, {}) == ""
    assert code_of(parse_evaluate_request, {"flags": []}) == ""
    for bad in (
        [],
        1,
        None,
        {"flags": "a"},
        {"flags": [1]},
        {"flags": None},
        {"context": []},
        {"context": {"userId": 1}},
        {"context": {"attributes": []}},
        {"context": {"attributes": {"a": None}}},
        {"context": {"attributes": {"a": [1]}}},
        {"context": {"attributes": {"a": {}}}},
    ):
        assert code_of(parse_evaluate_request, bad) == "VALIDATION_ERROR", bad


def test_br23_flags_absent_is_not_flags_empty() -> None:
    assert parse_evaluate_request({}).flags is None
    assert parse_evaluate_request({"flags": []}).flags == []


def test_br43_events() -> None:
    ok = {"type": "conversion", "userId": "u", "goal": "g"}
    assert code_of(parse_events, {"events": [ok]}) == ""
    assert (
        code_of(parse_events, {"events": [{"type": "exposure", "userId": "u", "flagKey": "f", "variant": "a"}]}) == ""
    )
    assert code_of(parse_events, {"events": [ok] * 100}) == ""
    for bad in (
        {},
        [],
        {"events": []},
        {"events": [ok] * 101},
        {"events": "x"},
        {"events": [1]},
        {"events": [{}]},
        {"events": [{**ok, "type": "click"}]},
        {"events": [{**ok, "type": ["conversion"]}]},
        {"events": [{**ok, "userId": ""}]},
        {"events": [{**ok, "userId": 1}]},
        {"events": [{**ok, "goal": ""}]},
        {"events": [{"type": "conversion", "userId": "u"}]},
        {"events": [{"type": "exposure", "userId": "u", "variant": "a"}]},
        {"events": [{"type": "exposure", "userId": "u", "flagKey": "f"}]},
        {"events": [{**ok, "timestamp": 1}]},
        {"events": [{**ok, "timestamp": None}]},
        {"events": [ok, {**ok, "goal": ""}]},
    ):
        assert code_of(parse_events, bad) == "VALIDATION_ERROR", bad


@pytest.mark.parametrize(
    ("stamp", "ok"),
    [
        ("2026-01-31T08:00:00Z", True),
        ("2026-01-31T15:00:00.250+07:00", True),
        ("2026-01-31T08:00:00.1234567890Z", True),
        ("2028-02-29T00:00:00Z", True),
        ("2000-02-29T00:00:00Z", True),
        ("2026-12-31T23:59:59-23:59", True),
        ("2026-02-30T00:00:00Z", False),
        ("2027-02-29T00:00:00Z", False),
        ("1900-02-29T00:00:00Z", False),
        ("2026-04-31T00:00:00Z", False),
        ("2026-13-01T00:00:00Z", False),
        ("2026-00-10T00:00:00Z", False),
        ("2026-01-00T00:00:00Z", False),
        ("2026-01-31T24:00:00Z", False),
        ("2026-01-31T00:60:00Z", False),
        ("2026-01-31T00:00:60Z", False),
        ("2026-01-31", False),
        ("2026-01-31T08:00:00", False),
        ("2026-01-31T8:00:00Z", False),
        ("2026-01-31T08:00:00,5Z", False),
        ("2026-01-31T08:00:00+0700", False),
        ("2026-01-31T08:00:00+24:00", False),
        ("2026-01-31T08:00:00+07:60", False),
        ("2026-01-31t08:00:00Z", False),
        ("2026-01-31T08:00:00z", False),
        ("2026-01-31 08:00:00Z", False),
        ("2026-01-31T08:00:00.Z", False),
        ("2026-01-31T08:00:00Z\n", False),
        (" 2026-01-31T08:00:00Z", False),
        ("", False),
        ("٢٠٢٦-01-31T08:00:00Z", False),
        ("２０２６-01-31T08:00:00Z", False),
        ("20260131T080000Z", False),
        ("26-01-31T08:00:00Z", False),
    ],
)
def test_br43_timestamps(stamp: str, ok: bool) -> None:
    assert valid_timestamp(stamp) is ok


def test_br50_paging() -> None:
    assert parse_page({}) == (20, 0)
    assert parse_page({"limit": ["1"]}) == (1, 0)
    assert parse_page({"limit": ["100"], "offset": ["5"]}) == (100, 5)
    assert parse_page({"limit": ["5", "999"]}) == (5, 0)  # the first value of a repeated parameter counts
    assert parse_page({"offset": ["2147483647"]}) == (20, 2147483647)
    for query in (
        {"limit": ["0"]},
        {"limit": ["101"]},
        {"limit": ["-1"]},
        {"limit": ["1.5"]},
        {"limit": ["abc"]},
        {"limit": [""]},
        {"limit": ["+1"]},
        {"limit": ["1e1"]},
        {"limit": [" 1"]},
        {"limit": ["١"]},
        {"limit": ["999", "5"]},
        {"offset": ["-1"]},
        {"offset": ["2147483648"]},
        {"offset": ["9" * 4000]},
        {"offset": [""]},
    ):
        assert code_of(parse_page, query) == "VALIDATION_ERROR", query


def test_clean_replaces_lone_surrogates_everywhere_and_keeps_pairs() -> None:
    value = json.loads('{"a\\ud800":["\\udc00x", "\\ud83d\\ude00", {"k":"\\ud83d"}], "n": 1, "t": true}')
    assert clean(value) == {"a�": ["�x", "\U0001f600", {"k": "�"}], "n": 1, "t": True}
