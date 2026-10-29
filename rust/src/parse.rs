//! Validation of request bodies and query strings (BR-xx in spec/business-rules.md).
//!
//! The parsers take what `serde_json` returns. A JSON number is an `i64`, a `u64` or an `f64` depending on how it
//! was written; BR-30 treats `10`, `10.0` and `1e1` alike, so numbers are normalised here. `serde_json` already
//! rejects what RFC 8259 does not allow (NaN, `01`, `.5`, comments, trailing commas, raw control characters, a lone
//! surrogate escape, nesting deeper than 128) and anything after the first value.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::error::{Code, ServiceError};
use crate::model::{Context, Event, Flag, Operator, Rule, RuleValue, Scalar, Variant};
use crate::timefmt::is_leap;

pub const MAX_DESCRIPTION_CODE_POINTS: usize = 500;
pub const MIN_VARIANTS: usize = 2;
pub const MAX_VARIANTS: usize = 10;
pub const MAX_EVENTS: usize = 100;
const INT_LIMIT: i64 = 1_000_000_000;

type Result<T> = std::result::Result<T, ServiceError>;

fn validation<T>(message: impl Into<String>) -> Result<T> {
    Err(ServiceError::validation(message))
}

/// An integer within +-1e9 from a JSON number with no fractional part (`10` or `10.0`).
pub fn as_int(v: &Value) -> Option<i64> {
    let n = v.as_number()?;
    let i = if let Some(i) = n.as_i64() {
        i
    } else if n.is_u64() {
        return None; // above i64::MAX
    } else {
        let f = n.as_f64()?;
        if !f.is_finite() || f.fract() != 0.0 || f.abs() > INT_LIMIT as f64 {
            return None;
        }
        f as i64
    };
    (-INT_LIMIT..=INT_LIMIT).contains(&i).then_some(i)
}

fn non_empty_string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn valid_key(s: &str, max_len: usize) -> bool {
    let b = s.as_bytes();
    let first_ok = b.first().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    first_ok
        && b.len() <= max_len
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

const KEY_PATTERN: &str = "[a-z0-9][a-z0-9_-]{0,63}";
const VARIANT_KEY_PATTERN: &str = "[a-z0-9][a-z0-9_-]{0,31}";

/// Validate a create/replace body (BR-01, BR-04, BR-08, BR-30..35) and apply the defaults. Timestamps are 0.
pub fn flag_input(raw: &Value) -> Result<Flag> {
    let Some(body) = raw.as_object() else {
        return validation("body must be a JSON object");
    };
    let Some(key) = body.get("key").and_then(Value::as_str) else {
        return validation("key is required and must be a string");
    };
    if !valid_key(key, 64) {
        return Err(ServiceError::new(Code::InvalidKey, format!("key must match {KEY_PATTERN}")));
    }
    let mut flag = Flag {
        key: key.to_string(),
        description: String::new(),
        enabled: false,
        rules: vec![],
        rollout_percent: 100,
        variants: vec![],
        created_at: 0,
        updated_at: 0,
    };

    if let Some(v) = body.get("description") {
        let Some(text) = v.as_str() else {
            return validation("description must be a string");
        };
        // Unicode code points: not bytes (what `len()` counts) and not UTF-16 units (BR-04).
        if text.chars().count() > MAX_DESCRIPTION_CODE_POINTS {
            return validation(format!("description must be at most {MAX_DESCRIPTION_CODE_POINTS} characters"));
        }
        flag.description = text.to_string();
    }
    if let Some(v) = body.get("enabled") {
        let Some(b) = v.as_bool() else {
            return validation("enabled must be a boolean");
        };
        flag.enabled = b;
    }
    if let Some(v) = body.get("rolloutPercent") {
        match as_int(v).and_then(|n| u32::try_from(n).ok()).filter(|n| *n <= 100) {
            Some(n) => flag.rollout_percent = n,
            None => return validation("rolloutPercent must be an integer from 0 to 100"),
        }
    }
    if let Some(v) = body.get("rules") {
        flag.rules = rules(v)?;
    }
    if let Some(v) = body.get("variants") {
        flag.variants = variants(v)?;
    }
    Ok(flag)
}

fn rules(v: &Value) -> Result<Vec<Rule>> {
    let Some(items) = v.as_array() else {
        return validation("rules must be an array");
    };
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let Some(rule) = item.as_object() else {
            return validation(format!("rules[{i}] must be an object"));
        };
        let Some(attribute) = non_empty_string(rule.get("attribute")) else {
            return validation(format!("rules[{i}].attribute must be a non-empty string"));
        };
        let Some(operator) = rule.get("operator").and_then(Value::as_str).and_then(Operator::parse) else {
            return validation(format!("rules[{i}].operator must be one of eq, neq, in, not_in"));
        };
        let value = rule_value(operator, rule.get("value"))
            .map_err(|m| ServiceError::validation(format!("rules[{i}].value: {m}")))?;
        out.push(Rule { attribute: attribute.to_string(), operator, value });
    }
    Ok(out)
}

fn rule_value(operator: Operator, v: Option<&Value>) -> std::result::Result<RuleValue, &'static str> {
    if matches!(operator, Operator::In | Operator::NotIn) {
        const MESSAGE: &str = "must be a non-empty array of scalars";
        let items = v.and_then(Value::as_array).filter(|a| !a.is_empty()).ok_or(MESSAGE)?;
        let scalars: Option<Vec<Scalar>> = items.iter().map(Scalar::from_json).collect();
        return scalars.map(RuleValue::Many).ok_or(MESSAGE);
    }
    v.and_then(Scalar::from_json).map(RuleValue::One).ok_or("must be a string, number or boolean")
}

fn variants(v: &Value) -> Result<Vec<Variant>> {
    let Some(items) = v.as_array() else {
        return validation("variants must be an array");
    };
    if items.is_empty() {
        return Ok(vec![]);
    }
    if !(MIN_VARIANTS..=MAX_VARIANTS).contains(&items.len()) {
        return Err(ServiceError::variants(format!(
            "a flag with variants needs {MIN_VARIANTS} to {MAX_VARIANTS} of them"
        )));
    }
    let mut out = Vec::with_capacity(items.len()); // keeps the order the client sent
    let mut seen = HashSet::new();
    let mut total = 0;
    for (i, item) in items.iter().enumerate() {
        let Some(variant) = item.as_object() else {
            return Err(ServiceError::variants(format!("variants[{i}] must be an object")));
        };
        let Some(key) = variant.get("key").and_then(Value::as_str).filter(|k| valid_key(k, 32)) else {
            return Err(ServiceError::variants(format!("variants[{i}].key must match {VARIANT_KEY_PATTERN}")));
        };
        if !seen.insert(key) {
            return Err(ServiceError::variants(format!("variant key \"{key}\" is used twice")));
        }
        let Some(weight) = variant
            .get("weight")
            .and_then(as_int)
            .and_then(|w| u32::try_from(w).ok())
            .filter(|w| (1..=100).contains(w))
        else {
            return Err(ServiceError::variants(format!("variants[{i}].weight must be an integer from 1 to 100")));
        };
        total += weight;
        out.push(Variant { key: key.to_string(), weight });
    }
    if total != 100 {
        return Err(ServiceError::variants(format!("weights must add up to 100, got {total}")));
    }
    Ok(out)
}

/// A validated POST /v1/evaluate body. `flags` is `None` when every flag is to be evaluated (BR-23).
#[derive(Debug, Default, PartialEq)]
pub struct EvaluateRequest {
    pub flags: Option<Vec<String>>,
    pub context: Context,
}

/// Validate an evaluate body (BR-20).
pub fn evaluate_request(raw: &Value) -> Result<EvaluateRequest> {
    let Some(body) = raw.as_object() else {
        return validation("body must be a JSON object");
    };
    let mut req = EvaluateRequest::default();
    if let Some(v) = body.get("flags") {
        let names: Option<Vec<String>> =
            v.as_array().and_then(|a| a.iter().map(|f| f.as_str().map(str::to_string)).collect());
        match names {
            Some(names) => req.flags = Some(names),
            None => return validation("flags must be an array of strings"),
        }
    }
    if let Some(v) = body.get("context") {
        let Some(ctx) = v.as_object() else {
            return validation("context must be an object");
        };
        if let Some(u) = ctx.get("userId") {
            let Some(user_id) = u.as_str() else {
                return validation("context.userId must be a string");
            };
            req.context.user_id = user_id.to_string();
        }
        if let Some(a) = ctx.get("attributes") {
            let Some(attrs) = a.as_object() else {
                return validation("context.attributes must be an object");
            };
            for (name, value) in attrs {
                let Some(scalar) = Scalar::from_json(value) else {
                    return validation(format!("context.attributes.{name} must be a string, number or boolean"));
                };
                req.context.attributes.insert(name.clone(), scalar);
            }
        }
    }
    Ok(req)
}

/// Validate a POST /v1/events body (BR-43). Nothing is returned unless every event is valid.
pub fn events(raw: &Value) -> Result<Vec<Event>> {
    let Some(body) = raw.as_object() else {
        return validation("body must be a JSON object");
    };
    let items = match body.get("events").and_then(Value::as_array) {
        Some(a) if (1..=MAX_EVENTS).contains(&a.len()) => a,
        _ => return validation(format!("events must be an array of 1 to {MAX_EVENTS} events")),
    };
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let Some(e) = item.as_object() else {
            return validation(format!("events[{i}] must be an object"));
        };
        let kind = e.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "exposure" && kind != "conversion" {
            return validation(format!("events[{i}].type must be exposure or conversion"));
        }
        let Some(user_id) = non_empty_string(e.get("userId")) else {
            return validation(format!("events[{i}].userId must be a non-empty string"));
        };
        let event = if kind == "exposure" {
            let Some(flag_key) = non_empty_string(e.get("flagKey")) else {
                return validation(format!("events[{i}].flagKey is required for an exposure"));
            };
            let Some(variant) = non_empty_string(e.get("variant")) else {
                return validation(format!("events[{i}].variant is required for an exposure"));
            };
            Event::Exposure { user_id: user_id.into(), flag_key: flag_key.into(), variant: variant.into() }
        } else {
            let Some(goal) = non_empty_string(e.get("goal")) else {
                return validation(format!("events[{i}].goal is required for a conversion"));
            };
            Event::Conversion { user_id: user_id.into(), goal: goal.into() }
        };
        if let Some(ts) = e.get("timestamp") {
            if !ts.as_str().is_some_and(valid_timestamp) {
                return validation(format!("events[{i}].timestamp must be an RFC 3339 string"));
            }
        }
        out.push(event);
    }
    Ok(out)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// RFC 3339 date-time that also exists on the calendar (BR-43): `YYYY-MM-DDThh:mm:ss[.f+](Z|+-hh:mm)`, ASCII
/// digits only, ranges checked by hand.
pub fn valid_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |from: usize, to: usize| -> Option<i64> {
        let part = b.get(from..to)?;
        if part.iter().all(u8::is_ascii_digit) { std::str::from_utf8(part).ok()?.parse().ok() } else { None }
    };
    let at = |i: usize, want: u8| b.get(i) == Some(&want);
    if !(at(4, b'-') && at(7, b'-') && at(10, b'T') && at(13, b':') && at(16, b':')) {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (digits(0, 4), digits(5, 7), digits(8, 10)) else {
        return false;
    };
    let (Some(hour), Some(minute), Some(second)) = (digits(11, 13), digits(14, 16), digits(17, 19)) else {
        return false;
    };
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }
    let mut i = 19;
    if at(i, b'.') {
        i += 1;
        let start = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    match &b[i..] {
        [b'Z'] => true,
        [sign @ (b'+' | b'-'), ..] if b.len() == i + 6 && *sign != 0 => {
            at(i + 3, b':')
                && matches!((digits(i + 1, i + 3), digits(i + 4, i + 6)), (Some(h), Some(m)) if h <= 23 && m <= 59)
        }
        _ => false,
    }
}

/// Limit and offset of a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Page {
    pub limit: i64,
    pub offset: i64,
}

/// Read limit and offset from a parsed query string (BR-50). The first value of a repeated name counts.
pub fn page(query: &HashMap<String, Vec<String>>) -> Result<Page> {
    let number = |name: &str, default: i64, low: i64, high: i64| -> Result<i64> {
        let Some(text) = query.get(name).and_then(|v| v.first()) else {
            return Ok(default);
        };
        if text.is_empty() || !text.bytes().all(|c| c.is_ascii_digit()) {
            return validation(format!("{name} must be an integer"));
        }
        // never convert a 4000-digit number: more than 18 digits is out of range anyway
        let n = if text.len() < 19 { text.parse::<i64>().unwrap_or(i64::MAX) } else { i64::MAX };
        if n < low || n > high {
            return validation(format!("{name} must be between {low} and {high}"));
        }
        Ok(n)
    };
    Ok(Page { limit: number("limit", 20, 1, 100)?, offset: number("offset", 0, 0, i64::from(i32::MAX))? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap_or_else(|e| panic!("bad test JSON {text}: {e}"))
    }

    fn flag_code(text: &str) -> Option<Code> {
        flag_input(&json(text)).err().map(|e| e.code)
    }

    fn key_json(key: &str) -> String {
        json!({"key": key}).to_string()
    }

    #[test]
    fn br01_valid_keys() {
        for key in ["a", "0", "a-b_c", "9z", "a-", "a_", &"a".repeat(64)] {
            assert_eq!(flag_code(&key_json(key)), None, "{key}");
        }
    }

    #[test]
    fn br01_invalid_keys() {
        // "a\n" is accepted by a regex ending in `$`; "\u{663}" (Arabic-Indic three) by one using \d
        for key in [
            "caf\u{e9}",
            "\u{e01}",
            "-a",
            "_a",
            "A",
            "aB",
            "Ab",
            "a-B",
            "a b",
            "a.b",
            "a/b",
            "a\n",
            "\n",
            "a\0",
            "\u{663}",
            "",
            " ",
            &"a".repeat(65),
        ] {
            assert_eq!(flag_code(&key_json(key)), Some(Code::InvalidKey), "{key:?}");
        }
    }

    #[test]
    fn br01_key_must_be_a_string() {
        for text in ["{}", r#"{"key":1}"#, r#"{"key":null}"#, r#"{"key":["a"]}"#, r#"{"key":true}"#] {
            assert_eq!(flag_code(text), Some(Code::Validation), "{text}");
        }
    }

    #[test]
    fn body_must_be_an_object() {
        for text in ["[]", "1", r#""a""#, "null", "true"] {
            assert_eq!(flag_code(text), Some(Code::Validation), "{text}");
        }
    }

    #[test]
    fn br08_defaults() {
        let f = flag_input(&json(r#"{"key":"k"}"#)).unwrap();
        assert_eq!((f.description.as_str(), f.enabled, f.rollout_percent), ("", false, 100));
        assert!(f.rules.is_empty() && f.variants.is_empty());
    }

    #[test]
    fn br04_description_counts_code_points() {
        let with = |d: &str| json!({"key": "k", "description": d}).to_string();
        assert_eq!(flag_code(&with(&"x".repeat(500))), None);
        assert_eq!(flag_code(&with(&"x".repeat(501))), Some(Code::Validation));
        assert_eq!(flag_code(&with(&"\u{1f600}".repeat(500))), None); // 2000 bytes, 1000 UTF-16 units
        assert_eq!(flag_code(&with(&"\u{1f600}".repeat(501))), Some(Code::Validation));
        assert_eq!(flag_code(&with(&"\u{e01}".repeat(500))), None); // 1500 bytes
    }

    #[test]
    fn br04_wrong_types_are_rejected() {
        for text in [
            r#"{"key":"k","description":1}"#,
            r#"{"key":"k","description":null}"#,
            r#"{"key":"k","enabled":"true"}"#,
            r#"{"key":"k","enabled":1}"#,
            r#"{"key":"k","enabled":null}"#,
            r#"{"key":"k","rules":{}}"#,
            r#"{"key":"k","rules":null}"#,
            r#"{"key":"k","variants":null}"#,
            r#"{"key":"k","rolloutPercent":null}"#,
        ] {
            assert_eq!(flag_code(text), Some(Code::Validation), "{text}");
        }
    }

    #[test]
    fn br30_rollout_percent() {
        let ok = ["0", "100", "50", "10.0", "1e1", "1E1", "1e+1", "-0", "-0.0", "5.0E0"];
        let bad = [
            "101",
            "-1",
            "10.5",
            "1e3",
            "\"10\"",
            "true",
            "null",
            "[10]",
            "1e-1",
            "100.0000001",
            "99999999999999999999999999",
            "18446744073709551616",
        ];
        for literal in ok {
            assert_eq!(flag_code(&format!(r#"{{"key":"k","rolloutPercent":{literal}}}"#)), None, "{literal}");
        }
        for literal in bad {
            assert_eq!(
                flag_code(&format!(r#"{{"key":"k","rolloutPercent":{literal}}}"#)),
                Some(Code::Validation),
                "{literal}"
            );
        }
    }

    #[test]
    fn br30_out_of_range_numbers_are_not_valid_json_here() {
        // serde_json refuses a number that does not fit a double; the handler turns that into a 400 (see tests/http.rs)
        assert!(serde_json::from_str::<Value>("1e999").is_err());
        assert!(serde_json::from_str::<Value>(&format!("1{}", "0".repeat(400))).is_err());
    }

    fn variants_code(items: &str) -> Option<Code> {
        flag_code(&format!(r#"{{"key":"k","variants":{items}}}"#))
    }

    #[test]
    fn br31_to_br34_variants() {
        let (a, b) = (r#"{"key":"a","weight":50}"#, r#"{"key":"b","weight":50}"#);
        assert_eq!(variants_code("[]"), None);
        assert_eq!(variants_code(&format!("[{a},{b}]")), None);
        assert_eq!(variants_code(&format!("[{a}]")), Some(Code::InvalidVariants));
        assert_eq!(variants_code(r#"[{"key":"a","weight":100}]"#), Some(Code::InvalidVariants)); // one variant is no experiment
        for bad in [
            r#"{"key":"b","weight":49}"#,
            r#"{"key":"a","weight":50}"#,
            r#"{"key":"b","weight":0}"#,
            r#"{"key":"b","weight":50.5}"#,
            r#"{"key":"b","weight":true}"#,
            r#"{"key":"B","weight":50}"#,
            &format!(r#"{{"key":"{}","weight":50}}"#, "b".repeat(33)),
        ] {
            assert_eq!(variants_code(&format!("[{a},{bad}]")), Some(Code::InvalidVariants), "{bad}");
        }
        assert_eq!(variants_code(&format!(r#"[{a},{{"key":"{}","weight":50}}]"#, "b".repeat(32))), None);
        assert_eq!(variants_code(&format!(r#"[{a},{{"key":"b","weight":50.0}}]"#)), None);
        assert_eq!(variants_code("{}"), Some(Code::Validation));
        let many: Vec<String> = (0..10).map(|i| format!(r#"{{"key":"v{i}","weight":10}}"#)).collect();
        assert_eq!(variants_code(&format!("[{}]", many.join(","))), None);
        // 11 variants whose weights do add up to 100: only the count can reject them
        let eleven: Vec<String> =
            (0..11).map(|i| format!(r#"{{"key":"v{i}","weight":{}}}"#, if i == 0 { 10 } else { 9 })).collect();
        assert_eq!(variants_code(&format!("[{}]", eleven.join(","))), Some(Code::InvalidVariants));
        assert_eq!(
            variants_code(&format!(r#"[{},{{"key":"x","weight":1}}]"#, many.join(","))),
            Some(Code::InvalidVariants)
        );
        assert_eq!(variants_code(&format!("[{a},[],{b}]")), Some(Code::InvalidVariants));
    }

    #[test]
    fn br33_variant_order_is_kept() {
        let f =
            flag_input(&json(r#"{"key":"k","variants":[{"key":"z","weight":10},{"key":"a","weight":90}]}"#)).unwrap();
        assert_eq!(f.variants.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(), ["z", "a"]);
    }

    fn rule_code(rule: &str) -> Option<Code> {
        flag_code(&format!(r#"{{"key":"k","rules":[{rule}]}}"#))
    }

    #[test]
    fn br35_rules() {
        for ok in [
            r#"{"attribute":"a","operator":"eq","value":"x"}"#,
            r#"{"attribute":"a","operator":"neq","value":1.5}"#,
            r#"{"attribute":"a","operator":"eq","value":true}"#,
            r#"{"attribute":"a","operator":"in","value":["x",1,false]}"#,
            r#"{"attribute":"a","operator":"not_in","value":["x"]}"#,
        ] {
            assert_eq!(rule_code(ok), None, "{ok}");
        }
        for bad in [
            r#"{"attribute":"","operator":"eq","value":"x"}"#,
            r#"{"attribute":1,"operator":"eq","value":"x"}"#,
            r#"{"operator":"eq","value":"x"}"#,
            r#"{"attribute":"a","operator":"gt","value":1}"#,
            r#"{"attribute":"a","operator":["eq"],"value":1}"#,
            r#"{"attribute":"a","operator":"eq"}"#,
            r#"{"attribute":"a","operator":"eq","value":null}"#,
            r#"{"attribute":"a","operator":"eq","value":["x"]}"#,
            r#"{"attribute":"a","operator":"eq","value":{}}"#,
            r#"{"attribute":"a","operator":"in","value":"x"}"#,
            r#"{"attribute":"a","operator":"in","value":[]}"#,
            r#"{"attribute":"a","operator":"in","value":[null]}"#,
            r#"{"attribute":"a","operator":"in","value":[[1]]}"#,
            "1",
            "[]",
            "null",
        ] {
            assert_eq!(rule_code(bad), Some(Code::Validation), "{bad}");
        }
    }

    #[test]
    fn rule_values_become_doubles_and_booleans_stay_booleans() {
        let f =
            flag_input(&json(r#"{"key":"k","rules":[{"attribute":"a","operator":"in","value":[1,2.5,true,"s"]}]}"#))
                .unwrap();
        let want =
            RuleValue::Many(vec![Scalar::Num(1.0), Scalar::Num(2.5), Scalar::Bool(true), Scalar::Str("s".into())]);
        assert_eq!(f.rules[0].value, want);
    }

    #[test]
    fn br20_evaluate_request() {
        assert!(evaluate_request(&json("{}")).is_ok());
        assert!(evaluate_request(&json(r#"{"flags":[]}"#)).is_ok());
        for bad in [
            "[]",
            "1",
            "null",
            r#"{"flags":"a"}"#,
            r#"{"flags":[1]}"#,
            r#"{"flags":null}"#,
            r#"{"context":[]}"#,
            r#"{"context":{"userId":1}}"#,
            r#"{"context":{"attributes":[]}}"#,
            r#"{"context":{"attributes":{"a":null}}}"#,
            r#"{"context":{"attributes":{"a":[1]}}}"#,
            r#"{"context":{"attributes":{"a":{}}}}"#,
        ] {
            assert_eq!(evaluate_request(&json(bad)).err().map(|e| e.code), Some(Code::Validation), "{bad}");
        }
    }

    #[test]
    fn br23_flags_absent_is_not_flags_empty() {
        assert_eq!(evaluate_request(&json("{}")).unwrap().flags, None);
        assert_eq!(evaluate_request(&json(r#"{"flags":[]}"#)).unwrap().flags, Some(vec![]));
    }

    fn events_code(text: &str) -> Option<Code> {
        events(&json(text)).err().map(|e| e.code)
    }

    #[test]
    fn br43_events() {
        let ok = r#"{"type":"conversion","userId":"u","goal":"g"}"#;
        assert_eq!(events_code(&format!(r#"{{"events":[{ok}]}}"#)), None);
        assert_eq!(events_code(r#"{"events":[{"type":"exposure","userId":"u","flagKey":"f","variant":"a"}]}"#), None);
        assert_eq!(events_code(&format!(r#"{{"events":[{}]}}"#, vec![ok; 100].join(","))), None);
        let bad_events = [
            "{}".to_string(),
            "[]".into(),
            r#"{"events":[]}"#.into(),
            format!(r#"{{"events":[{}]}}"#, vec![ok; 101].join(",")),
            r#"{"events":"x"}"#.into(),
            r#"{"events":[1]}"#.into(),
            r#"{"events":[{}]}"#.into(),
            r#"{"events":[{"type":"click","userId":"u","goal":"g"}]}"#.into(),
            r#"{"events":[{"type":["conversion"],"userId":"u","goal":"g"}]}"#.into(),
            r#"{"events":[{"type":"conversion","userId":"","goal":"g"}]}"#.into(),
            r#"{"events":[{"type":"conversion","userId":1,"goal":"g"}]}"#.into(),
            r#"{"events":[{"type":"conversion","userId":"u","goal":""}]}"#.into(),
            r#"{"events":[{"type":"conversion","userId":"u"}]}"#.into(),
            r#"{"events":[{"type":"exposure","userId":"u","variant":"a"}]}"#.into(),
            r#"{"events":[{"type":"exposure","userId":"u","flagKey":"f"}]}"#.into(),
            r#"{"events":[{"type":"conversion","userId":"u","goal":"g","timestamp":1}]}"#.into(),
            r#"{"events":[{"type":"conversion","userId":"u","goal":"g","timestamp":null}]}"#.into(),
            format!(r#"{{"events":[{ok},{{"type":"conversion","userId":"u","goal":""}}]}}"#),
        ];
        for bad in &bad_events {
            assert_eq!(events_code(bad), Some(Code::Validation), "{}", &bad[..bad.len().min(80)]);
        }
    }

    #[test]
    fn br43_timestamps() {
        let ok = [
            "2026-01-31T08:00:00Z",
            "2026-01-31T15:00:00.250+07:00",
            "2026-01-31T08:00:00.1234567890Z",
            "2028-02-29T00:00:00Z",
            "2000-02-29T00:00:00Z",
            "2026-12-31T23:59:59-23:59",
        ];
        let bad = [
            "2026-02-30T00:00:00Z",
            "2027-02-29T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-10T00:00:00Z",
            "2026-01-00T00:00:00Z",
            "2026-01-31T24:00:00Z",
            "2026-01-31T00:60:00Z",
            "2026-01-31T00:00:60Z",
            "2026-01-31",
            "2026-01-31T08:00:00",
            "2026-01-31T8:00:00Z",
            "2026-01-31T08:00:00,5Z",
            "2026-01-31T08:00:00+0700",
            "2026-01-31T08:00:00+24:00",
            "2026-01-31T08:00:00+07:60",
            "2026-01-31t08:00:00Z",
            "2026-01-31T08:00:00z",
            "2026-01-31 08:00:00Z",
            "2026-01-31T08:00:00.Z",
            "20260131T080000Z",
            "26-01-31T08:00:00Z",
            "2026-01-31T08:00:00Z\n",
            " 2026-01-31T08:00:00Z",
            "",
            "\u{662}\u{660}\u{662}\u{666}-01-31T08:00:00Z",
            "\u{ff12}\u{ff10}\u{ff12}\u{ff16}-01-31T08:00:00Z",
            "2026-01-31T08:00:00+",
            "2026-01-31T08:00:00Zx",
            "2026-01-31T08:00:00+07:00x",
        ];
        for s in ok {
            assert!(valid_timestamp(s), "{s}");
        }
        for s in bad {
            assert!(!valid_timestamp(s), "{s:?}");
        }
    }

    fn query(pairs: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        pairs.iter().map(|(k, vs)| ((*k).to_string(), vs.iter().map(|v| (*v).to_string()).collect())).collect()
    }

    #[test]
    fn br50_paging() {
        assert_eq!(page(&query(&[])).unwrap(), Page { limit: 20, offset: 0 });
        assert_eq!(page(&query(&[("limit", &["1"])])).unwrap(), Page { limit: 1, offset: 0 });
        assert_eq!(page(&query(&[("limit", &["100"]), ("offset", &["5"])])).unwrap(), Page { limit: 100, offset: 5 });
        assert_eq!(page(&query(&[("limit", &["5", "999"])])).unwrap(), Page { limit: 5, offset: 0 }); // the first value counts
        assert_eq!(page(&query(&[("offset", &["2147483647"])])).unwrap().offset, 2_147_483_647);
        let big = "9".repeat(4000);
        for q in [
            query(&[("limit", &["0"])]),
            query(&[("limit", &["101"])]),
            query(&[("limit", &["-1"])]),
            query(&[("limit", &["1.5"])]),
            query(&[("limit", &["abc"])]),
            query(&[("limit", &[""])]),
            query(&[("limit", &["+1"])]),
            query(&[("limit", &["1e1"])]),
            query(&[("limit", &[" 1"])]),
            query(&[("limit", &["\u{661}"])]),
            query(&[("limit", &["999", "5"])]),
            query(&[("offset", &["-1"])]),
            query(&[("offset", &["2147483648"])]),
            query(&[("offset", &[big.as_str()])]),
            query(&[("offset", &[""])]),
        ] {
            assert_eq!(page(&q).err().map(|e| e.code), Some(Code::Validation), "{q:?}");
        }
    }

    #[test]
    fn as_int_accepts_whole_numbers_within_a_thousand_million() {
        for (text, want) in [
            ("10", 10),
            ("10.0", 10),
            ("1e1", 10),
            ("-0", 0),
            ("-0.0", 0),
            ("1e9", 1_000_000_000),
            ("-1000000000", -1_000_000_000),
        ] {
            assert_eq!(as_int(&json(text)), Some(want), "{text}");
        }
        for text in ["10.5", "1e-1", "1000000001", "18446744073709551615", "true", "\"10\"", "null", "[]"] {
            assert_eq!(as_int(&json(text)), None, "{text}");
        }
    }
}
