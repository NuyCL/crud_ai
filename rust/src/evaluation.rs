//! Decides what a flag means for a user. A pure function of its arguments: no I/O, no clock, no randomness.
//! The rules are defined in spec/evaluation.md and checked against tests/vectors.

use std::collections::HashMap;

use crate::model::{Context, EvaluationResult, Flag, Operator, Reason, Rule, RuleValue, Scalar};

const BUCKETS: u32 = 10_000;
const FNV_OFFSET: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

/// 32-bit FNV-1a of the UTF-8 bytes of `s`. `wrapping_mul` is the 32-bit overflow the hash needs; a plain `*`
/// would panic in a debug build.
pub fn fnv1a32(s: &str) -> u32 {
    let mut h = FNV_OFFSET;
    for &b in s.as_bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Map (flag key, salt, user id) to 0..9999.
pub fn bucket(flag_key: &str, salt: &str, user_id: &str) -> u32 {
    fnv1a32(&format!("{flag_key}:{salt}:{user_id}")) % BUCKETS
}

fn off(reason: Reason) -> EvaluationResult {
    EvaluationResult { enabled: false, variant: None, reason }
}

/// Evaluate `flag` for `ctx`. `None` means the flag does not exist.
pub fn evaluate(flag: Option<&Flag>, ctx: &Context) -> EvaluationResult {
    let Some(flag) = flag else {
        return off(Reason::FlagNotFound);
    };
    if !flag.enabled {
        return off(Reason::Disabled);
    }
    if !flag.rules.iter().all(|rule| rule_matches(rule, &ctx.attributes)) {
        return off(Reason::TargetingMiss);
    }

    let needs_bucket = flag.rollout_percent < 100 || !flag.variants.is_empty();
    if needs_bucket && ctx.user_id.is_empty() {
        return off(Reason::MissingUserId);
    }
    if flag.rollout_percent < 100 && bucket(&flag.key, "rollout", &ctx.user_id) >= flag.rollout_percent * 100 {
        return off(Reason::NotInRollout);
    }
    if flag.variants.is_empty() {
        return EvaluationResult { enabled: true, variant: None, reason: Reason::On };
    }

    let b = bucket(&flag.key, "variant", &ctx.user_id);
    let mut threshold = 0;
    for v in &flag.variants {
        threshold += v.weight * 100;
        if b < threshold {
            return EvaluationResult { enabled: true, variant: Some(v.key.clone()), reason: Reason::Variant };
        }
    }
    // Unreachable while the weights sum to 100, which the service guarantees.
    off(Reason::Disabled)
}

/// A missing attribute makes every operator fail, including `neq` and `not_in`.
fn rule_matches(rule: &Rule, attrs: &HashMap<String, Scalar>) -> bool {
    let Some(got) = attrs.get(&rule.attribute) else {
        return false;
    };
    match (rule.operator, &rule.value) {
        (Operator::Eq, RuleValue::One(want)) => got == want,
        (Operator::Neq, RuleValue::One(want)) => got != want,
        (Operator::In, RuleValue::Many(items)) => items.contains(got),
        (Operator::NotIn, RuleValue::Many(items)) => !items.contains(got),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Variant;

    fn flag(rules: Vec<Rule>, rollout: u32, variants: Vec<Variant>) -> Flag {
        Flag {
            key: "f".into(),
            description: String::new(),
            enabled: true,
            rules,
            rollout_percent: rollout,
            variants,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn eq_rule(want: Scalar) -> Flag {
        flag(vec![Rule { attribute: "x".into(), operator: Operator::Eq, value: RuleValue::One(want) }], 100, vec![])
    }

    fn reason(f: &Flag, got: Scalar) -> Reason {
        let ctx = Context { user_id: String::new(), attributes: HashMap::from([("x".to_string(), got)]) };
        evaluate(Some(f), &ctx).reason
    }

    #[test]
    fn same_input_same_answer() {
        let f =
            flag(vec![], 50, vec![Variant { key: "a".into(), weight: 50 }, Variant { key: "b".into(), weight: 50 }]);
        let ctx = Context { user_id: "user-1".into(), attributes: HashMap::new() };
        let first = evaluate(Some(&f), &ctx);
        assert!((0..100).all(|_| evaluate(Some(&f), &ctx) == first));
    }

    #[test]
    fn types_are_never_converted() {
        assert_eq!(reason(&eq_rule(Scalar::Num(1.0)), Scalar::Str("1".into())), Reason::TargetingMiss);
        assert_eq!(reason(&eq_rule(Scalar::Str("1".into())), Scalar::Num(1.0)), Reason::TargetingMiss);
        assert_eq!(reason(&eq_rule(Scalar::Num(1.0)), Scalar::Bool(true)), Reason::TargetingMiss);
        assert_eq!(reason(&eq_rule(Scalar::Bool(false)), Scalar::Num(0.0)), Reason::TargetingMiss);
        assert_eq!(reason(&eq_rule(Scalar::Bool(true)), Scalar::Bool(true)), Reason::On);
        assert_eq!(reason(&eq_rule(Scalar::Num(0.0)), Scalar::Num(-0.0)), Reason::On);
    }

    #[test]
    fn numbers_are_ieee_doubles() {
        assert_eq!(
            reason(&eq_rule(Scalar::Num(9_007_199_254_740_992.0)), Scalar::Num(9_007_199_254_740_993_u64 as f64)),
            Reason::On
        );
        assert_eq!(reason(&eq_rule(Scalar::Num(f64::NAN)), Scalar::Num(f64::NAN)), Reason::TargetingMiss);
    }

    #[test]
    fn a_bool_is_not_in_a_list_of_numbers() {
        let rule = |op, items| {
            flag(vec![Rule { attribute: "x".into(), operator: op, value: RuleValue::Many(items) }], 100, vec![])
        };
        let nums = vec![Scalar::Num(1.0), Scalar::Num(2.0)];
        assert_eq!(reason(&rule(Operator::In, nums.clone()), Scalar::Bool(true)), Reason::TargetingMiss);
        assert_eq!(reason(&rule(Operator::NotIn, nums), Scalar::Bool(true)), Reason::On);
    }

    #[test]
    fn a_user_id_is_needed_even_when_the_rules_match() {
        // Not in tests/vectors: every vector with rules and no user id also fails the targeting. A port that skips
        // the check when there are rules passes them all.
        let rule = Rule { attribute: "x".into(), operator: Operator::Eq, value: RuleValue::One(Scalar::Num(1.0)) };
        let ctx = Context { user_id: String::new(), attributes: HashMap::from([("x".to_string(), Scalar::Num(1.0))]) };
        let rollout = flag(vec![rule.clone()], 50, vec![]);
        assert_eq!(evaluate(Some(&rollout), &ctx).reason, Reason::MissingUserId);
        let variants = flag(
            vec![rule],
            100,
            vec![Variant { key: "a".into(), weight: 50 }, Variant { key: "b".into(), weight: 50 }],
        );
        assert_eq!(evaluate(Some(&variants), &ctx).reason, Reason::MissingUserId);
    }

    #[test]
    fn fnv_does_not_overflow_in_a_debug_build() {
        assert_eq!(fnv1a32(""), 2_166_136_261);
        assert_eq!(fnv1a32("a"), 0xe40c_292c);
        assert!(fnv1a32(&"\u{e01}".repeat(1000)) > 0);
    }
}
