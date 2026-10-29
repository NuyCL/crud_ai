//! Storage of flags, the audit log and experiment events. The service depends on the traits here, not on SQLite.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::model::{AuditLog, Event, Flag, Operator, Rule, RuleValue, Scalar, Variant};
use crate::timefmt::{format_time, parse_time};

#[derive(Debug)]
pub enum RepoError {
    /// The flag does not exist.
    NotFound,
    /// Inserting a flag whose key is taken.
    Exists,
    /// The database failed, or held something unreadable. Not the client's fault.
    Storage(String),
}

impl From<rusqlite::Error> for RepoError {
    fn from(e: rusqlite::Error) -> Self {
        RepoError::Storage(e.to_string())
    }
}

type Result<T> = std::result::Result<T, RepoError>;

/// The operations that must commit or roll back together: a flag change and its audit entry.
pub trait Tx {
    fn get_flag(&self, key: &str) -> Result<Flag>;
    fn insert_flag(&self, flag: &Flag) -> Result<()>;
    fn update_flag(&self, flag: &Flag) -> Result<()>;
    fn delete_flag(&self, key: &str) -> Result<()>;
    fn append_audit(&self, entry: &AuditLog) -> Result<()>;
}

/// Everything the service needs from storage.
pub trait Repository: Send + Sync {
    /// Run `work` in a transaction. If it returns an error (or panics) everything it did is rolled back.
    fn transaction<T>(&self, work: impl FnOnce(&dyn Tx) -> Result<T>) -> Result<T>;
    fn get_flag(&self, key: &str) -> Result<Flag>;
    /// One page ordered by key ascending, and the total count.
    fn list_flags(&self, limit: i64, offset: i64) -> Result<(Vec<Flag>, u64)>;
    fn list_all_flags(&self) -> Result<Vec<Flag>>;
    /// One page, newest first. A `flag_key` of `None` means every flag.
    fn list_audit(&self, flag_key: Option<&str>, limit: i64, offset: i64) -> Result<(Vec<AuditLog>, u64)>;
    /// Store all events or none. The first exposure of a (flag, user) wins; a (goal, user) conversion counts once.
    fn record_events(&self, events: &[Event]) -> Result<()>;
    /// Per variant key: the number of exposed users, and how many of them converted on `goal`.
    fn variant_counts(&self, flag_key: &str, goal: &str) -> Result<(HashMap<String, u64>, HashMap<String, u64>)>;
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS flags (
    key             TEXT PRIMARY KEY,
    description     TEXT NOT NULL,
    enabled         INTEGER NOT NULL,
    rules           TEXT NOT NULL,
    rollout_percent INTEGER NOT NULL,
    variants        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_key   TEXT NOT NULL,
    action     TEXT NOT NULL,
    before     TEXT,
    after      TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_flag_key ON audit_logs (flag_key, id);
CREATE TABLE IF NOT EXISTS exposures (
    flag_key TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    variant  TEXT NOT NULL,
    PRIMARY KEY (flag_key, user_id)
);
CREATE TABLE IF NOT EXISTS conversions (
    goal    TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (goal, user_id)
);";

const FLAG_COLUMNS: &str = "key, description, enabled, rules, rollout_percent, variants, created_at, updated_at";

/// SQLite through `rusqlite` (SQLite itself is compiled in: the `bundled` feature).
///
/// One connection serves the whole process behind a mutex, and an operation, including a whole transaction, holds it,
/// so statements from different request tasks never interleave (the Go version gets the same effect from a pool of one
/// connection). The lock is std's, not tokio's: nothing here awaits while holding it.
pub struct SqliteRepository {
    conn: Mutex<Connection>,
}

impl SqliteRepository {
    /// Open (and create if needed) the database at `path`; `:memory:` gives a private in-memory database.
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        if path != ":memory:" {
            conn.pragma_update(None, "journal_mode", "WAL")?;
        }
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// A panic inside a transaction poisons the mutex, but the transaction was rolled back on the way out and the
    /// connection is fine: carry on instead of failing every later request.
    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn json_to_scalar(v: &serde_json::Value) -> Result<Scalar> {
    Scalar::from_json(v).ok_or_else(|| RepoError::Storage(format!("corrupt scalar {v}")))
}

fn rules_from(text: &str) -> Result<Vec<Rule>> {
    let corrupt = |what: &str| RepoError::Storage(format!("corrupt rules: {what}"));
    let items: Vec<serde_json::Value> = serde_json::from_str(text).map_err(|e| corrupt(&e.to_string()))?;
    items
        .iter()
        .map(|item| {
            let operator = item["operator"].as_str().and_then(Operator::parse).ok_or_else(|| corrupt("operator"))?;
            let value = match &item["value"] {
                serde_json::Value::Array(list) => {
                    RuleValue::Many(list.iter().map(json_to_scalar).collect::<Result<_>>()?)
                }
                one => RuleValue::One(json_to_scalar(one)?),
            };
            Ok(Rule {
                attribute: item["attribute"].as_str().ok_or_else(|| corrupt("attribute"))?.to_string(),
                operator,
                value,
            })
        })
        .collect()
}

fn variants_from(text: &str) -> Result<Vec<Variant>> {
    let corrupt = |what: &str| RepoError::Storage(format!("corrupt variants: {what}"));
    let items: Vec<serde_json::Value> = serde_json::from_str(text).map_err(|e| corrupt(&e.to_string()))?;
    items
        .iter()
        .map(|item| {
            let weight =
                item["weight"].as_u64().and_then(|w| u32::try_from(w).ok()).ok_or_else(|| corrupt("weight"))?;
            Ok(Variant { key: item["key"].as_str().ok_or_else(|| corrupt("key"))?.to_string(), weight })
        })
        .collect()
}

fn flag_from(row: &rusqlite::Row<'_>) -> Result<Flag> {
    let time = |column: usize| -> Result<i64> {
        let text: String = row.get(column)?;
        parse_time(&text).ok_or_else(|| RepoError::Storage(format!("corrupt timestamp {text:?}")))
    };
    Ok(Flag {
        key: row.get(0)?,
        description: row.get(1)?,
        enabled: row.get::<_, i64>(2)? != 0,
        rules: rules_from(&row.get::<_, String>(3)?)?,
        rollout_percent: row.get(4)?,
        variants: variants_from(&row.get::<_, String>(5)?)?,
        created_at: time(6)?,
        updated_at: time(7)?,
    })
}

fn query_flag(conn: &Connection, key: &str) -> Result<Flag> {
    let mut stmt = conn.prepare_cached(&format!("SELECT {FLAG_COLUMNS} FROM flags WHERE key = ?1"))?;
    let mut rows = stmt.query(params![key])?;
    match rows.next()? {
        Some(row) => flag_from(row),
        None => Err(RepoError::NotFound),
    }
}

fn rules_json(flag: &Flag) -> String {
    serde_json::Value::Array(flag.rules.iter().map(Rule::to_json).collect()).to_string()
}

fn variants_json(flag: &Flag) -> String {
    serde_json::Value::Array(
        flag.variants.iter().map(|v| serde_json::json!({"key": v.key, "weight": v.weight})).collect(),
    )
    .to_string()
}

struct SqlTx<'a>(&'a Transaction<'a>);

impl Tx for SqlTx<'_> {
    fn get_flag(&self, key: &str) -> Result<Flag> {
        query_flag(self.0, key)
    }

    fn insert_flag(&self, f: &Flag) -> Result<()> {
        let taken: Option<i64> =
            self.0.query_row("SELECT 1 FROM flags WHERE key = ?1", params![f.key], |r| r.get(0)).optional()?;
        if taken.is_some() {
            return Err(RepoError::Exists);
        }
        self.0.execute(
            &format!("INSERT INTO flags ({FLAG_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
            params![
                f.key,
                f.description,
                i64::from(f.enabled),
                rules_json(f),
                f.rollout_percent,
                variants_json(f),
                format_time(f.created_at),
                format_time(f.updated_at)
            ],
        )?;
        Ok(())
    }

    fn update_flag(&self, f: &Flag) -> Result<()> {
        let changed = self.0.execute(
            "UPDATE flags SET description = ?1, enabled = ?2, rules = ?3, rollout_percent = ?4, variants = ?5, updated_at = ?6 WHERE key = ?7",
            params![f.description, i64::from(f.enabled), rules_json(f), f.rollout_percent, variants_json(f), format_time(f.updated_at), f.key],
        )?;
        if changed == 0 { Err(RepoError::NotFound) } else { Ok(()) }
    }

    fn delete_flag(&self, key: &str) -> Result<()> {
        let changed = self.0.execute("DELETE FROM flags WHERE key = ?1", params![key])?;
        if changed == 0 { Err(RepoError::NotFound) } else { Ok(()) }
    }

    fn append_audit(&self, a: &AuditLog) -> Result<()> {
        self.0.execute(
            "INSERT INTO audit_logs (flag_key, action, before, after, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![a.flag_key, a.action, a.before, a.after, format_time(a.created_at)],
        )?;
        Ok(())
    }
}

fn count(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<u64> {
    Ok(conn.query_row(sql, args, |r| r.get::<_, i64>(0))?.unsigned_abs())
}

fn counts(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<HashMap<String, u64>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(args, |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?.unsigned_abs())))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

impl Repository for SqliteRepository {
    fn transaction<T>(&self, work: impl FnOnce(&dyn Tx) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // an Err, or a panic that unwinds through here, drops `tx` uncommitted: SQLite rolls back
        let out = work(&SqlTx(&tx))?;
        tx.commit()?;
        Ok(out)
    }

    fn get_flag(&self, key: &str) -> Result<Flag> {
        query_flag(&self.lock(), key)
    }

    fn list_flags(&self, limit: i64, offset: i64) -> Result<(Vec<Flag>, u64)> {
        let conn = self.lock();
        let total = count(&conn, "SELECT COUNT(*) FROM flags", &[])?;
        let mut stmt =
            conn.prepare_cached(&format!("SELECT {FLAG_COLUMNS} FROM flags ORDER BY key ASC LIMIT ?1 OFFSET ?2"))?;
        let mut rows = stmt.query(params![limit, offset])?;
        let mut flags = vec![];
        while let Some(row) = rows.next()? {
            flags.push(flag_from(row)?);
        }
        Ok((flags, total))
    }

    fn list_all_flags(&self) -> Result<Vec<Flag>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(&format!("SELECT {FLAG_COLUMNS} FROM flags ORDER BY key ASC"))?;
        let mut rows = stmt.query([])?;
        let mut flags = vec![];
        while let Some(row) = rows.next()? {
            flags.push(flag_from(row)?);
        }
        Ok(flags)
    }

    fn list_audit(&self, flag_key: Option<&str>, limit: i64, offset: i64) -> Result<(Vec<AuditLog>, u64)> {
        let conn = self.lock();
        let (where_clause, filter): (&str, Vec<&dyn rusqlite::ToSql>) = match &flag_key {
            Some(k) => (" WHERE flag_key = ?1", vec![k]),
            None => ("", vec![]),
        };
        let total = count(&conn, &format!("SELECT COUNT(*) FROM audit_logs{where_clause}"), &filter)?;
        let next = filter.len() + 1;
        let sql = format!(
            "SELECT id, flag_key, action, before, after, created_at FROM audit_logs{where_clause} ORDER BY id DESC LIMIT ?{next} OFFSET ?{}",
            next + 1
        );
        let mut args = filter;
        args.push(&limit);
        args.push(&offset);
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut rows = stmt.query(args.as_slice())?;
        let mut logs = vec![];
        while let Some(row) = rows.next()? {
            let at: String = row.get(5)?;
            logs.push(AuditLog {
                id: row.get(0)?,
                flag_key: row.get(1)?,
                action: row.get(2)?,
                before: row.get(3)?,
                after: row.get(4)?,
                created_at: parse_time(&at).ok_or_else(|| RepoError::Storage(format!("corrupt timestamp {at:?}")))?,
            });
        }
        Ok((logs, total))
    }

    fn record_events(&self, events: &[Event]) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for event in events {
            match event {
                Event::Exposure { user_id, flag_key, variant } => tx.execute(
                    "INSERT OR IGNORE INTO exposures (flag_key, user_id, variant) VALUES (?1, ?2, ?3)",
                    params![flag_key, user_id, variant],
                )?,
                Event::Conversion { user_id, goal } => tx.execute(
                    "INSERT OR IGNORE INTO conversions (goal, user_id) VALUES (?1, ?2)",
                    params![goal, user_id],
                )?,
            };
        }
        tx.commit()?;
        Ok(())
    }

    fn variant_counts(&self, flag_key: &str, goal: &str) -> Result<(HashMap<String, u64>, HashMap<String, u64>)> {
        let conn = self.lock();
        let exposures = counts(
            &conn,
            "SELECT variant, COUNT(*) FROM exposures WHERE flag_key = ?1 GROUP BY variant",
            &[&flag_key],
        )?;
        let conversions = counts(
            &conn,
            "SELECT e.variant, COUNT(*) FROM exposures e JOIN conversions c ON c.user_id = e.user_id AND c.goal = ?1 WHERE e.flag_key = ?2 GROUP BY e.variant",
            &[&goal, &flag_key],
        )?;
        Ok((exposures, conversions))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(key: &str) -> Flag {
        Flag {
            key: key.into(),
            description: String::new(),
            enabled: false,
            rules: vec![],
            rollout_percent: 100,
            variants: vec![],
            created_at: 1_769_846_400_250,
            updated_at: 1_769_846_400_250,
        }
    }

    fn repo() -> SqliteRepository {
        SqliteRepository::open(":memory:").unwrap()
    }

    fn put(r: &SqliteRepository, f: &Flag) {
        r.transaction(|tx| tx.insert_flag(f)).unwrap();
    }

    fn audit(key: &str, action: &str, before: Option<&str>, after: Option<&str>) -> AuditLog {
        AuditLog {
            id: 0,
            flag_key: key.into(),
            action: action.into(),
            before: before.map(Into::into),
            after: after.map(Into::into),
            created_at: 1_769_846_400_250,
        }
    }

    #[test]
    fn insert_then_get_round_trips_every_field() {
        let r = repo();
        let mut f = make("f");
        f.description = "caf\u{e9} \u{e01} \u{1f600} \0 end".into();
        f.enabled = true;
        f.rollout_percent = 37;
        f.rules = vec![
            Rule {
                attribute: "country".into(),
                operator: Operator::In,
                value: RuleValue::Many(vec![Scalar::Str("TH".into()), Scalar::Num(1.5), Scalar::Bool(true)]),
            },
            Rule { attribute: "age".into(), operator: Operator::Neq, value: RuleValue::One(Scalar::Num(18.0)) },
        ];
        f.variants = vec![Variant { key: "b".into(), weight: 30 }, Variant { key: "a".into(), weight: 70 }];
        put(&r, &f);
        assert_eq!(r.get_flag("f").unwrap(), f);
    }

    #[test]
    fn empty_rules_and_variants_come_back_empty() {
        let r = repo();
        put(&r, &make("f"));
        let got = r.get_flag("f").unwrap();
        assert!(got.rules.is_empty() && got.variants.is_empty());
    }

    #[test]
    fn unknown_flag_is_not_found() {
        assert!(matches!(repo().get_flag("ghost"), Err(RepoError::NotFound)));
    }

    #[test]
    fn duplicate_key_is_exists_and_keeps_the_original() {
        let r = repo();
        let mut first = make("f");
        first.description = "first".into();
        put(&r, &first);
        let mut second = make("f");
        second.description = "second".into();
        assert!(matches!(r.transaction(|tx| tx.insert_flag(&second)), Err(RepoError::Exists)));
        assert_eq!(r.get_flag("f").unwrap().description, "first");
    }

    #[test]
    fn update_replaces_fields_but_keeps_created_at() {
        let r = repo();
        put(&r, &make("f"));
        let mut changed = make("f");
        changed.description = "new".into();
        changed.enabled = true;
        changed.created_at = 0;
        changed.updated_at = 1_800_000_000_000;
        r.transaction(|tx| tx.update_flag(&changed)).unwrap();
        let got = r.get_flag("f").unwrap();
        assert_eq!(
            (got.description.as_str(), got.enabled, got.created_at, got.updated_at),
            ("new", true, 1_769_846_400_250, 1_800_000_000_000)
        );
    }

    #[test]
    fn update_and_delete_of_an_unknown_flag_are_not_found() {
        let r = repo();
        assert!(matches!(r.transaction(|tx| tx.update_flag(&make("ghost"))), Err(RepoError::NotFound)));
        assert!(matches!(r.transaction(|tx| tx.delete_flag("ghost")), Err(RepoError::NotFound)));
    }

    #[test]
    fn list_flags_is_sorted_by_key_and_paged_with_total() {
        let r = repo();
        for key in ["c", "a", "e", "b", "d"] {
            put(&r, &make(key));
        }
        let (page, total) = r.list_flags(2, 1).unwrap();
        assert_eq!((page.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), total), (vec!["b", "c"], 5));
        assert_eq!(r.list_flags(10, 5).unwrap(), (vec![], 5));
        assert_eq!(
            r.list_all_flags().unwrap().iter().map(|f| f.key.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c", "d", "e"]
        );
    }

    #[test]
    fn a_failed_transaction_rolls_back_flag_and_audit_together() {
        let r = repo();
        let result: Result<()> = r.transaction(|tx| {
            tx.insert_flag(&make("f"))?;
            tx.append_audit(&audit("f", "create", None, Some("{}")))?;
            Err(RepoError::Storage("boom".into()))
        });
        assert!(matches!(result, Err(RepoError::Storage(_))));
        assert!(matches!(r.get_flag("f"), Err(RepoError::NotFound)));
        assert_eq!(r.list_audit(None, 10, 0).unwrap().1, 0);
    }

    #[test]
    fn a_panic_inside_a_transaction_does_not_strand_the_connection() {
        let r = repo();
        for _ in 0..3 {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = r.transaction(|tx| -> Result<()> {
                    tx.insert_flag(&make("f"))?;
                    panic!("a bug, not an error value");
                });
            }));
            assert!(outcome.is_err());
        }
        put(&r, &make("f")); // would fail if the connection were still inside the earlier transaction
        assert_eq!(r.get_flag("f").unwrap().key, "f");
    }

    #[test]
    fn audit_is_newest_first_filtered_and_keeps_null_before_after() {
        let r = repo();
        r.transaction(|tx| {
            tx.append_audit(&audit("a", "create", None, Some(r#"{"k":1}"#)))?;
            tx.append_audit(&audit("b", "create", None, Some(r#"{"k":2}"#)))?;
            tx.append_audit(&audit("a", "delete", Some(r#"{"k":1}"#), None))
        })
        .unwrap();
        let (all, total) = r.list_audit(None, 10, 0).unwrap();
        assert_eq!(total, 3);
        assert_eq!(
            all.iter().map(|x| format!("{}:{}", x.flag_key, x.action)).collect::<Vec<_>>(),
            ["a:delete", "b:create", "a:create"]
        );
        assert_eq!((all[0].before.as_deref(), all[0].after.as_deref()), (Some(r#"{"k":1}"#), None));
        assert_eq!(all[2].before, None);
        assert!(all[0].id > all[1].id && all[1].id > all[2].id);
        let (only_a, total_a) = r.list_audit(Some("a"), 10, 0).unwrap();
        assert_eq!(
            (total_a, only_a.iter().map(|x| x.action.as_str()).collect::<Vec<_>>()),
            (2, vec!["delete", "create"])
        );
        let (page, total_page) = r.list_audit(None, 1, 1).unwrap();
        assert_eq!((total_page, page[0].flag_key.as_str()), (3, "b"));
        assert_eq!(r.list_audit(Some(""), 10, 0).unwrap().1, 0); // an empty filter is a filter, not "no filter"
    }

    fn exposure(user: &str, variant: &str) -> Event {
        Event::Exposure { user_id: user.into(), flag_key: "f".into(), variant: variant.into() }
    }

    fn conversion(user: &str, goal: &str) -> Event {
        Event::Conversion { user_id: user.into(), goal: goal.into() }
    }

    #[test]
    fn first_exposure_wins_and_duplicates_count_once() {
        let r = repo();
        r.record_events(&[exposure("u1", "a"), exposure("u1", "b"), exposure("u1", "a"), exposure("u2", "b")]).unwrap();
        assert_eq!(
            r.variant_counts("f", "buy").unwrap().0,
            HashMap::from([("a".to_string(), 1), ("b".to_string(), 1)])
        );
    }

    #[test]
    fn conversions_count_once_per_user_and_only_for_exposed_users() {
        let r = repo();
        r.record_events(&[exposure("u1", "a"), exposure("u2", "a"), exposure("u3", "b")]).unwrap();
        r.record_events(&[
            conversion("u1", "buy"),
            conversion("u1", "buy"),
            conversion("u3", "buy"),
            conversion("stranger", "buy"),
            conversion("u2", "other"),
        ])
        .unwrap();
        let (exposures, conversions) = r.variant_counts("f", "buy").unwrap();
        assert_eq!(exposures, HashMap::from([("a".to_string(), 2), ("b".to_string(), 1)]));
        assert_eq!(conversions, HashMap::from([("a".to_string(), 1), ("b".to_string(), 1)]));
    }

    #[test]
    fn record_events_is_all_or_nothing() {
        let r = repo();
        // make the second insert fail inside SQLite, so that the first one has to be undone
        r.lock().execute_batch("CREATE TRIGGER no_bad_users BEFORE INSERT ON exposures WHEN NEW.user_id = 'bad' BEGIN SELECT RAISE(ABORT, 'no'); END;").unwrap();
        assert!(matches!(r.record_events(&[exposure("u1", "a"), exposure("bad", "a")]), Err(RepoError::Storage(_))));
        assert!(r.variant_counts("f", "buy").unwrap().0.is_empty());
    }

    #[test]
    fn data_survives_reopening_a_file_database() {
        let dir =
            std::env::temp_dir().join(format!("ffservice-rs-{}-{}", std::process::id(), crate::timefmt::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flags.db");
        let mut f = make("f");
        f.description = "kept".into();
        put(&SqliteRepository::open(path.to_str().unwrap()).unwrap(), &f);
        assert_eq!(SqliteRepository::open(path.to_str().unwrap()).unwrap().get_flag("f").unwrap().description, "kept");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn database_paths_with_special_characters_work() {
        let dir = std::env::temp_dir().join(format!(
            "ffservice-rs-paths-{}-{}",
            std::process::id(),
            crate::timefmt::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a b#c.db", "50%.db", "q?x.db", "caf\u{e9}.db", "a&b=c;d.db"] {
            let path = dir.join(name);
            put(&SqliteRepository::open(path.to_str().unwrap()).unwrap(), &make("f"));
            assert!(path.exists(), "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wal_mode_is_on_for_a_file_database() {
        let dir =
            std::env::temp_dir().join(format!("ffservice-rs-wal-{}-{}", std::process::id(), crate::timefmt::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wal.db");
        drop(SqliteRepository::open(path.to_str().unwrap()).unwrap());
        let mode: String = Connection::open(&path).unwrap().query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_writers_do_not_corrupt_state() {
        let r = std::sync::Arc::new(repo());
        let workers: Vec<_> = (0..8)
            .map(|t| {
                let r = r.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        let key = format!("t{t}-{i}");
                        r.transaction(|tx| {
                            tx.insert_flag(&make(&key))?;
                            tx.append_audit(&audit(&key, "create", None, Some("{}")))
                        })
                        .unwrap();
                        r.list_flags(5, 0).unwrap();
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        assert_eq!(r.list_flags(1, 0).unwrap().1, 200);
        assert_eq!(r.list_audit(None, 1, 0).unwrap().1, 200);
    }
}
