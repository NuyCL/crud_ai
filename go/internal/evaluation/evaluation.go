// Package evaluation decides what a flag means for a user. It is a pure
// function of its arguments: no I/O, no clock, no randomness. The rules are
// defined in spec/evaluation.md and checked against tests/vectors.
package evaluation

import (
	"strconv"

	"ffservice/internal/model"
)

const buckets = 10000

// FNV1a32 is the 32-bit FNV-1a hash of the UTF-8 bytes of s.
//
// It walks the string byte by byte. Ranging over a Go string would yield
// runes, which gives a different hash for every non-ASCII input.
func FNV1a32(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619 // uint32 arithmetic wraps at 2^32, as the spec requires
	}
	return h
}

// Bucket maps (flagKey, salt, userID) to 0..9999.
func Bucket(flagKey, salt, userID string) int {
	return int(FNV1a32(flagKey+":"+salt+":"+userID) % buckets)
}

// Evaluate returns the result of evaluating flag for ctx. A nil flag means the
// flag does not exist.
func Evaluate(flag *model.Flag, ctx model.Context) model.EvaluationResult {
	if flag == nil {
		return off(model.ReasonFlagNotFound)
	}
	if !flag.Enabled {
		return off(model.ReasonDisabled)
	}
	for _, rule := range flag.Rules {
		if !ruleMatches(rule, ctx.Attributes) {
			return off(model.ReasonTargetingMiss)
		}
	}

	needsBucket := flag.RolloutPercent < 100 || len(flag.Variants) > 0
	if needsBucket && ctx.UserID == "" {
		return off(model.ReasonMissingUserID)
	}
	if flag.RolloutPercent < 100 && Bucket(flag.Key, "rollout", ctx.UserID) >= flag.RolloutPercent*100 {
		return off(model.ReasonNotInRollout)
	}
	if len(flag.Variants) == 0 {
		return model.EvaluationResult{Enabled: true, Reason: model.ReasonOn}
	}

	b := Bucket(flag.Key, "variant", ctx.UserID)
	threshold := 0
	for _, v := range flag.Variants {
		threshold += v.Weight * 100
		if b < threshold {
			key := v.Key
			return model.EvaluationResult{Enabled: true, Variant: &key, Reason: model.ReasonVariant}
		}
	}
	// Unreachable while weights sum to 100, which the service guarantees.
	return off(model.ReasonDisabled)
}

func off(reason string) model.EvaluationResult {
	return model.EvaluationResult{Reason: reason}
}

// ruleMatches reports whether rule holds for attrs. An attribute that is
// missing makes every operator fail, including neq and not_in.
func ruleMatches(rule model.Rule, attrs map[string]any) bool {
	got, ok := attrs[rule.Attribute]
	if !ok {
		return false
	}
	switch rule.Operator {
	case "eq":
		return scalarEqual(got, rule.Value)
	case "neq":
		return !scalarEqual(got, rule.Value)
	case "in":
		return contains(rule.Value, got)
	case "not_in":
		return !contains(rule.Value, got)
	}
	return false
}

func contains(list any, got any) bool {
	items, ok := list.([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if scalarEqual(got, item) {
			return true
		}
	}
	return false
}

// scalarEqual compares two scalars without any type conversion: "1" is not 1
// and true is not "true".
func scalarEqual(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	}
	return false
}

// Describe is used in test failure messages.
func Describe(r model.EvaluationResult) string {
	v := "null"
	if r.Variant != nil {
		v = strconv.Quote(*r.Variant)
	}
	return "{enabled:" + strconv.FormatBool(r.Enabled) + " variant:" + v + " reason:" + r.Reason + "}"
}
