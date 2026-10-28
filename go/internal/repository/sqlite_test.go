package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"ffservice/internal/model"
)

var ctx = context.Background()

func open(t *testing.T) *SQLite {
	t.Helper()
	r, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

func flag(key string) model.Flag {
	now := time.Date(2026, 1, 31, 8, 0, 0, 123_000_000, time.UTC)
	return model.Flag{
		Key: key, Description: "d", Enabled: true, RolloutPercent: 100,
		Rules:     []model.Rule{},
		Variants:  []model.Variant{},
		CreatedAt: now, UpdatedAt: now,
	}
}

func insert(t *testing.T, r *SQLite, f model.Flag) {
	t.Helper()
	if err := r.Tx(ctx, func(tx Tx) error { return tx.InsertFlag(&f) }); err != nil {
		t.Fatalf("insert %s: %v", f.Key, err)
	}
}

func TestInsertThenGetRoundTripsEveryField(t *testing.T) {
	r := open(t)
	f := flag("checkout")
	f.Description = "ธง 🚩 café"
	f.Enabled = false
	f.RolloutPercent = 25
	f.Rules = []model.Rule{
		{Attribute: "country", Operator: "in", Value: []any{"TH", "SG"}},
		{Attribute: "age", Operator: "eq", Value: float64(18)},
		{Attribute: "beta", Operator: "eq", Value: true},
	}
	f.Variants = []model.Variant{{Key: "z", Weight: 10}, {Key: "a", Weight: 90}} // not alphabetical on purpose
	insert(t, r, f)

	got, err := r.GetFlag(ctx, "checkout")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*got, f) {
		t.Fatalf("round trip changed the flag:\n got  %+v\n want %+v", *got, f)
	}
}

func TestEmptyRulesAndVariantsComeBackAsEmptySlicesNotNull(t *testing.T) {
	r := open(t)
	f := flag("plain")
	f.Rules, f.Variants = nil, nil // a caller that forgot to initialise them
	insert(t, r, f)
	got, _ := r.GetFlag(ctx, "plain")
	out, _ := json.Marshal(got)
	var m map[string]any
	json.Unmarshal(out, &m)
	if !reflect.DeepEqual(m["rules"], []any{}) || !reflect.DeepEqual(m["variants"], []any{}) {
		t.Fatalf("want [] for rules and variants, got %v and %v", m["rules"], m["variants"])
	}
}

func TestGetUnknownFlagIsErrNotFound(t *testing.T) {
	if _, err := open(t).GetFlag(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestInsertDuplicateKeyIsErrExistsAndKeepsTheOriginal(t *testing.T) {
	r := open(t)
	insert(t, r, flag("dup"))
	other := flag("dup")
	other.Description = "second"
	err := r.Tx(ctx, func(tx Tx) error { return tx.InsertFlag(&other) })
	if !errors.Is(err, ErrExists) {
		t.Fatalf("got %v", err)
	}
	got, _ := r.GetFlag(ctx, "dup")
	if got.Description != "d" {
		t.Fatalf("original was overwritten: %q", got.Description)
	}
}

func TestUpdateReplacesFieldsButKeepsCreatedAt(t *testing.T) {
	r := open(t)
	insert(t, r, flag("u"))
	upd := flag("u")
	upd.Description = "changed"
	upd.Enabled = false
	upd.CreatedAt = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC) // must be ignored
	upd.UpdatedAt = time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	if err := r.Tx(ctx, func(tx Tx) error { return tx.UpdateFlag(&upd) }); err != nil {
		t.Fatal(err)
	}
	got, _ := r.GetFlag(ctx, "u")
	if got.Description != "changed" || got.Enabled || !got.UpdatedAt.Equal(upd.UpdatedAt) {
		t.Fatalf("update not applied: %+v", got)
	}
	if !got.CreatedAt.Equal(flag("u").CreatedAt) {
		t.Fatalf("createdAt changed to %v", got.CreatedAt)
	}
}

func TestUpdateAndDeleteOfUnknownFlagAreErrNotFound(t *testing.T) {
	r := open(t)
	f := flag("ghost")
	if err := r.Tx(ctx, func(tx Tx) error { return tx.UpdateFlag(&f) }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update: %v", err)
	}
	if err := r.Tx(ctx, func(tx Tx) error { return tx.DeleteFlag("ghost") }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete: %v", err)
	}
}

func TestDeleteRemovesTheFlag(t *testing.T) {
	r := open(t)
	insert(t, r, flag("gone"))
	if err := r.Tx(ctx, func(tx Tx) error { return tx.DeleteFlag("gone") }); err != nil {
		t.Fatal(err)
	}
	if _, err := r.GetFlag(ctx, "gone"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("still there: %v", err)
	}
}

func TestListFlagsIsSortedByKeyAndPagedWithTotal(t *testing.T) {
	r := open(t)
	for _, k := range []string{"m", "b", "z", "a", "k"} {
		insert(t, r, flag(k))
	}
	keys := func(fs []model.Flag) []string {
		out := []string{}
		for _, f := range fs {
			out = append(out, f.Key)
		}
		return out
	}
	page, total, err := r.ListFlags(ctx, 2, 0)
	if err != nil || total != 5 || !reflect.DeepEqual(keys(page), []string{"a", "b"}) {
		t.Fatalf("page 1: %v total=%d err=%v", keys(page), total, err)
	}
	page, total, _ = r.ListFlags(ctx, 2, 2)
	if total != 5 || !reflect.DeepEqual(keys(page), []string{"k", "m"}) {
		t.Fatalf("page 2: %v total=%d", keys(page), total)
	}
	page, total, _ = r.ListFlags(ctx, 2, 100)
	if total != 5 || page == nil || len(page) != 0 {
		t.Fatalf("past the end: %v (nil=%v) total=%d", keys(page), page == nil, total)
	}
	all, _ := r.ListAllFlags(ctx)
	if !reflect.DeepEqual(keys(all), []string{"a", "b", "k", "m", "z"}) {
		t.Fatalf("all: %v", keys(all))
	}
}

func TestFailedTxRollsBackFlagAndAuditTogether(t *testing.T) {
	r := open(t)
	boom := errors.New("boom")
	err := r.Tx(ctx, func(tx Tx) error {
		f := flag("rolled-back")
		if err := tx.InsertFlag(&f); err != nil {
			return err
		}
		if err := tx.AppendAudit(model.AuditLog{FlagKey: "rolled-back", Action: "create", CreatedAt: time.Now()}); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	if _, err := r.GetFlag(ctx, "rolled-back"); !errors.Is(err, ErrNotFound) {
		t.Fatal("flag survived the rollback")
	}
	if _, total, _ := r.ListAudit(ctx, nil, 10, 0); total != 0 {
		t.Fatalf("audit entry survived the rollback (%d)", total)
	}
}

func TestAuditIsNewestFirstFilteredAndKeepsNullBeforeAfter(t *testing.T) {
	r := open(t)
	add := func(key, action string, before, after string) {
		a := model.AuditLog{FlagKey: key, Action: action, CreatedAt: time.Now().UTC()}
		if before != "" {
			a.Before = json.RawMessage(before)
		}
		if after != "" {
			a.After = json.RawMessage(after)
		}
		if err := r.Tx(ctx, func(tx Tx) error { return tx.AppendAudit(a) }); err != nil {
			t.Fatal(err)
		}
	}
	add("x", "create", "", `{"v":1}`)
	add("y", "create", "", `{"v":1}`)
	add("x", "delete", `{"v":1}`, "")

	all, total, err := r.ListAudit(ctx, nil, 10, 0)
	if err != nil || total != 3 || len(all) != 3 {
		t.Fatalf("all: %v total=%d err=%v", all, total, err)
	}
	if !(all[0].ID > all[1].ID && all[1].ID > all[2].ID) {
		t.Fatalf("not newest first: %d %d %d", all[0].ID, all[1].ID, all[2].ID)
	}

	key := "x"
	xs, total, _ := r.ListAudit(ctx, &key, 10, 0)
	if total != 2 || len(xs) != 2 || xs[0].Action != "delete" || xs[1].Action != "create" {
		t.Fatalf("filtered: %+v total=%d", xs, total)
	}
	if xs[0].After != nil || string(xs[0].Before) != `{"v":1}` || xs[1].Before != nil {
		t.Fatalf("before/after not preserved: %+v", xs)
	}
	out, _ := json.Marshal(xs[0])
	if !reflect.DeepEqual(mustMap(t, out)["after"], nil) {
		t.Fatalf("a missing 'after' must serialise as null: %s", out)
	}
	empty, total, _ := r.ListAudit(ctx, &[]string{"nobody"}[0], 10, 0)
	if total != 0 || empty == nil || len(empty) != 0 {
		t.Fatalf("unknown key: %v total=%d", empty, total)
	}
	page, total, _ := r.ListAudit(ctx, nil, 1, 2)
	if total != 3 || len(page) != 1 || page[0].Action != "create" || page[0].FlagKey != "x" {
		t.Fatalf("paging: %+v", page)
	}
}

func mustMap(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func exposure(flagKey, user, variant string) model.Event {
	return model.Event{Type: model.EventExposure, UserID: user, FlagKey: flagKey, Variant: variant}
}

func conversion(goal, user string) model.Event {
	return model.Event{Type: model.EventConversion, UserID: user, Goal: goal}
}

func TestFirstExposureWinsAndDuplicatesCountOnce(t *testing.T) {
	r := open(t)
	err := r.RecordEvents(ctx, []model.Event{
		exposure("f", "u1", "control"), exposure("f", "u1", "control"),
		exposure("f", "u2", "control"), exposure("f", "u2", "treatment"), // second variant ignored
		exposure("f", "u3", "treatment"),
		exposure("other", "u1", "treatment"), // different flag, independent
	})
	if err != nil {
		t.Fatal(err)
	}
	exp, _, err := r.VariantCounts(ctx, "f", "g")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(exp, map[string]int{"control": 2, "treatment": 1}) {
		t.Fatalf("exposures: %v", exp)
	}
}

func TestConversionsCountOncePerUserAndOnlyForExposedUsers(t *testing.T) {
	r := open(t)
	// the conversion for u1 arrives before the exposure, and u9 never sees the flag
	if err := r.RecordEvents(ctx, []model.Event{
		conversion("buy", "u1"), conversion("buy", "u1"), conversion("buy", "u9"), conversion("signup", "u2"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := r.RecordEvents(ctx, []model.Event{
		exposure("f", "u1", "control"), exposure("f", "u2", "treatment"),
	}); err != nil {
		t.Fatal(err)
	}
	_, conv, _ := r.VariantCounts(ctx, "f", "buy")
	if !reflect.DeepEqual(conv, map[string]int{"control": 1}) {
		t.Fatalf("buy: %v", conv)
	}
	_, conv, _ = r.VariantCounts(ctx, "f", "signup")
	if !reflect.DeepEqual(conv, map[string]int{"treatment": 1}) {
		t.Fatalf("signup: %v", conv)
	}
	_, conv, _ = r.VariantCounts(ctx, "f", "never")
	if len(conv) != 0 {
		t.Fatalf("never: %v", conv)
	}
}

func TestRecordEventsIsAllOrNothing(t *testing.T) {
	r := open(t)
	err := r.RecordEvents(ctx, []model.Event{
		exposure("f", "u1", "control"),
		{Type: "bogus", UserID: "u2"},
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	exp, _, _ := r.VariantCounts(ctx, "f", "g")
	if len(exp) != 0 {
		t.Fatalf("the first event was kept: %v", exp)
	}
}

func TestDataSurvivesReopeningAFileDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flags.db")
	r1, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insert(t, r1, flag("persisted"))
	r1.Close()

	r2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Close()
	if _, err := r2.GetFlag(ctx, "persisted"); err != nil {
		t.Fatalf("flag lost after reopen: %v", err)
	}
}

func TestConcurrentWritersDoNotCorruptState(t *testing.T) {
	r := open(t)
	const n = 40
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			f := flag(fmt.Sprintf("c-%02d", i))
			errs <- r.Tx(ctx, func(tx Tx) error {
				if err := tx.InsertFlag(&f); err != nil {
					return err
				}
				return tx.AppendAudit(model.AuditLog{FlagKey: f.Key, Action: "create", CreatedAt: time.Now()})
			})
		}(i)
	}
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if _, total, _ := r.ListFlags(ctx, 1, 0); total != n {
		t.Fatalf("flags: %d", total)
	}
	if _, total, _ := r.ListAudit(ctx, nil, 1, 0); total != n {
		t.Fatalf("audit entries: %d", total)
	}
}
