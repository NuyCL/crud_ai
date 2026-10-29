//! The business rules (BR-xx in spec/business-rules.md) on top of the repository. It knows nothing about HTTP:
//! failures are `ServiceError`s carrying a machine-readable code, and the handler maps codes to status codes.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::error::{Code, ServiceError};
use crate::evaluation::evaluate;
use crate::model::{
    ACTION_CREATE, ACTION_DELETE, ACTION_UPDATE, AuditLog, EvaluationResult, Flag, Results, VariantResult,
};
use crate::parse::{self, Page};
use crate::repository::{RepoError, Repository};
use crate::timefmt::now_ms;

/// The smallest number of exposures per variant for which a p-value is reported (BR-42).
pub const MIN_SAMPLE_FOR_SIGNIFICANCE: u64 = 30;

/// Anything the service cannot blame on the client.
#[derive(Debug)]
pub enum Error {
    /// The client's mistake, with the code to report.
    Client(ServiceError),
    /// The database failed; the details go to the log, not to the client.
    Storage(String),
}

impl From<ServiceError> for Error {
    fn from(e: ServiceError) -> Self {
        Error::Client(e)
    }
}

impl From<RepoError> for Error {
    fn from(e: RepoError) -> Self {
        match e {
            // The service maps these to client errors itself where they mean something; reaching here is a bug.
            RepoError::NotFound => Error::Storage("unexpected NotFound".into()),
            RepoError::Exists => Error::Storage("unexpected Exists".into()),
            RepoError::Storage(m) => Error::Storage(m),
        }
    }
}

type Result<T> = std::result::Result<T, Error>;

fn not_found(key: &str) -> Error {
    ServiceError::new(Code::FlagNotFound, format!("flag \"{key}\" not found")).into()
}

pub struct Service<R: Repository> {
    repo: R,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl<R: Repository> Service<R> {
    pub fn new(repo: R) -> Self {
        Self { repo, now: Box::new(now_ms) }
    }

    /// For tests: a controllable clock (milliseconds since the epoch).
    pub fn with_clock(repo: R, now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        Self { repo, now: Box::new(now) }
    }

    // ---------------------------------------------------------------- flags

    /// Validate `raw` (a decoded JSON body) and store a new flag with its audit entry (BR-01, BR-02, BR-07, BR-08).
    pub fn create_flag(&self, raw: &Value) -> Result<Flag> {
        let mut flag = parse::flag_input(raw)?;
        let at = (self.now)();
        flag.created_at = at;
        flag.updated_at = at;
        let stored = self.repo.transaction(|tx| {
            tx.insert_flag(&flag)?;
            tx.append_audit(&audit_entry(ACTION_CREATE, &flag.key, None, Some(&flag), at))
        });
        match stored {
            Ok(()) => Ok(flag),
            Err(RepoError::Exists) => {
                Err(ServiceError::new(Code::FlagExists, format!("flag \"{}\" already exists", flag.key)).into())
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn get_flag(&self, key: &str) -> Result<Flag> {
        self.repo.get_flag(key).map_err(|e| match e {
            RepoError::NotFound => not_found(key),
            other => other.into(),
        })
    }

    pub fn list_flags(&self, page: Page) -> Result<(Vec<Flag>, u64)> {
        Ok(self.repo.list_flags(page.limit, page.offset)?)
    }

    /// Replace the flag at `key` (BR-03, BR-05, BR-09). Fields the body leaves out go back to their defaults.
    pub fn update_flag(&self, key: &str, raw: &Value) -> Result<Flag> {
        let mut flag = parse::flag_input(raw)?;
        if flag.key != key {
            return Err(ServiceError::new(
                Code::KeyImmutable,
                format!("key cannot be changed from \"{key}\" to \"{}\"", flag.key),
            )
            .into());
        }
        let at = (self.now)();
        let result = self.repo.transaction(|tx| {
            let old = tx.get_flag(key)?;
            flag.created_at = old.created_at;
            flag.updated_at = at.max(old.updated_at); // never goes backwards
            tx.update_flag(&flag)?;
            tx.append_audit(&audit_entry(ACTION_UPDATE, key, Some(&old), Some(&flag), at))
        });
        match result {
            Ok(()) => Ok(flag),
            Err(RepoError::NotFound) => Err(not_found(key)),
            Err(e) => Err(e.into()),
        }
    }

    /// Remove a flag and record it in the audit log (BR-06).
    pub fn delete_flag(&self, key: &str) -> Result<()> {
        let at = (self.now)();
        let result = self.repo.transaction(|tx| {
            let old = tx.get_flag(key)?;
            tx.delete_flag(key)?;
            tx.append_audit(&audit_entry(ACTION_DELETE, key, Some(&old), None, at))
        });
        match result {
            Err(RepoError::NotFound) => Err(not_found(key)),
            other => Ok(other?),
        }
    }

    pub fn list_audit(&self, flag_key: Option<&str>, page: Page) -> Result<(Vec<AuditLog>, u64)> {
        Ok(self.repo.list_audit(flag_key, page.limit, page.offset)?)
    }

    // ------------------------------------------------------------- evaluate

    /// Evaluate flags for the context in `raw`. Writes nothing (BR-22).
    pub fn evaluate(&self, raw: &Value) -> Result<BTreeMap<String, EvaluationResult>> {
        let req = parse::evaluate_request(raw)?;
        let mut results = BTreeMap::new();
        match req.flags {
            None => {
                for flag in self.repo.list_all_flags()? {
                    results.insert(flag.key.clone(), evaluate(Some(&flag), &req.context));
                }
            }
            Some(keys) => {
                for key in keys {
                    let flag = match self.repo.get_flag(&key) {
                        Ok(flag) => Some(flag),
                        Err(RepoError::NotFound) => None, // an unknown flag is a normal answer, not a failure (BR-21)
                        Err(e) => return Err(e.into()),
                    };
                    let result = evaluate(flag.as_ref(), &req.context);
                    results.insert(key, result);
                }
            }
        }
        Ok(results)
    }

    // --------------------------------------------------------------- events

    /// Validate and store a batch; returns how many events it contained (BR-43, BR-44).
    pub fn record_events(&self, raw: &Value) -> Result<usize> {
        let events = parse::events(raw)?;
        self.repo.record_events(&events)?;
        Ok(events.len())
    }

    /// The experiment report of a flag for a goal (BR-42, BR-46).
    pub fn results(&self, flag_key: &str, goal: &str) -> Result<Results> {
        if goal.is_empty() {
            return Err(ServiceError::validation("goal is required").into());
        }
        let flag = self.get_flag(flag_key)?;
        let (exposures, conversions) = self.repo.variant_counts(flag_key, goal)?;

        let mut rows: Vec<VariantResult> = flag
            .variants
            .iter()
            .map(|v| {
                let e = exposures.get(&v.key).copied().unwrap_or(0);
                let c = conversions.get(&v.key).copied().unwrap_or(0);
                VariantResult {
                    variant: v.key.clone(),
                    exposures: e,
                    conversions: c,
                    rate: if e > 0 { c as f64 / e as f64 } else { 0.0 },
                    p_value: None,
                    significant: false,
                }
            })
            .collect();
        // Every variant is compared with the first one, the control.
        if let Some((control, others)) = rows.split_first_mut() {
            for row in others {
                row.p_value = two_proportion_p_value(control, row);
                row.significant = row.p_value.is_some_and(|p| p < 0.05);
            }
        }
        Ok(Results { flag_key: flag_key.to_string(), goal: goal.to_string(), variants: rows })
    }
}

/// The pooled, two-sided two-proportion z-test of BR-42; `None` if a group is too small or the standard error is 0.
fn two_proportion_p_value(control: &VariantResult, treatment: &VariantResult) -> Option<f64> {
    if control.exposures < MIN_SAMPLE_FOR_SIGNIFICANCE || treatment.exposures < MIN_SAMPLE_FOR_SIGNIFICANCE {
        return None;
    }
    let (n1, n2) = (control.exposures as f64, treatment.exposures as f64);
    let pooled = (control.conversions + treatment.conversions) as f64 / (n1 + n2);
    let se = (pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2)).sqrt();
    if se == 0.0 {
        return None;
    }
    let z = (treatment.rate - control.rate) / se;
    Some(crate::erfc::erfc(z.abs() / std::f64::consts::SQRT_2))
}

/// Snapshot before and after as JSON, in the same shape the API returns for a flag.
fn audit_entry(action: &str, key: &str, before: Option<&Flag>, after: Option<&Flag>, at: i64) -> AuditLog {
    AuditLog {
        id: 0,
        flag_key: key.to_string(),
        action: action.to_string(),
        before: before.map(|f| f.to_json().to_string()),
        after: after.map(|f| f.to_json().to_string()),
        created_at: at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::SqliteRepository;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    const TWO_ARMS: &str = r#""variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]"#;
    const T0: i64 = 1_769_846_400_000; // 2026-01-31T08:00:00Z

    /// A clock that hands out a later time (one second) on every call.
    fn svc() -> Service<SqliteRepository> {
        let ticks = Arc::new(AtomicI64::new(T0));
        Service::with_clock(SqliteRepository::open(":memory:").unwrap(), move || {
            ticks.fetch_add(1000, Ordering::SeqCst) + 1000
        })
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn create(s: &Service<SqliteRepository>, body: &str) -> Flag {
        s.create_flag(&json(body)).unwrap_or_else(|e| panic!("create {body}: {e:?}"))
    }

    fn code<T>(r: Result<T>) -> Option<Code> {
        match r {
            Err(Error::Client(e)) => Some(e.code),
            Err(Error::Storage(m)) => panic!("storage failure: {m}"),
            Ok(_) => None,
        }
    }

    fn page(limit: i64, offset: i64) -> Page {
        Page { limit, offset }
    }

    fn actions(s: &Service<SqliteRepository>) -> Vec<String> {
        let (logs, _) = s.list_audit(None, page(100, 0)).unwrap();
        logs.iter().rev().map(|l| format!("{}:{}", l.flag_key, l.action)).collect()
    }

    fn reasons(s: &Service<SqliteRepository>, body: &str) -> BTreeMap<String, &'static str> {
        s.evaluate(&json(body)).unwrap().into_iter().map(|(k, v)| (k, v.reason.as_str())).collect()
    }

    #[test]
    fn br02_duplicate_key_is_rejected_and_nothing_is_audited() {
        let s = svc();
        create(&s, r#"{"key":"f","description":"first"}"#);
        assert_eq!(code(s.create_flag(&json(r#"{"key":"f","description":"second"}"#))), Some(Code::FlagExists));
        assert_eq!(s.get_flag("f").unwrap().description, "first");
        assert_eq!(actions(&s), ["f:create"]);
    }

    #[test]
    fn br04_text_survives_a_store_and_load_byte_for_byte() {
        let s = svc();
        let text = "caf\u{e9} \u{e44}\u{e17}\u{e22} \u{1f600} \0 \"q\" \\ \n";
        s.create_flag(&json!({"key": "f", "description": text})).unwrap();
        assert_eq!(s.get_flag("f").unwrap().description, text);
    }

    #[test]
    fn br05_unknown_flag_is_not_found() {
        let s = svc();
        assert_eq!(code(s.get_flag("ghost")), Some(Code::FlagNotFound));
        assert_eq!(code(s.update_flag("ghost", &json(r#"{"key":"ghost"}"#))), Some(Code::FlagNotFound));
        assert_eq!(code(s.delete_flag("ghost")), Some(Code::FlagNotFound));
    }

    #[test]
    fn br09_update_is_a_full_replace_and_keeps_created_at() {
        let s = svc();
        let created = create(
            &s,
            r#"{"key":"f","description":"d","enabled":true,"rolloutPercent":10,"rules":[{"attribute":"a","operator":"eq","value":1}]}"#,
        );
        let updated = s.update_flag("f", &json(r#"{"key":"f","enabled":false}"#)).unwrap();
        assert_eq!((updated.description.as_str(), updated.enabled, updated.rollout_percent), ("", false, 100));
        assert!(updated.rules.is_empty() && updated.variants.is_empty());
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.updated_at > created.updated_at);
        assert_eq!(s.get_flag("f").unwrap(), updated);
    }

    #[test]
    fn br09_updated_at_never_goes_backwards() {
        let times = [T0 + 10_000, T0 + 5_000];
        let next = Arc::new(AtomicI64::new(0));
        let s = Service::with_clock(SqliteRepository::open(":memory:").unwrap(), move || {
            times[next.fetch_add(1, Ordering::SeqCst) as usize]
        });
        let created = create(&s, r#"{"key":"f"}"#);
        let updated = s.update_flag("f", &json(r#"{"key":"f"}"#)).unwrap();
        assert_eq!(updated.updated_at, created.updated_at);
    }

    #[test]
    fn br03_key_cannot_change_and_nothing_is_written() {
        let s = svc();
        create(&s, r#"{"key":"f"}"#);
        assert_eq!(code(s.update_flag("f", &json(r#"{"key":"g"}"#))), Some(Code::KeyImmutable));
        assert_eq!(actions(&s), ["f:create"]);
        assert_eq!(code(s.get_flag("g")), Some(Code::FlagNotFound));
    }

    #[test]
    fn br51_validation_comes_before_existence_checks() {
        let s = svc();
        assert_eq!(code(s.update_flag("ghost", &json(r#"{"key":"BAD"}"#))), Some(Code::InvalidKey));
        assert_eq!(code(s.update_flag("ghost", &json(r#"{"key":"other"}"#))), Some(Code::KeyImmutable));
        assert_eq!(
            code(s.update_flag("ghost", &json(r#"{"key":"ghost","rolloutPercent":101}"#))),
            Some(Code::Validation)
        );
    }

    #[test]
    fn br06_delete_removes_the_flag_and_allows_reuse_of_the_key() {
        let s = svc();
        create(&s, r#"{"key":"f","description":"one"}"#);
        s.delete_flag("f").unwrap();
        assert_eq!(code(s.get_flag("f")), Some(Code::FlagNotFound));
        create(&s, r#"{"key":"f","description":"two"}"#);
        assert_eq!(s.get_flag("f").unwrap().description, "two");
    }

    #[test]
    fn br21_evaluating_a_deleted_flag_reports_flag_not_found() {
        let s = svc();
        create(&s, r#"{"key":"f","enabled":true}"#);
        assert_eq!(reasons(&s, r#"{"flags":["f"]}"#)["f"], "ON");
        s.delete_flag("f").unwrap();
        assert_eq!(reasons(&s, r#"{"flags":["f"]}"#)["f"], "FLAG_NOT_FOUND");
    }

    #[test]
    fn br07_each_change_writes_one_audit_entry_with_before_and_after() {
        let s = svc();
        create(&s, r#"{"key":"f","description":"v1"}"#);
        s.update_flag("f", &json(r#"{"key":"f","description":"v2"}"#)).unwrap();
        s.delete_flag("f").unwrap();
        let (logs, total) = s.list_audit(Some("f"), page(10, 0)).unwrap();
        assert_eq!(total, 3);
        let parsed = |t: &Option<String>| t.as_deref().map(json);
        let (delete, update, creation) = (&logs[0], &logs[1], &logs[2]);
        assert_eq!((creation.action.as_str(), parsed(&creation.before)), ("create", None));
        assert_eq!(parsed(&creation.after).unwrap()["description"], "v1");
        assert_eq!(parsed(&update.before).unwrap()["description"], "v1");
        assert_eq!(parsed(&update.after).unwrap()["description"], "v2");
        assert_eq!((delete.action.as_str(), parsed(&delete.after)), ("delete", None));
        assert_eq!(parsed(&delete.before).unwrap()["description"], "v2");
        let keys: Vec<String> = parsed(&creation.after).unwrap().as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 8);
        for k in ["key", "description", "enabled", "rules", "rolloutPercent", "variants", "createdAt", "updatedAt"] {
            assert!(keys.iter().any(|x| x == k), "{k}");
        }
    }

    #[test]
    fn br07_rejected_changes_are_not_audited() {
        let s = svc();
        create(&s, r#"{"key":"f"}"#);
        assert_eq!(code(s.create_flag(&json(r#"{"key":"f"}"#))), Some(Code::FlagExists));
        assert_eq!(code(s.create_flag(&json(r#"{"key":"BAD"}"#))), Some(Code::InvalidKey));
        assert_eq!(code(s.update_flag("f", &json(r#"{"key":"g"}"#))), Some(Code::KeyImmutable));
        assert_eq!(code(s.delete_flag("ghost")), Some(Code::FlagNotFound));
        assert_eq!(actions(&s), ["f:create"]);
    }

    #[test]
    fn br23_flags_selects_what_is_evaluated() {
        let s = svc();
        create(&s, r#"{"key":"a","enabled":true}"#);
        create(&s, r#"{"key":"b","enabled":false}"#);
        assert_eq!(reasons(&s, "{}").keys().collect::<Vec<_>>(), ["a", "b"]);
        assert!(reasons(&s, r#"{"flags":[]}"#).is_empty());
        assert_eq!(reasons(&s, r#"{"flags":["a","ghost","a"]}"#).keys().collect::<Vec<_>>(), ["a", "ghost"]);
        assert_eq!(reasons(&s, r#"{"flags":["ghost"]}"#)["ghost"], "FLAG_NOT_FOUND");
        assert_eq!(reasons(&s, "{}")["b"], "DISABLED");
    }

    #[test]
    fn br22_evaluate_writes_nothing() {
        let s = svc();
        create(&s, &format!(r#"{{"key":"f","enabled":true,{TWO_ARMS}}}"#));
        let snapshot = |s: &Service<SqliteRepository>| {
            (s.list_flags(page(10, 0)).unwrap(), s.list_audit(None, page(10, 0)).unwrap(), s.results("f", "g").unwrap())
        };
        let before = snapshot(&s);
        for i in 0..20 {
            s.evaluate(&json(&format!(r#"{{"flags":["f"],"context":{{"userId":"u{i}"}}}}"#))).unwrap();
        }
        assert_eq!(snapshot(&s), before);
    }

    #[test]
    fn br44_a_batch_with_one_bad_event_stores_nothing() {
        let s = svc();
        create(&s, &format!(r#"{{"key":"f","enabled":true,{TWO_ARMS}}}"#));
        let good = r#"{"type":"exposure","userId":"u","flagKey":"f","variant":"control"}"#;
        assert_eq!(
            code(s.record_events(&json(&format!(r#"{{"events":[{good},{{"type":"oops"}}]}}"#)))),
            Some(Code::Validation)
        );
        assert_eq!(s.results("f", "g").unwrap().variants[0].exposures, 0);
        assert_eq!(s.record_events(&json(&format!(r#"{{"events":[{good}]}}"#))).unwrap(), 1);
        assert_eq!(s.results("f", "g").unwrap().variants[0].exposures, 1);
    }

    #[test]
    fn br46_results_errors_and_shape() {
        let s = svc();
        assert_eq!(code(s.results("ghost", "g")), Some(Code::FlagNotFound));
        assert_eq!(code(s.results("ghost", "")), Some(Code::Validation)); // the goal is checked first
        create(&s, r#"{"key":"plain"}"#);
        assert!(s.results("plain", "g").unwrap().variants.is_empty());
        create(&s, &format!(r#"{{"key":"f",{TWO_ARMS}}}"#));
        assert_eq!(
            s.results("f", "g").unwrap().variants[0],
            VariantResult {
                variant: "control".into(),
                exposures: 0,
                conversions: 0,
                rate: 0.0,
                p_value: None,
                significant: false
            }
        );
    }

    fn exposures(flag: &str, prefix: &str, variant: &str, n: usize) -> Vec<Value> {
        (0..n)
            .map(|i| json!({"type": "exposure", "userId": format!("{prefix}{i}"), "flagKey": flag, "variant": variant}))
            .collect()
    }

    fn conversions(goal: &str, prefix: &str, n: usize) -> Vec<Value> {
        (0..n).map(|i| json!({"type": "conversion", "userId": format!("{prefix}{i}"), "goal": goal})).collect()
    }

    fn record(s: &Service<SqliteRepository>, groups: Vec<Vec<Value>>) {
        let events: Vec<Value> = groups.into_iter().flatten().collect();
        for chunk in events.chunks(100) {
            s.record_events(&json!({"events": chunk})).unwrap(); // a request holds at most 100 events (BR-43)
        }
    }

    fn two_arm_flag(s: &Service<SqliteRepository>, key: &str) {
        create(s, &format!(r#"{{"key":"{key}","enabled":true,{TWO_ARMS}}}"#));
    }

    #[test]
    fn br40_br41_counting_rules() {
        let s = svc();
        two_arm_flag(&s, "f");
        record(&s, vec![exposures("f", "c", "control", 3), exposures("f", "c", "treatment", 3)]); // same users again: first wins
        record(&s, vec![conversions("buy", "c", 2), conversions("buy", "c", 2), conversions("buy", "nobody", 5)]);
        let rows = s.results("f", "buy").unwrap().variants;
        assert_eq!((rows[0].exposures, rows[0].conversions, rows[1].exposures), (3, 2, 0));
        assert!((rows[0].rate - 2.0 / 3.0).abs() < 1e-12);
    }

    #[test]
    fn br42_small_samples_report_no_p_value() {
        let s = svc();
        two_arm_flag(&s, "f");
        record(
            &s,
            vec![exposures("f", "c", "control", 29), exposures("f", "t", "treatment", 29), conversions("buy", "t", 29)],
        );
        assert!(s.results("f", "buy").unwrap().variants.iter().all(|r| r.p_value.is_none() && !r.significant));
        record(&s, vec![exposures("f", "x", "control", 1)]); // control now has 30, treatment still 29
        assert!(s.results("f", "buy").unwrap().variants[1].p_value.is_none());
        record(&s, vec![exposures("f", "y", "treatment", 1)]);
        assert!(s.results("f", "buy").unwrap().variants[1].p_value.is_some());
    }

    #[test]
    fn br42_two_proportion_z_test_and_the_significance_threshold() {
        // (control conversions, treatment conversions, p, significant); the first row is worked out in Go's test:
        // pooled p = 0.15, se = 0.035707, z = 2.80056, p = erfc(z / sqrt 2) = 0.0051014
        for (c, t, p, significant) in [
            (20, 40, 0.005_101_399_646_004_991, true),
            (40, 20, 0.005_101_399_646_004_991, true),
            (20, 33, 0.055_210_703_038_259_36, false),
            (20, 34, 0.040_516_972_802_932_93, true),
        ] {
            let s = svc();
            two_arm_flag(&s, "f");
            record(
                &s,
                vec![
                    exposures("f", "c", "control", 200),
                    exposures("f", "t", "treatment", 200),
                    conversions("buy", "c", c),
                    conversions("buy", "t", t),
                ],
            );
            let rows = s.results("f", "buy").unwrap().variants;
            assert!(rows[0].p_value.is_none() && !rows[0].significant);
            assert!((rows[1].p_value.unwrap() - p).abs() < 1e-9, "{c}/{t}: {:?}", rows[1].p_value);
            assert_eq!(rows[1].significant, significant, "{c}/{t}");
        }
    }

    #[test]
    fn br42_identical_rates_and_no_variation_have_no_significance() {
        let s = svc();
        two_arm_flag(&s, "same");
        record(
            &s,
            vec![
                exposures("same", "c", "control", 100),
                exposures("same", "t", "treatment", 100),
                conversions("buy", "c", 30),
                conversions("buy", "t", 30),
            ],
        );
        let row = &s.results("same", "buy").unwrap().variants[1];
        assert!((row.p_value.unwrap() - 1.0).abs() < 1e-12 && !row.significant);

        two_arm_flag(&s, "none");
        record(&s, vec![exposures("none", "c", "control", 40), exposures("none", "t", "treatment", 40)]);
        let none = &s.results("none", "never-converted").unwrap().variants[1]; // a goal no other experiment used
        assert!(none.p_value.is_none() && !none.significant); // standard error 0
    }

    #[test]
    fn listing_pages_in_key_order_with_total() {
        let s = svc();
        for key in ["c", "a", "b"] {
            create(&s, &format!(r#"{{"key":"{key}"}}"#));
        }
        let (flags, total) = s.list_flags(page(2, 1)).unwrap();
        assert_eq!((flags.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), total), (vec!["b", "c"], 3));
    }

    #[test]
    fn timestamps_are_utc_rfc_3339_with_milliseconds() {
        let s = svc();
        assert_eq!(create(&s, r#"{"key":"f"}"#).to_json()["createdAt"], "2026-01-31T08:00:01.000Z");
    }
}
