package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver, no cgo needed

	"ffservice/internal/model"
)

const schema = `
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
);
`

// SQLite implements Repository on top of database/sql.
type SQLite struct {
	db *sql.DB
}

var _ Repository = (*SQLite)(nil)

// uriPathEscaper protects the three characters that would otherwise end or
// corrupt the path part of a "file:" URI: '?' starts the query, '#' starts the
// fragment and '%' starts an escape.
var uriPathEscaper = strings.NewReplacer("%", "%25", "?", "%3f", "#", "%23")

// Open opens (and creates, if needed) the database at path. Use ":memory:"
// for a private in-memory database.
//
// The pool is limited to one connection. That serialises all access, which is
// what SQLite does anyway, and it is required for ":memory:" because every
// connection would otherwise get its own empty database. The consequence: do
// not use the *SQLite while a Tx callback is running, it would wait forever.
func Open(path string) (*SQLite, error) {
	dsn := "file:" + uriPathEscaper.Replace(path) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	if path == ":memory:" {
		dsn = "file::memory:?_pragma=busy_timeout(5000)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &SQLite{db: db}, nil
}

// Close closes the database.
func (s *SQLite) Close() error { return s.db.Close() }

// ---------------------------------------------------------------- helpers

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func parseTime(s string) (time.Time, error) { return time.Parse(time.RFC3339Nano, s) }

// querier is the part of *sql.DB and *sql.Tx used for reads.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

type scanner interface{ Scan(dest ...any) error }

const flagColumns = "key, description, enabled, rules, rollout_percent, variants, created_at, updated_at"

func scanFlag(row scanner) (*model.Flag, error) {
	var (
		f                    model.Flag
		enabled              int
		rules, variants      string
		createdAt, updatedAt string
	)
	if err := row.Scan(&f.Key, &f.Description, &enabled, &rules, &f.RolloutPercent, &variants, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	f.Enabled = enabled != 0
	if err := json.Unmarshal([]byte(rules), &f.Rules); err != nil {
		return nil, fmt.Errorf("decode rules of %q: %w", f.Key, err)
	}
	if err := json.Unmarshal([]byte(variants), &f.Variants); err != nil {
		return nil, fmt.Errorf("decode variants of %q: %w", f.Key, err)
	}
	// Keep [] (not null) in JSON output.
	if f.Rules == nil {
		f.Rules = []model.Rule{}
	}
	if f.Variants == nil {
		f.Variants = []model.Variant{}
	}
	var err error
	if f.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, err
	}
	if f.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return nil, err
	}
	return &f, nil
}

func getFlag(ctx context.Context, q querier, key string) (*model.Flag, error) {
	f, err := scanFlag(q.QueryRowContext(ctx, "SELECT "+flagColumns+" FROM flags WHERE key = ?", key))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return f, err
}

func encodeFlag(f *model.Flag) (enabled int, rules, variants []byte, err error) {
	if f.Enabled {
		enabled = 1
	}
	r, v := f.Rules, f.Variants
	if r == nil {
		r = []model.Rule{}
	}
	if v == nil {
		v = []model.Variant{}
	}
	if rules, err = json.Marshal(r); err != nil {
		return
	}
	variants, err = json.Marshal(v)
	return
}

// ------------------------------------------------------------ transactions

type sqlTx struct {
	ctx context.Context
	tx  *sql.Tx
}

// Tx implements Repository.
func (s *SQLite) Tx(ctx context.Context, fn func(Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	// A panic in fn must still end the transaction. With a one-connection pool a
	// leaked transaction would block every later call forever.
	defer func() {
		if p := recover(); p != nil {
			tx.Rollback()
			panic(p)
		}
	}()
	if err := fn(&sqlTx{ctx: ctx, tx: tx}); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (t *sqlTx) GetFlag(key string) (*model.Flag, error) { return getFlag(t.ctx, t.tx, key) }

func (t *sqlTx) InsertFlag(f *model.Flag) error {
	// A check inside the transaction is enough: with one connection nothing
	// can insert between this read and the write below.
	var one int
	err := t.tx.QueryRowContext(t.ctx, "SELECT 1 FROM flags WHERE key = ?", f.Key).Scan(&one)
	if err == nil {
		return ErrExists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	enabled, rules, variants, err := encodeFlag(f)
	if err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx,
		"INSERT INTO flags ("+flagColumns+") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		f.Key, f.Description, enabled, string(rules), f.RolloutPercent, string(variants),
		formatTime(f.CreatedAt), formatTime(f.UpdatedAt))
	return err
}

func (t *sqlTx) UpdateFlag(f *model.Flag) error {
	enabled, rules, variants, err := encodeFlag(f)
	if err != nil {
		return err
	}
	res, err := t.tx.ExecContext(t.ctx,
		"UPDATE flags SET description = ?, enabled = ?, rules = ?, rollout_percent = ?, variants = ?, updated_at = ? WHERE key = ?",
		f.Description, enabled, string(rules), f.RolloutPercent, string(variants), formatTime(f.UpdatedAt), f.Key)
	if err != nil {
		return err
	}
	return requireOneRow(res)
}

func (t *sqlTx) DeleteFlag(key string) error {
	res, err := t.tx.ExecContext(t.ctx, "DELETE FROM flags WHERE key = ?", key)
	if err != nil {
		return err
	}
	return requireOneRow(res)
}

func requireOneRow(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (t *sqlTx) AppendAudit(a model.AuditLog) error {
	_, err := t.tx.ExecContext(t.ctx,
		"INSERT INTO audit_logs (flag_key, action, before, after, created_at) VALUES (?, ?, ?, ?, ?)",
		a.FlagKey, a.Action, nullableJSON(a.Before), nullableJSON(a.After), formatTime(a.CreatedAt))
	return err
}

func nullableJSON(b json.RawMessage) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}

// ------------------------------------------------------------------ reads

// GetFlag implements Repository.
func (s *SQLite) GetFlag(ctx context.Context, key string) (*model.Flag, error) {
	return getFlag(ctx, s.db, key)
}

// ListFlags implements Repository.
func (s *SQLite) ListFlags(ctx context.Context, limit, offset int) ([]model.Flag, int, error) {
	var (
		flags []model.Flag
		total int
	)
	// One transaction so that total and the page describe the same state.
	err := s.read(ctx, func(q querier) error {
		if err := q.QueryRowContext(ctx, "SELECT COUNT(*) FROM flags").Scan(&total); err != nil {
			return err
		}
		rows, err := q.QueryContext(ctx,
			"SELECT "+flagColumns+" FROM flags ORDER BY key ASC LIMIT ? OFFSET ?", limit, offset)
		if err != nil {
			return err
		}
		flags, err = collectFlags(rows)
		return err
	})
	return flags, total, err
}

// read runs fn against a consistent snapshot.
func (s *SQLite) read(ctx context.Context, fn func(q querier) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback() // read-only: there is nothing to commit, this just ends the transaction
	return fn(tx)
}

// ListAllFlags implements Repository.
func (s *SQLite) ListAllFlags(ctx context.Context) ([]model.Flag, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+flagColumns+" FROM flags ORDER BY key ASC")
	if err != nil {
		return nil, err
	}
	return collectFlags(rows)
}

func collectFlags(rows *sql.Rows) ([]model.Flag, error) {
	defer rows.Close()
	flags := []model.Flag{}
	for rows.Next() {
		f, err := scanFlag(rows)
		if err != nil {
			return nil, err
		}
		flags = append(flags, *f)
	}
	return flags, rows.Err()
}

// ListAudit implements Repository.
func (s *SQLite) ListAudit(ctx context.Context, flagKey *string, limit, offset int) ([]model.AuditLog, int, error) {
	where, args := "", []any{}
	if flagKey != nil {
		where, args = " WHERE flag_key = ?", append(args, *flagKey)
	}
	var (
		logs  []model.AuditLog
		total int
	)
	err := s.read(ctx, func(q querier) error {
		if err := q.QueryRowContext(ctx, "SELECT COUNT(*) FROM audit_logs"+where, args...).Scan(&total); err != nil {
			return err
		}
		rows, err := q.QueryContext(ctx,
			"SELECT id, flag_key, action, before, after, created_at FROM audit_logs"+where+" ORDER BY id DESC LIMIT ? OFFSET ?",
			append(args, limit, offset)...)
		if err != nil {
			return err
		}
		defer rows.Close()

		logs = []model.AuditLog{}
		for rows.Next() {
			var (
				a             model.AuditLog
				before, after sql.NullString
				createdAt     string
			)
			if err := rows.Scan(&a.ID, &a.FlagKey, &a.Action, &before, &after, &createdAt); err != nil {
				return err
			}
			if before.Valid {
				a.Before = json.RawMessage(before.String)
			}
			if after.Valid {
				a.After = json.RawMessage(after.String)
			}
			if a.CreatedAt, err = parseTime(createdAt); err != nil {
				return err
			}
			logs = append(logs, a)
		}
		return rows.Err()
	})
	return logs, total, err
}

// ----------------------------------------------------------------- events

// RecordEvents implements Repository.
func (s *SQLite) RecordEvents(ctx context.Context, events []model.Event) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	for _, e := range events {
		switch e.Type {
		case model.EventExposure:
			_, err = tx.ExecContext(ctx,
				"INSERT OR IGNORE INTO exposures (flag_key, user_id, variant) VALUES (?, ?, ?)",
				e.FlagKey, e.UserID, e.Variant)
		case model.EventConversion:
			_, err = tx.ExecContext(ctx,
				"INSERT OR IGNORE INTO conversions (goal, user_id) VALUES (?, ?)", e.Goal, e.UserID)
		default:
			err = fmt.Errorf("unknown event type %q", e.Type)
		}
		if err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// VariantCounts implements Repository.
func (s *SQLite) VariantCounts(ctx context.Context, flagKey, goal string) (map[string]int, map[string]int, error) {
	var exposures, conversions map[string]int
	err := s.read(ctx, func(q querier) error {
		var err error
		exposures, err = counts(ctx, q,
			"SELECT variant, COUNT(*) FROM exposures WHERE flag_key = ? GROUP BY variant", flagKey)
		if err != nil {
			return err
		}
		// A conversion counts only for users exposed to this flag (BR-41), however
		// the two events were ordered.
		conversions, err = counts(ctx, q,
			`SELECT e.variant, COUNT(*) FROM exposures e
			 JOIN conversions c ON c.user_id = e.user_id AND c.goal = ?
			 WHERE e.flag_key = ? GROUP BY e.variant`, goal, flagKey)
		return err
	})
	return exposures, conversions, err
}

func counts(ctx context.Context, q querier, query string, args ...any) (map[string]int, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var key string
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			return nil, err
		}
		out[key] = n
	}
	return out, rows.Err()
}
