// Package repository stores flags, the audit log and experiment events in
// SQLite. The service depends on the interfaces here, not on SQLite.
package repository

import (
	"context"
	"errors"

	"ffservice/internal/model"
)

var (
	// ErrNotFound is returned when a flag does not exist.
	ErrNotFound = errors.New("not found")
	// ErrExists is returned when inserting a flag whose key is taken.
	ErrExists = errors.New("already exists")
)

// Tx is the set of operations that must commit or roll back together: a flag
// change and its audit entry.
type Tx interface {
	GetFlag(key string) (*model.Flag, error)
	InsertFlag(f *model.Flag) error
	UpdateFlag(f *model.Flag) error
	DeleteFlag(key string) error
	AppendAudit(a model.AuditLog) error
}

// Repository is everything the service needs from storage.
type Repository interface {
	// Tx runs fn in a transaction. fn returning an error rolls it back.
	Tx(ctx context.Context, fn func(Tx) error) error

	GetFlag(ctx context.Context, key string) (*model.Flag, error)
	// ListFlags returns one page ordered by key ascending, and the total count.
	ListFlags(ctx context.Context, limit, offset int) ([]model.Flag, int, error)
	ListAllFlags(ctx context.Context) ([]model.Flag, error)
	// ListAudit returns one page, newest first. A nil flagKey means every flag.
	ListAudit(ctx context.Context, flagKey *string, limit, offset int) ([]model.AuditLog, int, error)

	// RecordEvents stores all events or none. The first exposure of a
	// (flag, user) wins and repeated conversions of a (goal, user) count once.
	RecordEvents(ctx context.Context, events []model.Event) error
	// VariantCounts returns, per variant key, the number of exposed users and
	// how many of them converted on goal.
	VariantCounts(ctx context.Context, flagKey, goal string) (exposures, conversions map[string]int, err error)

	Close() error
}
