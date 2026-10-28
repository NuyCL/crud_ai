package evaluation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"ffservice/internal/model"
)

// The vectors live at the repository root and are shared by every language.
var vectorsDir = filepath.Join("..", "..", "..", "tests", "vectors")

func load(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatalf("cannot read vectors: %v", err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("cannot parse %s: %v", name, err)
	}
}

func TestFNV1a32Vectors(t *testing.T) {
	var file struct {
		Cases []struct {
			Input string `json:"input"`
			Hash  uint32 `json:"hash"`
		} `json:"cases"`
	}
	load(t, "fnv1a32.json", &file)
	if len(file.Cases) == 0 {
		t.Fatal("no cases loaded")
	}
	for _, c := range file.Cases {
		if got := FNV1a32(c.Input); got != c.Hash {
			t.Errorf("FNV1a32(%q) = %d, want %d", c.Input, got, c.Hash)
		}
	}
}

func TestBucketingVectors(t *testing.T) {
	var file struct {
		Cases []struct {
			FlagKey string `json:"flagKey"`
			Salt    string `json:"salt"`
			UserID  string `json:"userId"`
			Input   string `json:"input"`
			Hash    uint32 `json:"hash"`
			Bucket  int    `json:"bucket"`
		} `json:"cases"`
	}
	load(t, "bucketing.json", &file)
	if len(file.Cases) == 0 {
		t.Fatal("no cases loaded")
	}
	for _, c := range file.Cases {
		if got := FNV1a32(c.Input); got != c.Hash {
			t.Errorf("hash of %q = %d, want %d", c.Input, got, c.Hash)
		}
		if got := Bucket(c.FlagKey, c.Salt, c.UserID); got != c.Bucket {
			t.Errorf("Bucket(%q, %q, %q) = %d, want %d", c.FlagKey, c.Salt, c.UserID, got, c.Bucket)
		}
	}
}

func TestEvaluationVectors(t *testing.T) {
	var file struct {
		Cases []struct {
			ID       string                 `json:"id"`
			Flag     *model.Flag            `json:"flag"`
			Context  model.Context          `json:"context"`
			Expected model.EvaluationResult `json:"expected"`
		} `json:"cases"`
	}
	load(t, "evaluation.json", &file)
	if len(file.Cases) == 0 {
		t.Fatal("no cases loaded")
	}
	for _, c := range file.Cases {
		t.Run(c.ID, func(t *testing.T) {
			got := Evaluate(c.Flag, c.Context)
			same := got.Enabled == c.Expected.Enabled && got.Reason == c.Expected.Reason &&
				(got.Variant == nil) == (c.Expected.Variant == nil) &&
				(got.Variant == nil || *got.Variant == *c.Expected.Variant)
			if !same {
				t.Errorf("got %s, want %s", Describe(got), Describe(c.Expected))
			}
		})
	}
}

// A few properties that the vectors only sample.
func TestEvaluateIsDeterministic(t *testing.T) {
	flag := &model.Flag{
		Key: "f", Enabled: true, RolloutPercent: 50,
		Variants: []model.Variant{{Key: "a", Weight: 50}, {Key: "b", Weight: 50}},
	}
	ctx := model.Context{UserID: "user-1"}
	first := Evaluate(flag, ctx)
	for i := 0; i < 100; i++ {
		if got := Evaluate(flag, ctx); Describe(got) != Describe(first) {
			t.Fatalf("run %d: %s != %s", i, Describe(got), Describe(first))
		}
	}
}

func TestEvaluateDoesNotMutateItsInput(t *testing.T) {
	flag := &model.Flag{
		Key: "f", Enabled: true, RolloutPercent: 100,
		Rules:    []model.Rule{{Attribute: "country", Operator: "in", Value: []any{"TH", "SG"}}},
		Variants: []model.Variant{{Key: "a", Weight: 60}, {Key: "b", Weight: 40}},
	}
	before, _ := json.Marshal(flag)
	Evaluate(flag, model.Context{UserID: "u", Attributes: map[string]any{"country": "TH"}})
	after, _ := json.Marshal(flag)
	if string(before) != string(after) {
		t.Fatalf("flag changed: %s -> %s", before, after)
	}
}
