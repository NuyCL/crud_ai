package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"ffservice/internal/evaluation"
	"ffservice/internal/model"
	"ffservice/internal/repository"
)

// minSampleForSignificance is the smallest number of exposures per variant for
// which a p-value is reported (BR-42).
const minSampleForSignificance = 30

// Service is the application use cases.
type Service struct {
	repo repository.Repository
	now  func() time.Time
}

// New returns a Service backed by repo.
func New(repo repository.Repository) *Service {
	return &Service{repo: repo, now: func() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }}
}

// SetClock replaces the time source. It is meant for tests.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// ---------------------------------------------------------------- flags

// CreateFlag validates raw (a decoded JSON body) and stores a new flag together
// with its audit entry (BR-01, BR-02, BR-07, BR-08).
func (s *Service) CreateFlag(ctx context.Context, raw any) (*model.Flag, error) {
	flag, err := ParseFlagInput(raw)
	if err != nil {
		return nil, err
	}
	at := s.now()
	flag.CreatedAt, flag.UpdatedAt = at, at

	err = s.repo.Tx(ctx, func(tx repository.Tx) error {
		if err := tx.InsertFlag(&flag); err != nil {
			return err
		}
		return tx.AppendAudit(auditEntry(model.ActionCreate, flag.Key, nil, &flag, at))
	})
	if errors.Is(err, repository.ErrExists) {
		return nil, newError(CodeFlagExists, "flag %q already exists", flag.Key)
	}
	if err != nil {
		return nil, err
	}
	return &flag, nil
}

// GetFlag returns one flag (BR-05).
func (s *Service) GetFlag(ctx context.Context, key string) (*model.Flag, error) {
	flag, err := s.repo.GetFlag(ctx, key)
	if errors.Is(err, repository.ErrNotFound) {
		return nil, notFound(key)
	}
	return flag, err
}

// ListFlags returns one page of flags ordered by key, and the total.
func (s *Service) ListFlags(ctx context.Context, limit, offset int) ([]model.Flag, int, error) {
	return s.repo.ListFlags(ctx, limit, offset)
}

// UpdateFlag replaces the flag at key with raw (BR-03, BR-05, BR-09). Fields
// the body leaves out go back to their defaults.
func (s *Service) UpdateFlag(ctx context.Context, key string, raw any) (*model.Flag, error) {
	flag, err := ParseFlagInput(raw)
	if err != nil {
		return nil, err
	}
	if flag.Key != key {
		return nil, newError(CodeKeyImmutable, "key cannot be changed from %q to %q", key, flag.Key)
	}
	at := s.now()

	err = s.repo.Tx(ctx, func(tx repository.Tx) error {
		old, err := tx.GetFlag(key)
		if err != nil {
			return err
		}
		flag.CreatedAt = old.CreatedAt
		flag.UpdatedAt = at
		if flag.UpdatedAt.Before(old.UpdatedAt) { // never let updatedAt go backwards
			flag.UpdatedAt = old.UpdatedAt
		}
		if err := tx.UpdateFlag(&flag); err != nil {
			return err
		}
		return tx.AppendAudit(auditEntry(model.ActionUpdate, key, old, &flag, at))
	})
	if errors.Is(err, repository.ErrNotFound) {
		return nil, notFound(key)
	}
	if err != nil {
		return nil, err
	}
	return &flag, nil
}

// DeleteFlag removes a flag and records it in the audit log (BR-06).
func (s *Service) DeleteFlag(ctx context.Context, key string) error {
	at := s.now()
	err := s.repo.Tx(ctx, func(tx repository.Tx) error {
		old, err := tx.GetFlag(key)
		if err != nil {
			return err
		}
		if err := tx.DeleteFlag(key); err != nil {
			return err
		}
		return tx.AppendAudit(auditEntry(model.ActionDelete, key, old, nil, at))
	})
	if errors.Is(err, repository.ErrNotFound) {
		return notFound(key)
	}
	return err
}

// ListAudit returns audit entries, newest first.
func (s *Service) ListAudit(ctx context.Context, flagKey *string, limit, offset int) ([]model.AuditLog, int, error) {
	return s.repo.ListAudit(ctx, flagKey, limit, offset)
}

func notFound(key string) error {
	return newError(CodeFlagNotFound, "flag %q not found", key)
}

// auditEntry snapshots before and after as JSON, in the same shape the API
// returns for a flag.
func auditEntry(action, key string, before, after *model.Flag, at time.Time) model.AuditLog {
	entry := model.AuditLog{FlagKey: key, Action: action, CreatedAt: at}
	if before != nil {
		entry.Before, _ = json.Marshal(before)
	}
	if after != nil {
		entry.After, _ = json.Marshal(after)
	}
	return entry
}

// ------------------------------------------------------------- evaluate

// Evaluate evaluates flags for the context in raw. It writes nothing (BR-22).
func (s *Service) Evaluate(ctx context.Context, raw any) (map[string]model.EvaluationResult, error) {
	req, err := ParseEvaluateRequest(raw)
	if err != nil {
		return nil, err
	}
	results := map[string]model.EvaluationResult{}

	if !req.HasFlags {
		flags, err := s.repo.ListAllFlags(ctx)
		if err != nil {
			return nil, err
		}
		for i := range flags {
			results[flags[i].Key] = evaluation.Evaluate(&flags[i], req.Context)
		}
		return results, nil
	}
	for _, key := range req.Flags {
		flag, err := s.repo.GetFlag(ctx, key)
		if errors.Is(err, repository.ErrNotFound) {
			flag, err = nil, nil // an unknown flag is a normal answer, not a failure (BR-21)
		}
		if err != nil {
			return nil, err
		}
		results[key] = evaluation.Evaluate(flag, req.Context)
	}
	return results, nil
}

// --------------------------------------------------------------- events

// RecordEvents validates and stores a batch of events; it returns how many
// events the batch contained (BR-43, BR-44).
func (s *Service) RecordEvents(ctx context.Context, raw any) (int, error) {
	events, err := ParseEvents(raw)
	if err != nil {
		return 0, err
	}
	if err := s.repo.RecordEvents(ctx, events); err != nil {
		return 0, err
	}
	return len(events), nil
}

// Results builds the experiment report of a flag for a goal (BR-42, BR-46).
func (s *Service) Results(ctx context.Context, flagKey, goal string) (*model.Results, error) {
	if goal == "" {
		return nil, validationError("goal is required")
	}
	flag, err := s.GetFlag(ctx, flagKey)
	if err != nil {
		return nil, err
	}
	exposures, conversions, err := s.repo.VariantCounts(ctx, flagKey, goal)
	if err != nil {
		return nil, err
	}

	rows := make([]model.VariantResult, 0, len(flag.Variants))
	for _, v := range flag.Variants {
		row := model.VariantResult{Variant: v.Key, Exposures: exposures[v.Key], Conversions: conversions[v.Key]}
		if row.Exposures > 0 {
			row.Rate = float64(row.Conversions) / float64(row.Exposures)
		}
		rows = append(rows, row)
	}
	// Every variant is compared with the first one, the control.
	for i := 1; i < len(rows); i++ {
		rows[i].PValue = twoProportionPValue(rows[0], rows[i])
		rows[i].Significant = rows[i].PValue != nil && *rows[i].PValue < 0.05
	}
	return &model.Results{FlagKey: flagKey, Goal: goal, Variants: rows}, nil
}

// twoProportionPValue is the pooled, two-sided two-proportion z-test of BR-42.
// It returns nil when either group is too small or the standard error is 0.
func twoProportionPValue(control, treatment model.VariantResult) *float64 {
	if control.Exposures < minSampleForSignificance || treatment.Exposures < minSampleForSignificance {
		return nil
	}
	n1, n2 := float64(control.Exposures), float64(treatment.Exposures)
	pooled := float64(control.Conversions+treatment.Conversions) / (n1 + n2)
	se := math.Sqrt(pooled * (1 - pooled) * (1/n1 + 1/n2))
	if se == 0 {
		return nil
	}
	z := (treatment.Rate - control.Rate) / se
	p := math.Erfc(math.Abs(z) / math.Sqrt2)
	return &p
}
