//! The data types shared by every layer. The JSON shape follows spec/openapi.yaml.

use serde_json::{Map, Value, json};

use crate::timefmt::format_time;

/// A scalar in a rule or an attribute. Numbers are always `f64`, so equality never depends on how a number was
/// written in JSON; the derived `PartialEq` compares variants first, so a string is never a number and a bool is
/// never a number.
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    Str(String),
    Num(f64),
    Bool(bool),
}

impl Scalar {
    /// `None` for null, arrays, objects and numbers that do not fit a double.
    pub fn from_json(v: &Value) -> Option<Scalar> {
        match v {
            Value::String(s) => Some(Scalar::Str(s.clone())),
            Value::Bool(b) => Some(Scalar::Bool(*b)),
            Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(Scalar::Num),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Scalar::Str(s) => Value::String(s.clone()),
            Scalar::Num(f) => json!(f),
            Scalar::Bool(b) => Value::Bool(*b),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    Eq,
    Neq,
    In,
    NotIn,
}

impl Operator {
    pub fn parse(s: &str) -> Option<Operator> {
        match s {
            "eq" => Some(Operator::Eq),
            "neq" => Some(Operator::Neq),
            "in" => Some(Operator::In),
            "not_in" => Some(Operator::NotIn),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Operator::Eq => "eq",
            Operator::Neq => "neq",
            Operator::In => "in",
            Operator::NotIn => "not_in",
        }
    }
}

/// The value of a rule: one scalar for eq/neq, a non-empty list for in/not_in.
#[derive(Debug, Clone, PartialEq)]
pub enum RuleValue {
    One(Scalar),
    Many(Vec<Scalar>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub attribute: String,
    pub operator: Operator,
    pub value: RuleValue,
}

impl Rule {
    pub fn to_json(&self) -> Value {
        let value = match &self.value {
            RuleValue::One(s) => s.to_json(),
            RuleValue::Many(items) => Value::Array(items.iter().map(Scalar::to_json).collect()),
        };
        json!({"attribute": self.attribute, "operator": self.operator.as_str(), "value": value})
    }
}

/// One arm of an experiment. The weights of a flag's variants sum to 100.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub key: String,
    pub weight: u32,
}

/// A feature flag definition. Timestamps are milliseconds since the epoch; the service sets them.
#[derive(Debug, Clone, PartialEq)]
pub struct Flag {
    pub key: String,
    pub description: String,
    pub enabled: bool,
    pub rules: Vec<Rule>,
    pub rollout_percent: u32,
    pub variants: Vec<Variant>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Flag {
    pub fn to_json(&self) -> Value {
        json!({
            "key": self.key,
            "description": self.description,
            "enabled": self.enabled,
            "rules": self.rules.iter().map(Rule::to_json).collect::<Vec<_>>(),
            "rolloutPercent": self.rollout_percent,
            "variants": self.variants.iter().map(|v| json!({"key": v.key, "weight": v.weight})).collect::<Vec<_>>(),
            "createdAt": format_time(self.created_at),
            "updatedAt": format_time(self.updated_at),
        })
    }
}

/// What a flag is evaluated for. `user_id` is not an attribute: rules cannot target it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Context {
    pub user_id: String,
    pub attributes: std::collections::HashMap<String, Scalar>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    FlagNotFound,
    Disabled,
    TargetingMiss,
    MissingUserId,
    NotInRollout,
    On,
    Variant,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::FlagNotFound => "FLAG_NOT_FOUND",
            Reason::Disabled => "DISABLED",
            Reason::TargetingMiss => "TARGETING_MISS",
            Reason::MissingUserId => "MISSING_USER_ID",
            Reason::NotInRollout => "NOT_IN_ROLLOUT",
            Reason::On => "ON",
            Reason::Variant => "VARIANT",
        }
    }
}

/// The outcome of evaluating one flag. `variant` is `Some` only when the reason is `Variant`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationResult {
    pub enabled: bool,
    pub variant: Option<String>,
    pub reason: Reason,
}

impl EvaluationResult {
    pub fn to_json(&self) -> Value {
        json!({"enabled": self.enabled, "variant": self.variant, "reason": self.reason.as_str()})
    }
}

pub const ACTION_CREATE: &str = "create";
pub const ACTION_UPDATE: &str = "update";
pub const ACTION_DELETE: &str = "delete";

/// One successful change to a flag. `before` and `after` are the whole flag as JSON text, or `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditLog {
    pub id: i64,
    pub flag_key: String,
    pub action: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub created_at: i64,
}

/// A validated exposure or conversion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Exposure { user_id: String, flag_key: String, variant: String },
    Conversion { user_id: String, goal: String },
}

/// One row of an experiment report. `p_value` is `None` when it is not reported (BR-42).
#[derive(Debug, Clone, PartialEq)]
pub struct VariantResult {
    pub variant: String,
    pub exposures: u64,
    pub conversions: u64,
    pub rate: f64,
    pub p_value: Option<f64>,
    pub significant: bool,
}

impl VariantResult {
    pub fn to_json(&self) -> Value {
        json!({
            "variant": self.variant,
            "exposures": self.exposures,
            "conversions": self.conversions,
            "rate": self.rate,
            "pValue": self.p_value,
            "significant": self.significant,
        })
    }
}

/// The experiment report of one flag for one goal.
#[derive(Debug, Clone, PartialEq)]
pub struct Results {
    pub flag_key: String,
    pub goal: String,
    pub variants: Vec<VariantResult>,
}

impl Results {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("flagKey".into(), json!(self.flag_key));
        m.insert("goal".into(), json!(self.goal));
        m.insert("variants".into(), Value::Array(self.variants.iter().map(VariantResult::to_json).collect()));
        Value::Object(m)
    }
}
