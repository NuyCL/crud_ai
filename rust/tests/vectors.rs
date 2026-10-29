//! The vectors shared with every other language (tests/vectors). They are the arbiter, not these tests.

use std::collections::HashMap;
use std::path::Path;

use ffservice::erfc::erfc;
use ffservice::evaluation::{bucket, evaluate, fnv1a32};
use ffservice::model::{Context, Flag, Operator, Reason, Rule, RuleValue, Scalar, Variant};
use serde_json::Value;

fn vectors(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("vectors").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn cases(name: &str) -> Vec<Value> {
    let v = vectors(name);
    let cases = v["cases"].as_array().unwrap().clone();
    assert!(!cases.is_empty(), "{name} has no cases");
    cases
}

#[test]
fn fnv1a32_vectors() {
    for c in cases("fnv1a32.json") {
        let input = c["input"].as_str().unwrap();
        assert_eq!(u64::from(fnv1a32(input)), c["hash"].as_u64().unwrap(), "fnv1a32({input:?})");
    }
}

#[test]
fn every_row_of_bucketing() {
    for c in cases("bucketing.json") {
        let input = c["input"].as_str().unwrap();
        assert_eq!(u64::from(fnv1a32(input)), c["hash"].as_u64().unwrap(), "hash of {input:?}");
        let got = bucket(c["flagKey"].as_str().unwrap(), c["salt"].as_str().unwrap(), c["userId"].as_str().unwrap());
        assert_eq!(u64::from(got), c["bucket"].as_u64().unwrap(), "bucket of {input:?}");
    }
}

fn flag_from(d: &Value) -> Flag {
    let rules = d["rules"].as_array().map_or_else(Vec::new, |rules| {
        rules
            .iter()
            .map(|r| Rule {
                attribute: r["attribute"].as_str().unwrap().to_string(),
                operator: Operator::parse(r["operator"].as_str().unwrap()).unwrap(),
                value: match &r["value"] {
                    Value::Array(items) => {
                        RuleValue::Many(items.iter().map(|i| Scalar::from_json(i).unwrap()).collect())
                    }
                    one => RuleValue::One(Scalar::from_json(one).unwrap()),
                },
            })
            .collect()
    });
    let variants = d["variants"].as_array().map_or_else(Vec::new, |vs| {
        vs.iter()
            .map(|v| Variant {
                key: v["key"].as_str().unwrap().to_string(),
                weight: u32::try_from(v["weight"].as_u64().unwrap()).unwrap(),
            })
            .collect()
    });
    Flag {
        key: d["key"].as_str().unwrap().to_string(),
        description: d["description"].as_str().unwrap_or("").to_string(),
        enabled: d["enabled"].as_bool().unwrap(),
        rules,
        rollout_percent: u32::try_from(d["rolloutPercent"].as_u64().unwrap()).unwrap(),
        variants,
        created_at: 0,
        updated_at: 0,
    }
}

fn context_from(d: &Value) -> Context {
    let attributes: HashMap<String, Scalar> = d["attributes"]
        .as_object()
        .map_or_else(HashMap::new, |m| m.iter().map(|(k, v)| (k.clone(), Scalar::from_json(v).unwrap())).collect());
    Context { user_id: d["userId"].as_str().unwrap_or("").to_string(), attributes }
}

fn reason_of(name: &str) -> Reason {
    [
        Reason::FlagNotFound,
        Reason::Disabled,
        Reason::TargetingMiss,
        Reason::MissingUserId,
        Reason::NotInRollout,
        Reason::On,
        Reason::Variant,
    ]
    .into_iter()
    .find(|r| r.as_str() == name)
    .unwrap_or_else(|| panic!("unknown reason {name}"))
}

#[test]
fn evaluation_vectors() {
    let mut failures = vec![];
    for c in cases("evaluation.json") {
        let flag = if c["flag"].is_null() { None } else { Some(flag_from(&c["flag"])) };
        let got = evaluate(flag.as_ref(), &context_from(&c["context"]));
        let want = &c["expected"];
        let ok = got.enabled == want["enabled"].as_bool().unwrap()
            && got.variant.as_deref() == want["variant"].as_str()
            && got.reason == reason_of(want["reason"].as_str().unwrap());
        if !ok {
            failures.push(format!("{}: got {got:?}, want {want}", c["id"]));
        }
    }
    assert!(failures.is_empty(), "{} failing vector(s):\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn erfc_vectors_within_the_stated_tolerances() {
    let file = vectors("erfc.json");
    let (absolute, relative) =
        (file["absoluteTolerance"].as_f64().unwrap(), file["relativeTolerance"].as_f64().unwrap());
    for c in cases("erfc.json") {
        let (x, want) = (c["x"].as_f64().unwrap(), c["erfc"].as_f64().unwrap());
        let tolerance = absolute.max(relative * want);
        assert!((erfc(x) - want).abs() <= tolerance, "erfc({x}) = {}, want {want}", erfc(x));
    }
}
