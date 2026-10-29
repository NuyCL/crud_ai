package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"ffservice/internal/model"
	"ffservice/internal/repository"
)

var ctx = context.Background()

// decode turns JSON text into what the handler passes to the service.
func decode(t *testing.T, text string) any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("bad test JSON %q: %v", text, err)
	}
	return v
}

func newService(t *testing.T) (*Service, *clock) {
	t.Helper()
	repo, err := repository.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { repo.Close() })
	c := &clock{t: time.Date(2026, 1, 31, 8, 0, 0, 0, time.UTC)}
	svc := New(repo)
	svc.SetClock(c.now)
	return svc, c
}

// clock hands out a later time on every call.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { c.t = c.t.Add(time.Second); return c.t }

func code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	if err == nil {
		return ""
	}
	return "NOT_A_SERVICE_ERROR: " + err.Error()
}

func create(t *testing.T, s *Service, body string) *model.Flag {
	t.Helper()
	f, err := s.CreateFlag(ctx, decode(t, body))
	if err != nil {
		t.Fatalf("create %s: %v", body, err)
	}
	return f
}

// ------------------------------------------------------------ BR-01, BR-08

func TestBR01_KeyFormat(t *testing.T) {
	s, _ := newService(t)
	valid := []string{"a", "0", "a-b_c", "9lives", strings.Repeat("x", 64)}
	for _, k := range valid {
		if _, err := s.CreateFlag(ctx, decode(t, fmt.Sprintf(`{"key":%q}`, k))); err != nil {
			t.Errorf("key %q rejected: %v", k, err)
		}
	}
	invalid := map[string]string{
		"empty": "", "upper": "Upper", "leading hyphen": "-abc", "leading underscore": "_abc",
		"space": "a b", "slash": "a/b", "dot": "a.b", "thai": "ไทย", "65 chars": strings.Repeat("x", 65),
		"trailing newline": "abc\n",
	}
	for name, k := range invalid {
		_, err := s.CreateFlag(ctx, decode(t, fmt.Sprintf(`{"key":%q}`, k)))
		if code(err) != CodeInvalidKey {
			t.Errorf("%s (%q): got %q, want INVALID_KEY", name, k, code(err))
		}
	}
	for name, body := range map[string]string{
		"missing": `{}`, "number": `{"key":1}`, "null": `{"key":null}`, "object": `{"key":{}}`,
	} {
		if _, err := s.CreateFlag(ctx, decode(t, body)); code(err) != CodeValidation {
			t.Errorf("key %s: got %q, want VALIDATION_ERROR", name, code(err))
		}
	}
}

func TestBR08_DefaultsApplyWhenFieldsAreOmitted(t *testing.T) {
	s, _ := newService(t)
	f := create(t, s, `{"key":"plain"}`)
	if f.Description != "" || f.Enabled || f.RolloutPercent != 100 || f.Rules == nil || len(f.Rules) != 0 || f.Variants == nil || len(f.Variants) != 0 {
		t.Fatalf("defaults wrong: %+v", f)
	}
	if f.CreatedAt.IsZero() || !f.CreatedAt.Equal(f.UpdatedAt) {
		t.Fatalf("timestamps: %v %v", f.CreatedAt, f.UpdatedAt)
	}
}

// -------------------------------------------------------------------- BR-02

func TestBR02_DuplicateKeyIsRejectedAndNothingIsAudited(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"dup","description":"first"}`)
	_, err := s.CreateFlag(ctx, decode(t, `{"key":"dup","description":"second"}`))
	if code(err) != CodeFlagExists {
		t.Fatalf("got %q", code(err))
	}
	if got, _ := s.GetFlag(ctx, "dup"); got.Description != "first" {
		t.Fatalf("original changed: %q", got.Description)
	}
	if _, total, _ := s.ListAudit(ctx, nil, 10, 0); total != 1 {
		t.Fatalf("audit entries = %d, want 1", total)
	}
}

// -------------------------------------------------------------------- BR-04

func TestBR04_DescriptionIsCountedInCodePoints(t *testing.T) {
	s, _ := newService(t)
	cases := []struct {
		name string
		text string
		ok   bool
	}{
		{"500 ASCII", strings.Repeat("a", 500), true},
		{"501 ASCII", strings.Repeat("a", 501), false},
		{"500 emoji (2000 bytes, 1000 UTF-16 units)", strings.Repeat("😀", 500), true},
		{"501 emoji", strings.Repeat("😀", 501), false},
		{"500 Thai (1500 bytes)", strings.Repeat("ก", 500), true},
	}
	for i, c := range cases {
		body, _ := json.Marshal(map[string]any{"key": fmt.Sprintf("d-%d", i), "description": c.text})
		_, err := s.CreateFlag(ctx, decode(t, string(body)))
		if c.ok && err != nil {
			t.Errorf("%s: rejected: %v", c.name, err)
		}
		if !c.ok && code(err) != CodeValidation {
			t.Errorf("%s: got %q, want VALIDATION_ERROR", c.name, code(err))
		}
	}
}

func TestBR04_WrongTypesAreRejected(t *testing.T) {
	s, _ := newService(t)
	for name, body := range map[string]string{
		"description number": `{"key":"k","description":5}`,
		"description null":   `{"key":"k","description":null}`,
		"enabled string":     `{"key":"k","enabled":"true"}`,
		"enabled number":     `{"key":"k","enabled":1}`,
		"enabled null":       `{"key":"k","enabled":null}`,
		"body array":         `[]`,
		"body null":          `null`,
		"body string":        `"x"`,
	} {
		if _, err := s.CreateFlag(ctx, decode(t, body)); code(err) != CodeValidation {
			t.Errorf("%s: got %q, want VALIDATION_ERROR", name, code(err))
		}
	}
}

func TestBR04_TextSurvivesAStoreAndLoadByteForByte(t *testing.T) {
	s, _ := newService(t)
	want := "ธงฟีเจอร์ 🚩 café 日本語"
	body, _ := json.Marshal(map[string]any{"key": "text", "description": want})
	create(t, s, string(body))
	got, _ := s.GetFlag(ctx, "text")
	if got.Description != want {
		t.Fatalf("got %q", got.Description)
	}
}

// -------------------------------------------------------------------- BR-05

func TestBR05_UnknownFlagIsNotFound(t *testing.T) {
	s, _ := newService(t)
	if _, err := s.GetFlag(ctx, "nope"); code(err) != CodeFlagNotFound {
		t.Errorf("get: %q", code(err))
	}
	if _, err := s.UpdateFlag(ctx, "nope", decode(t, `{"key":"nope"}`)); code(err) != CodeFlagNotFound {
		t.Errorf("update: %q", code(err))
	}
	if err := s.DeleteFlag(ctx, "nope"); code(err) != CodeFlagNotFound {
		t.Errorf("delete: %q", code(err))
	}
	if _, total, _ := s.ListAudit(ctx, nil, 10, 0); total != 0 {
		t.Errorf("rejected requests were audited (%d)", total)
	}
}

// --------------------------------------------------------- BR-03, BR-09

func TestBR09_UpdateIsAFullReplaceAndKeepsCreatedAt(t *testing.T) {
	s, _ := newService(t)
	old := create(t, s, `{"key":"u","description":"v1","enabled":true,"rolloutPercent":10,
		"rules":[{"attribute":"a","operator":"eq","value":1}],
		"variants":[{"key":"a","weight":50},{"key":"b","weight":50}]}`)
	got, err := s.UpdateFlag(ctx, "u", decode(t, `{"key":"u"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got.Description != "" || got.Enabled || got.RolloutPercent != 100 || len(got.Rules) != 0 || len(got.Variants) != 0 {
		t.Fatalf("omitted fields were not reset: %+v", got)
	}
	if !got.CreatedAt.Equal(old.CreatedAt) || !got.UpdatedAt.After(old.UpdatedAt) {
		t.Fatalf("timestamps: created %v (was %v) updated %v (was %v)", got.CreatedAt, old.CreatedAt, got.UpdatedAt, old.UpdatedAt)
	}
	stored, _ := s.GetFlag(ctx, "u")
	if !reflect.DeepEqual(stored, got) {
		t.Fatalf("stored flag differs from the one returned:\n%+v\n%+v", stored, got)
	}
}

func TestBR09_UpdatedAtNeverGoesBackwards(t *testing.T) {
	s, c := newService(t)
	old := create(t, s, `{"key":"u"}`)
	c.t = c.t.Add(-time.Hour) // clock jumps back
	got, _ := s.UpdateFlag(ctx, "u", decode(t, `{"key":"u"}`))
	if got.UpdatedAt.Before(old.UpdatedAt) {
		t.Fatalf("updatedAt went back: %v < %v", got.UpdatedAt, old.UpdatedAt)
	}
}

func TestBR03_KeyCannotChangeAndNothingIsWritten(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"stay","description":"x"}`)
	_, err := s.UpdateFlag(ctx, "stay", decode(t, `{"key":"moved","description":"y"}`))
	if code(err) != CodeKeyImmutable {
		t.Fatalf("got %q", code(err))
	}
	if got, _ := s.GetFlag(ctx, "stay"); got.Description != "x" {
		t.Fatalf("flag changed: %q", got.Description)
	}
	if _, err := s.GetFlag(ctx, "moved"); code(err) != CodeFlagNotFound {
		t.Fatal("a flag named 'moved' appeared")
	}
}

func TestBR51_ValidationComesBeforeExistenceChecks(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"v"}`)
	if _, err := s.CreateFlag(ctx, decode(t, `{"key":"v","enabled":"yes"}`)); code(err) != CodeValidation {
		t.Errorf("create: got %q, want VALIDATION_ERROR rather than FLAG_EXISTS", code(err))
	}
	if _, err := s.UpdateFlag(ctx, "missing", decode(t, `{"key":"missing","enabled":"yes"}`)); code(err) != CodeValidation {
		t.Errorf("update: got %q, want VALIDATION_ERROR rather than FLAG_NOT_FOUND", code(err))
	}
}

// -------------------------------------------------------------------- BR-06

func TestBR06_DeleteRemovesTheFlagAndAllowsReuseOfTheKey(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"gone","description":"first life"}`)
	if err := s.DeleteFlag(ctx, "gone"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetFlag(ctx, "gone"); code(err) != CodeFlagNotFound {
		t.Fatal("flag still there")
	}
	if f := create(t, s, `{"key":"gone","description":"second life"}`); f.Description != "second life" {
		t.Fatalf("got %+v", f)
	}
}

func TestBR21_EvaluatingADeletedFlagReportsFlagNotFound(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"gone","enabled":true}`)
	s.DeleteFlag(ctx, "gone")
	res, err := s.Evaluate(ctx, decode(t, `{"flags":["gone"],"context":{"userId":"u1"}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := model.EvaluationResult{Reason: model.ReasonFlagNotFound}
	if !reflect.DeepEqual(res["gone"], want) {
		t.Fatalf("got %+v", res["gone"])
	}
}

// -------------------------------------------------------------------- BR-07

func TestBR07_EachSuccessfulChangeWritesOneAuditEntryWithBeforeAndAfter(t *testing.T) {
	s, _ := newService(t)
	created := create(t, s, `{"key":"a","description":"1"}`)
	updated, _ := s.UpdateFlag(ctx, "a", decode(t, `{"key":"a","description":"2","enabled":true}`))
	s.DeleteFlag(ctx, "a")

	key := "a"
	logs, total, err := s.ListAudit(ctx, &key, 10, 0)
	if err != nil || total != 3 {
		t.Fatalf("total=%d err=%v", total, err)
	}
	del, upd, cre := logs[0], logs[1], logs[2]
	if del.Action != "delete" || upd.Action != "update" || cre.Action != "create" {
		t.Fatalf("order: %s %s %s", del.Action, upd.Action, cre.Action)
	}
	same := func(raw json.RawMessage, f *model.Flag) bool {
		want, _ := json.Marshal(f)
		var a, b any
		return json.Unmarshal(raw, &a) == nil && json.Unmarshal(want, &b) == nil && reflect.DeepEqual(a, b)
	}
	if cre.Before != nil || !same(cre.After, created) {
		t.Errorf("create entry: before=%s after=%s", cre.Before, cre.After)
	}
	if !same(upd.Before, created) || !same(upd.After, updated) {
		t.Errorf("update entry: before=%s after=%s", upd.Before, upd.After)
	}
	if !same(del.Before, updated) || del.After != nil {
		t.Errorf("delete entry: before=%s after=%s", del.Before, del.After)
	}
	out, _ := json.Marshal(del)
	if !bytes.Contains(out, []byte(`"after":null`)) {
		t.Errorf("a missing 'after' must serialise as null: %s", out)
	}
}

func TestBR07_RejectedChangesAreNotAudited(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"a"}`)
	s.CreateFlag(ctx, decode(t, `{"key":"a"}`))                      // FLAG_EXISTS
	s.UpdateFlag(ctx, "a", decode(t, `{"key":"a","enabled":"yes"}`)) // VALIDATION_ERROR
	s.UpdateFlag(ctx, "a", decode(t, `{"key":"b"}`))                 // KEY_IMMUTABLE
	s.UpdateFlag(ctx, "zzz", decode(t, `{"key":"zzz"}`))             // FLAG_NOT_FOUND
	s.DeleteFlag(ctx, "zzz")                                         // FLAG_NOT_FOUND
	if _, total, _ := s.ListAudit(ctx, nil, 10, 0); total != 1 {
		t.Fatalf("audit entries = %d, want only the create", total)
	}
}

// ----------------------------------------------------------- BR-30 .. BR-35

func TestBR30_RolloutPercent(t *testing.T) {
	s, _ := newService(t)
	for i, v := range []string{"0", "1", "50", "99", "100", "10.0"} {
		if _, err := s.CreateFlag(ctx, decode(t, fmt.Sprintf(`{"key":"r-%d","rolloutPercent":%s}`, i, v))); err != nil {
			t.Errorf("%s rejected: %v", v, err)
		}
	}
	for _, v := range []string{"-1", "101", "10.5", `"50"`, "null", "true", "1e10", "[]"} {
		if _, err := s.CreateFlag(ctx, decode(t, fmt.Sprintf(`{"key":"bad","rolloutPercent":%s}`, v))); code(err) != CodeValidation {
			t.Errorf("%s: got %q, want VALIDATION_ERROR", v, code(err))
		}
	}
}

func TestBR31_to_BR34_Variants(t *testing.T) {
	s, _ := newService(t)
	ten := make([]string, 10)
	eleven := make([]string, 11)
	for i := range ten {
		ten[i] = fmt.Sprintf(`{"key":"v%d","weight":10}`, i)
	}
	for i := range eleven {
		w := 9
		if i == 0 {
			w = 10
		}
		eleven[i] = fmt.Sprintf(`{"key":"v%d","weight":%d}`, i, w)
	}
	valid := map[string]string{
		"50/30/20":   `[{"key":"blue","weight":50},{"key":"green","weight":30},{"key":"red","weight":20}]`,
		"99/1":       `[{"key":"a","weight":99},{"key":"b","weight":1}]`,
		"ten":        "[" + strings.Join(ten, ",") + "]",
		"key of 32":  fmt.Sprintf(`[{"key":%q,"weight":50},{"key":"b","weight":50}]`, strings.Repeat("a", 32)),
		"empty list": `[]`,
	}
	n := 0
	for name, v := range valid {
		n++
		if _, err := s.CreateFlag(ctx, decode(t, fmt.Sprintf(`{"key":"ok-%d","variants":%s}`, n, v))); err != nil {
			t.Errorf("%s rejected: %v", name, err)
		}
	}
	invalid := map[string]string{
		"sum 99 (BR-31)":            `[{"key":"a","weight":50},{"key":"b","weight":49}]`,
		"sum 101 (BR-31)":           `[{"key":"a","weight":51},{"key":"b","weight":50}]`,
		"duplicate key (BR-32)":     `[{"key":"a","weight":50},{"key":"a","weight":50}]`,
		"upper-case key (BR-32)":    `[{"key":"Blue","weight":50},{"key":"b","weight":50}]`,
		"empty key (BR-32)":         `[{"key":"","weight":50},{"key":"b","weight":50}]`,
		"key with space (BR-32)":    `[{"key":"a b","weight":50},{"key":"b","weight":50}]`,
		"key of 33 (BR-32)":         fmt.Sprintf(`[{"key":%q,"weight":50},{"key":"b","weight":50}]`, strings.Repeat("a", 33)),
		"key is number (BR-32)":     `[{"key":1,"weight":50},{"key":"b","weight":50}]`,
		"missing key (BR-32)":       `[{"weight":50},{"key":"b","weight":50}]`,
		"one variant (BR-33)":       `[{"key":"a","weight":100}]`,
		"eleven variants (BR-33)":   "[" + strings.Join(eleven, ",") + "]",
		"zero weight (BR-34)":       `[{"key":"a","weight":100},{"key":"b","weight":0}]`,
		"negative weight (BR-34)":   `[{"key":"a","weight":150},{"key":"b","weight":-50}]`,
		"fractional weight (BR-34)": `[{"key":"a","weight":50.5},{"key":"b","weight":49.5}]`,
		"string weight (BR-34)":     `[{"key":"a","weight":"50"},{"key":"b","weight":50}]`,
		"missing weight (BR-34)":    `[{"key":"a"},{"key":"b","weight":100}]`,
		"entries not objects":       `["a","b"]`,
	}
	for name, v := range invalid {
		_, err := s.CreateFlag(ctx, decode(t, fmt.Sprintf(`{"key":"bad","variants":%s}`, v)))
		if code(err) != CodeInvalidVariants {
			t.Errorf("%s: got %q, want INVALID_VARIANTS", name, code(err))
		}
	}
	if _, err := s.CreateFlag(ctx, decode(t, `{"key":"bad","variants":"blue"}`)); code(err) != CodeValidation {
		t.Errorf("variants not an array: got %q", code(err))
	}
}

func TestBR33_VariantOrderIsKept(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"o","variants":[{"key":"z","weight":10},{"key":"a","weight":60},{"key":"m","weight":30}]}`)
	got, _ := s.GetFlag(ctx, "o")
	keys := []string{}
	for _, v := range got.Variants {
		keys = append(keys, v.Key)
	}
	if !reflect.DeepEqual(keys, []string{"z", "a", "m"}) {
		t.Fatalf("order: %v", keys)
	}
}

func TestBR35_Rules(t *testing.T) {
	s, _ := newService(t)
	f := create(t, s, `{"key":"r","rules":[
		{"attribute":"country","operator":"eq","value":"TH"},
		{"attribute":"plan","operator":"neq","value":"free"},
		{"attribute":"tier","operator":"in","value":[1,2,3]},
		{"attribute":"region","operator":"not_in","value":["eu","us"]},
		{"attribute":"beta","operator":"eq","value":true},
		{"attribute":"age","operator":"eq","value":0},
		{"attribute":"flag","operator":"eq","value":false},
		{"attribute":"name","operator":"eq","value":""}]}`)
	if len(f.Rules) != 8 {
		t.Fatalf("rules: %+v", f.Rules)
	}
	// numbers are float64 and survive a store/load cycle
	got, _ := s.GetFlag(ctx, "r")
	if !reflect.DeepEqual(got.Rules, f.Rules) || !reflect.DeepEqual(got.Rules[2].Value, []any{float64(1), float64(2), float64(3)}) {
		t.Fatalf("rules changed by storage: %+v", got.Rules)
	}

	invalid := map[string]string{
		"rules not an array":   `"x"`,
		"rule not an object":   `["x"]`,
		"missing attribute":    `[{"operator":"eq","value":1}]`,
		"empty attribute":      `[{"attribute":"","operator":"eq","value":1}]`,
		"attribute is number":  `[{"attribute":1,"operator":"eq","value":1}]`,
		"missing operator":     `[{"attribute":"a","value":1}]`,
		"unknown operator":     `[{"attribute":"a","operator":"gt","value":1}]`,
		"missing value":        `[{"attribute":"a","operator":"eq"}]`,
		"null value":           `[{"attribute":"a","operator":"eq","value":null}]`,
		"eq with array":        `[{"attribute":"a","operator":"eq","value":[1]}]`,
		"neq with object":      `[{"attribute":"a","operator":"neq","value":{}}]`,
		"in with scalar":       `[{"attribute":"a","operator":"in","value":"x"}]`,
		"in with empty array":  `[{"attribute":"a","operator":"in","value":[]}]`,
		"not_in with scalar":   `[{"attribute":"a","operator":"not_in","value":1}]`,
		"in with nested array": `[{"attribute":"a","operator":"in","value":[[1]]}]`,
		"in containing null":   `[{"attribute":"a","operator":"in","value":[null]}]`,
	}
	for name, v := range invalid {
		_, err := s.CreateFlag(ctx, decode(t, fmt.Sprintf(`{"key":"bad","rules":%s}`, v)))
		if code(err) != CodeValidation {
			t.Errorf("%s: got %q, want VALIDATION_ERROR", name, code(err))
		}
	}
}

// ------------------------------------------------------------ BR-20 .. BR-23

func TestBR20_EvaluateRequestValidation(t *testing.T) {
	s, _ := newService(t)
	for name, body := range map[string]string{
		"body array":            `[]`,
		"body null":             `null`,
		"flags not an array":    `{"flags":"a"}`,
		"flags contains number": `{"flags":["a",1]}`,
		"flags contains null":   `{"flags":[null]}`,
		"flags null":            `{"flags":null}`,
		"context array":         `{"context":[]}`,
		"context string":        `{"context":"u1"}`,
		"context null":          `{"context":null}`,
		"userId number":         `{"context":{"userId":1}}`,
		"userId null":           `{"context":{"userId":null}}`,
		"attributes array":      `{"context":{"attributes":[]}}`,
		"attribute null":        `{"context":{"attributes":{"a":null}}}`,
		"attribute object":      `{"context":{"attributes":{"a":{}}}}`,
		"attribute array":       `{"context":{"attributes":{"a":[1]}}}`,
	} {
		if _, err := s.Evaluate(ctx, decode(t, body)); code(err) != CodeValidation {
			t.Errorf("%s: got %q, want VALIDATION_ERROR", name, code(err))
		}
	}
	for _, body := range []string{`{}`, `{"flags":[]}`, `{"context":{}}`, `{"context":{"userId":"u","attributes":{"s":"x","n":1,"b":false}}}`} {
		if _, err := s.Evaluate(ctx, decode(t, body)); err != nil {
			t.Errorf("%s rejected: %v", body, err)
		}
	}
}

func TestBR23_FlagsSelectsWhatIsEvaluated(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"a","enabled":true}`)
	create(t, s, `{"key":"b","enabled":false}`)
	keys := func(raw string) []string {
		res, err := s.Evaluate(ctx, decode(t, raw))
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for k := range res {
			out = append(out, k)
		}
		return out
	}
	if got := keys(`{}`); len(got) != 2 {
		t.Errorf("all flags: %v", got)
	}
	if got := keys(`{"flags":[]}`); len(got) != 0 {
		t.Errorf("flags [] must evaluate nothing: %v", got)
	}
	if got := keys(`{"flags":["a","ghost"]}`); len(got) != 2 {
		t.Errorf("a and ghost: %v", got)
	}
	res, _ := s.Evaluate(ctx, decode(t, `{"flags":["a","b","ghost"],"context":{"userId":"u"}}`))
	want := map[string]string{"a": "ON", "b": "DISABLED", "ghost": "FLAG_NOT_FOUND"}
	for k, reason := range want {
		if res[k].Reason != reason {
			t.Errorf("%s: %s, want %s", k, res[k].Reason, reason)
		}
	}
}

func TestBR22_EvaluateWritesNothing(t *testing.T) {
	s, _ := newService(t)
	before := create(t, s, `{"key":"a","enabled":true}`)
	s.Evaluate(ctx, decode(t, `{"context":{"userId":"u"}}`))
	s.Evaluate(ctx, decode(t, `{"flags":["a"]}`))
	after, _ := s.GetFlag(ctx, "a")
	if !reflect.DeepEqual(before, after) {
		t.Fatal("flag changed")
	}
	if _, total, _ := s.ListAudit(ctx, nil, 10, 0); total != 1 {
		t.Fatalf("audit entries = %d", total)
	}
}

// ------------------------------------------------------------ BR-43 .. BR-46

func TestBR43_EventValidation(t *testing.T) {
	s, _ := newService(t)
	hundred := strings.TrimSuffix(strings.Repeat(`{"type":"conversion","userId":"u","goal":"g"},`, 100), ",")
	for name, body := range map[string]string{
		"body not an object":     `[]`,
		"no events":              `{}`,
		"events not an array":    `{"events":{}}`,
		"empty events":           `{"events":[]}`,
		"101 events":             `{"events":[` + hundred + `,{"type":"conversion","userId":"u","goal":"g"}]}`,
		"unknown type":           `{"events":[{"type":"click","userId":"u"}]}`,
		"missing type":           `{"events":[{"userId":"u","goal":"g"}]}`,
		"missing userId":         `{"events":[{"type":"conversion","goal":"g"}]}`,
		"empty userId":           `{"events":[{"type":"conversion","userId":"","goal":"g"}]}`,
		"userId number":          `{"events":[{"type":"conversion","userId":1,"goal":"g"}]}`,
		"exposure no flagKey":    `{"events":[{"type":"exposure","userId":"u","variant":"a"}]}`,
		"exposure no variant":    `{"events":[{"type":"exposure","userId":"u","flagKey":"f"}]}`,
		"exposure empty variant": `{"events":[{"type":"exposure","userId":"u","flagKey":"f","variant":""}]}`,
		"conversion no goal":     `{"events":[{"type":"conversion","userId":"u"}]}`,
		"conversion empty goal":  `{"events":[{"type":"conversion","userId":"u","goal":""}]}`,
		"timestamp number":       `{"events":[{"type":"conversion","userId":"u","goal":"g","timestamp":1700000000}]}`,
		"timestamp yesterday":    `{"events":[{"type":"conversion","userId":"u","goal":"g","timestamp":"yesterday"}]}`,
		"event not an object":    `{"events":["x"]}`,
	} {
		if _, err := s.RecordEvents(ctx, decode(t, body)); code(err) != CodeValidation {
			t.Errorf("%s: got %q, want VALIDATION_ERROR", name, code(err))
		}
	}
	for _, ts := range []string{"2026-01-31T08:00:00Z", "2026-01-31T15:00:00.250+07:00"} {
		body := fmt.Sprintf(`{"events":[{"type":"conversion","userId":"u","goal":"g","timestamp":%q}]}`, ts)
		if _, err := s.RecordEvents(ctx, decode(t, body)); err != nil {
			t.Errorf("timestamp %s rejected: %v", ts, err)
		}
	}
	if n, err := s.RecordEvents(ctx, decode(t, `{"events":[`+hundred+`]}`)); err != nil || n != 100 {
		t.Errorf("100 events: n=%d err=%v", n, err)
	}
}

func TestBR43_TimestampsAreRFC3339AndCorrectOnTheCalendar(t *testing.T) {
	valid := []string{
		"2026-01-31T08:00:00Z", "2026-01-31T15:00:00.250+07:00", "2028-02-29T23:59:59Z", "2026-12-31T23:59:59-05:30",
		"2026-06-30T23:59:59.999999999Z", "2026-01-31T08:00:00.1Z", "2026-01-31T08:00:00+23:59", "0000-01-01T00:00:00Z",
	}
	invalid := []string{
		"", "yesterday", "2026-02-30T00:00:00Z", "2027-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
		"2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-31T24:00:00Z", "2026-01-31T08:60:00Z",
		"2026-01-31T08:00:60Z", "2026-01-31", "2026-01-31T08:00:00", "2026-01-31T08:00:00+0700", "2026-01-31t08:00:00z",
		"2026-01-31 08:00:00Z", " 2026-01-31T08:00:00Z", "2026-01-31T08:00:00Z\n", "2026-01-31T08:00:00.Z",
		// time.Parse accepts every one of these; RFC 3339 does not (found by differential testing against the TypeScript port)
		"2026-01-31T8:00:00Z", "2026-01-31T08:00:00,5Z", "2026-01-31T08:00:00+24:00", "2026-01-31T08:00:00+07:60",
		"2026-01-31T08:00:00-24:00", "٢٠٢٦-٠١-٣١T٠٨:٠٠:٠٠Z",
	}
	for _, ts := range valid {
		if !validTimestamp(ts) {
			t.Errorf("%q rejected", ts)
		}
	}
	for _, ts := range invalid {
		if validTimestamp(ts) {
			t.Errorf("%q accepted", ts)
		}
	}
}

func TestBR44_ABatchWithOneBadEventStoresNothing(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"f","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)
	_, err := s.RecordEvents(ctx, decode(t, `{"events":[
		{"type":"exposure","userId":"u1","flagKey":"f","variant":"control"},
		{"type":"exposure","userId":"u2"}]}`))
	if code(err) != CodeValidation {
		t.Fatalf("got %q", code(err))
	}
	res, _ := s.Results(ctx, "f", "g")
	if res.Variants[0].Exposures != 0 {
		t.Fatal("the valid event of a rejected batch was stored")
	}
}

func TestBR46_ResultsErrorsAndShape(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"plain","enabled":true}`)
	create(t, s, `{"key":"ab","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)

	if _, err := s.Results(ctx, "ab", ""); code(err) != CodeValidation {
		t.Errorf("empty goal: %q", code(err))
	}
	if _, err := s.Results(ctx, "ghost", "g"); code(err) != CodeFlagNotFound {
		t.Errorf("unknown flag: %q", code(err))
	}
	if _, err := s.Results(ctx, "ghost", ""); code(err) != CodeValidation {
		t.Errorf("validation must come before existence: %q", code(err))
	}
	res, err := s.Results(ctx, "plain", "g")
	if err != nil || res.Variants == nil || len(res.Variants) != 0 {
		t.Errorf("flag without variants: %+v err=%v", res, err)
	}
	fresh, _ := s.Results(ctx, "ab", "buy")
	out, _ := json.Marshal(fresh)
	want := `{"flagKey":"ab","goal":"buy","variants":[` +
		`{"variant":"control","exposures":0,"conversions":0,"rate":0,"pValue":null,"significant":false},` +
		`{"variant":"treatment","exposures":0,"conversions":0,"rate":0,"pValue":null,"significant":false}]}`
	if string(out) != want {
		t.Errorf("fresh experiment:\n got %s\nwant %s", out, want)
	}
}

// events builds a RecordEvents body.
func exposures(flag, prefix, variant string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf(`{"type":"exposure","userId":"%s%d","flagKey":%q,"variant":%q}`, prefix, i, flag, variant)
	}
	return out
}

func conversions(goal, prefix string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf(`{"type":"conversion","userId":"%s%d","goal":%q}`, prefix, i, goal)
	}
	return out
}

func record(t *testing.T, s *Service, parts ...[]string) {
	t.Helper()
	var all []string
	for _, p := range parts {
		all = append(all, p...)
	}
	for start := 0; start < len(all); start += 100 {
		end := min(start+100, len(all))
		if _, err := s.RecordEvents(ctx, decode(t, `{"events":[`+strings.Join(all[start:end], ",")+`]}`)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBR40_BR41_CountingRules(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"f","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)
	record(t, s, []string{
		`{"type":"exposure","userId":"u1","flagKey":"f","variant":"control"}`,
		`{"type":"exposure","userId":"u1","flagKey":"f","variant":"control"}`, // duplicate
		`{"type":"exposure","userId":"u2","flagKey":"f","variant":"control"}`,
		`{"type":"exposure","userId":"u2","flagKey":"f","variant":"treatment"}`, // first exposure wins
		`{"type":"exposure","userId":"u3","flagKey":"f","variant":"treatment"}`,
		`{"type":"conversion","userId":"u1","goal":"buy"}`,
		`{"type":"conversion","userId":"u1","goal":"buy"}`,       // repeated
		`{"type":"conversion","userId":"stranger","goal":"buy"}`, // never exposed
		`{"type":"conversion","userId":"u3","goal":"signup"}`,    // other goal
	})
	res, _ := s.Results(ctx, "f", "buy")
	c, tr := res.Variants[0], res.Variants[1]
	if c.Exposures != 2 || c.Conversions != 1 || c.Rate != 0.5 {
		t.Errorf("control: %+v", c)
	}
	if tr.Exposures != 1 || tr.Conversions != 0 || tr.Rate != 0 {
		t.Errorf("treatment: %+v", tr)
	}
	signup, _ := s.Results(ctx, "f", "signup")
	if signup.Variants[1].Conversions != 1 || signup.Variants[0].Conversions != 0 {
		t.Errorf("signup: %+v", signup.Variants)
	}
}

func TestBR42_SmallSamplesReportNoPValue(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"f","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)
	record(t, s, exposures("f", "c", "control", 29), exposures("f", "t", "treatment", 29), conversions("buy", "t", 29))
	for _, row := range mustResults(t, s, "f", "buy").Variants {
		if row.PValue != nil || row.Significant {
			t.Errorf("%s: %+v", row.Variant, row)
		}
	}
}

func TestBR42_TwoProportionZTest(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"f","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)
	record(t, s, exposures("f", "c", "control", 200), exposures("f", "t", "treatment", 200),
		conversions("buy", "c", 20), conversions("buy", "t", 40))
	rows := mustResults(t, s, "f", "buy").Variants
	if rows[0].PValue != nil || rows[0].Significant {
		t.Errorf("control must have no p-value: %+v", rows[0])
	}
	if math.Abs(rows[0].Rate-0.1) > 1e-12 || math.Abs(rows[1].Rate-0.2) > 1e-12 {
		t.Errorf("rates: %v %v", rows[0].Rate, rows[1].Rate)
	}
	// pooled p = 0.15, se = 0.035707, z = 2.80056, p = erfc(z/sqrt2) = 0.0051014 (computed independently)
	if rows[1].PValue == nil || math.Abs(*rows[1].PValue-0.005101399646004991) > 1e-9 || !rows[1].Significant {
		t.Errorf("treatment: %+v (p=%v)", rows[1], rows[1].PValue)
	}
}

func TestBR42_TheTestIsTwoSided(t *testing.T) {
	// The mirror image of the 20/200 vs 40/200 case: the treatment is worse than
	// the control. A two-sided test gives exactly the same p-value.
	s, _ := newService(t)
	create(t, s, `{"key":"f","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)
	record(t, s, exposures("f", "c", "control", 200), exposures("f", "t", "treatment", 200),
		conversions("buy", "c", 40), conversions("buy", "t", 20))
	row := mustResults(t, s, "f", "buy").Variants[1]
	if row.PValue == nil || math.Abs(*row.PValue-0.005101399646004991) > 1e-9 || !row.Significant {
		t.Errorf("treatment worse than control: %+v p=%v", row, row.PValue)
	}
}

func TestBR42_IdenticalRatesAndNoVariationHaveNoSignificance(t *testing.T) {
	s, _ := newService(t)
	create(t, s, `{"key":"same","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)
	record(t, s, exposures("same", "c", "control", 100), exposures("same", "t", "treatment", 100),
		conversions("buy", "c", 30), conversions("buy", "t", 30))
	row := mustResults(t, s, "same", "buy").Variants[1]
	if row.PValue == nil || math.Abs(*row.PValue-1) > 1e-12 || row.Significant {
		t.Errorf("identical rates: %+v p=%v", row, row.PValue)
	}

	create(t, s, `{"key":"none","enabled":true,"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}`)
	record(t, s, exposures("none", "c", "control", 40), exposures("none", "t", "treatment", 40))
	// A conversion is keyed by (goal, user) across flags, so use a goal the first
	// experiment never touched; otherwise its conversions would leak in.
	row = mustResults(t, s, "none", "never-converted").Variants[1]
	if row.PValue != nil || row.Significant {
		t.Errorf("nobody converted (se = 0): %+v", row)
	}
}

func mustResults(t *testing.T, s *Service, key, goal string) *model.Results {
	t.Helper()
	r, err := s.Results(ctx, key, goal)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// -------------------------------------------------------------------- BR-50

func TestBR50_PagingParameters(t *testing.T) {
	ok := map[string][2]int{
		"":                       {20, 0},
		"limit=1":                {1, 0},
		"limit=100":              {100, 0},
		"offset=5":               {20, 5},
		"limit=7&offset=1000000": {7, 1000000},
	}
	for q, want := range ok {
		v, _ := url.ParseQuery(q)
		limit, offset, err := ParsePage(v)
		if err != nil || limit != want[0] || offset != want[1] {
			t.Errorf("%q: limit=%d offset=%d err=%v, want %v", q, limit, offset, err, want)
		}
	}
	for _, q := range []string{"limit=0", "limit=101", "limit=-1", "limit=abc", "limit=1.5", "limit=", "offset=-1", "offset=abc", "offset=99999999999999999999"} {
		v, _ := url.ParseQuery(q)
		if _, _, err := ParsePage(v); code(err) != CodeValidation {
			t.Errorf("%q: got %q, want VALIDATION_ERROR", q, code(err))
		}
	}
}

func TestListFlagsPagesInKeyOrderWithTotal(t *testing.T) {
	s, _ := newService(t)
	for _, k := range []string{"c", "a", "b"} {
		create(t, s, fmt.Sprintf(`{"key":%q}`, k))
	}
	page, total, _ := s.ListFlags(ctx, 2, 1)
	if total != 3 || len(page) != 2 || page[0].Key != "b" || page[1].Key != "c" {
		t.Fatalf("page: %+v total=%d", page, total)
	}
}
