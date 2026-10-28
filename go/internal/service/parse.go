package service

import (
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"

	"ffservice/internal/model"
)

// The parsers below take the result of decoding JSON into `any` with
// json.Decoder.UseNumber, so numbers arrive as json.Number. That keeps 10,
// 10.0 and 10.5 distinguishable, which decoding straight into an int field
// would not (BR-30).

// Go's `$` (without the multi-line flag) matches only at the very end of the
// text, so a key with a trailing newline does not match.
var (
	keyRE        = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	variantKeyRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
	digitsRE     = regexp.MustCompile(`^[0-9]+$`)
)

const (
	maxDescriptionCodePoints = 500
	minVariants, maxVariants = 2, 10
	maxEvents                = 100
)

// asInt accepts a JSON number that has no fractional part (10 or 10.0) and
// fits comfortably in an int.
func asInt(v any) (int, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	if i, err := n.Int64(); err == nil {
		if i < -1_000_000_000 || i > 1_000_000_000 {
			return 0, false
		}
		return int(i), true
	}
	f, err := n.Float64()
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) || f != math.Trunc(f) || math.Abs(f) > 1_000_000_000 {
		return 0, false
	}
	return int(f), true
}

// asScalar converts a decoded JSON value to string, float64 or bool. null,
// arrays and objects are not scalars.
func asScalar(v any) (any, bool) {
	switch x := v.(type) {
	case string, bool:
		return x, true
	case json.Number:
		f, err := x.Float64()
		if err != nil || math.IsInf(f, 0) {
			return nil, false
		}
		return f, true
	}
	return nil, false
}

func nonEmptyString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && s != ""
}

// ParseFlagInput validates a create/replace body (BR-01, BR-04, BR-08,
// BR-30..35) and returns the flag with defaults applied. Timestamps are left
// zero for the caller to set.
func ParseFlagInput(raw any) (model.Flag, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return model.Flag{}, validationError("body must be a JSON object")
	}
	key, ok := m["key"].(string)
	if !ok {
		return model.Flag{}, validationError("key is required and must be a string")
	}
	if !keyRE.MatchString(key) {
		return model.Flag{}, newError(CodeInvalidKey, "key must match %s", keyRE)
	}
	f := model.Flag{
		Key:            key,
		RolloutPercent: 100,
		Rules:          []model.Rule{},
		Variants:       []model.Variant{},
	}

	if v, present := m["description"]; present {
		s, ok := v.(string)
		if !ok {
			return f, validationError("description must be a string")
		}
		// Unicode code points, not bytes and not UTF-16 units (BR-04).
		if utf8.RuneCountInString(s) > maxDescriptionCodePoints {
			return f, validationError("description must be at most %d characters", maxDescriptionCodePoints)
		}
		f.Description = s
	}
	if v, present := m["enabled"]; present {
		b, ok := v.(bool)
		if !ok {
			return f, validationError("enabled must be a boolean")
		}
		f.Enabled = b
	}
	if v, present := m["rolloutPercent"]; present {
		n, ok := asInt(v)
		if !ok || n < 0 || n > 100 {
			return f, validationError("rolloutPercent must be an integer from 0 to 100")
		}
		f.RolloutPercent = n
	}
	if v, present := m["rules"]; present {
		rules, err := parseRules(v)
		if err != nil {
			return f, err
		}
		f.Rules = rules
	}
	if v, present := m["variants"]; present {
		variants, err := parseVariants(v)
		if err != nil {
			return f, err
		}
		f.Variants = variants
	}
	return f, nil
}

func parseRules(v any) ([]model.Rule, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, validationError("rules must be an array")
	}
	rules := make([]model.Rule, 0, len(list))
	for i, item := range list {
		rm, ok := item.(map[string]any)
		if !ok {
			return nil, validationError("rules[%d] must be an object", i)
		}
		attribute, ok := nonEmptyString(rm["attribute"])
		if !ok {
			return nil, validationError("rules[%d].attribute must be a non-empty string", i)
		}
		operator, _ := rm["operator"].(string)
		switch operator {
		case "eq", "neq", "in", "not_in":
		default:
			return nil, validationError("rules[%d].operator must be one of eq, neq, in, not_in", i)
		}
		value, err := parseRuleValue(operator, rm["value"])
		if err != nil {
			return nil, validationError("rules[%d].value: %s", i, err)
		}
		rules = append(rules, model.Rule{Attribute: attribute, Operator: operator, Value: value})
	}
	return rules, nil
}

func parseRuleValue(operator string, v any) (any, error) {
	if operator == "in" || operator == "not_in" {
		list, ok := v.([]any)
		if !ok || len(list) == 0 {
			return nil, errors.New("must be a non-empty array of scalars")
		}
		out := make([]any, len(list))
		for i, item := range list {
			s, ok := asScalar(item)
			if !ok {
				return nil, errors.New("must be a non-empty array of scalars")
			}
			out[i] = s
		}
		return out, nil
	}
	s, ok := asScalar(v)
	if !ok {
		return nil, errors.New("must be a string, number or boolean")
	}
	return s, nil
}

func parseVariants(v any) ([]model.Variant, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, validationError("variants must be an array")
	}
	if len(list) == 0 {
		return []model.Variant{}, nil
	}
	if len(list) < minVariants || len(list) > maxVariants {
		return nil, variantsError("a flag with variants needs %d to %d of them", minVariants, maxVariants)
	}
	variants := make([]model.Variant, 0, len(list)) // keep the order the client sent
	seen := map[string]bool{}
	sum := 0
	for i, item := range list {
		vm, ok := item.(map[string]any)
		if !ok {
			return nil, variantsError("variants[%d] must be an object", i)
		}
		key, ok := vm["key"].(string)
		if !ok || !variantKeyRE.MatchString(key) {
			return nil, variantsError("variants[%d].key must match %s", i, variantKeyRE)
		}
		if seen[key] {
			return nil, variantsError("variant key %q is used twice", key)
		}
		seen[key] = true
		weight, ok := asInt(vm["weight"])
		if !ok || weight < 1 || weight > 100 {
			return nil, variantsError("variants[%d].weight must be an integer from 1 to 100", i)
		}
		sum += weight
		variants = append(variants, model.Variant{Key: key, Weight: weight})
	}
	if sum != 100 {
		return nil, variantsError("weights must add up to 100, got %d", sum)
	}
	return variants, nil
}

// EvaluateRequest is a validated POST /v1/evaluate body.
type EvaluateRequest struct {
	// Flags lists the keys to evaluate. It is only meaningful when HasFlags is
	// true; otherwise every flag is evaluated (BR-23).
	Flags    []string
	HasFlags bool
	Context  model.Context
}

// ParseEvaluateRequest validates an evaluate body (BR-20).
func ParseEvaluateRequest(raw any) (EvaluateRequest, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return EvaluateRequest{}, validationError("body must be a JSON object")
	}
	var req EvaluateRequest
	req.Flags = []string{}
	if v, present := m["flags"]; present {
		list, ok := v.([]any)
		if !ok {
			return req, validationError("flags must be an array of strings")
		}
		for _, item := range list {
			s, ok := item.(string)
			if !ok {
				return req, validationError("flags must be an array of strings")
			}
			req.Flags = append(req.Flags, s)
		}
		req.HasFlags = true
	}
	if v, present := m["context"]; present {
		cm, ok := v.(map[string]any)
		if !ok {
			return req, validationError("context must be an object")
		}
		if u, present := cm["userId"]; present {
			s, ok := u.(string)
			if !ok {
				return req, validationError("context.userId must be a string")
			}
			req.Context.UserID = s
		}
		if a, present := cm["attributes"]; present {
			am, ok := a.(map[string]any)
			if !ok {
				return req, validationError("context.attributes must be an object")
			}
			req.Context.Attributes = make(map[string]any, len(am))
			for name, value := range am {
				s, ok := asScalar(value)
				if !ok {
					return req, validationError("context.attributes.%s must be a string, number or boolean", name)
				}
				req.Context.Attributes[name] = s
			}
		}
	}
	return req, nil
}

// ParseEvents validates a POST /v1/events body (BR-43). Nothing is returned
// unless every event is valid.
func ParseEvents(raw any) ([]model.Event, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, validationError("body must be a JSON object")
	}
	list, ok := m["events"].([]any)
	if !ok || len(list) < 1 || len(list) > maxEvents {
		return nil, validationError("events must be an array of 1 to %d events", maxEvents)
	}
	events := make([]model.Event, 0, len(list))
	for i, item := range list {
		em, ok := item.(map[string]any)
		if !ok {
			return nil, validationError("events[%d] must be an object", i)
		}
		var e model.Event
		e.Type, _ = em["type"].(string)
		if e.Type != model.EventExposure && e.Type != model.EventConversion {
			return nil, validationError("events[%d].type must be exposure or conversion", i)
		}
		if e.UserID, ok = nonEmptyString(em["userId"]); !ok {
			return nil, validationError("events[%d].userId must be a non-empty string", i)
		}
		if e.Type == model.EventExposure {
			if e.FlagKey, ok = nonEmptyString(em["flagKey"]); !ok {
				return nil, validationError("events[%d].flagKey is required for an exposure", i)
			}
			if e.Variant, ok = nonEmptyString(em["variant"]); !ok {
				return nil, validationError("events[%d].variant is required for an exposure", i)
			}
		} else if e.Goal, ok = nonEmptyString(em["goal"]); !ok {
			return nil, validationError("events[%d].goal is required for a conversion", i)
		}
		if ts, present := em["timestamp"]; present {
			s, ok := ts.(string)
			if !ok {
				return nil, validationError("events[%d].timestamp must be an RFC 3339 string", i)
			}
			if _, err := time.Parse(time.RFC3339, s); err != nil {
				return nil, validationError("events[%d].timestamp must be an RFC 3339 string", i)
			}
		}
		events = append(events, e)
	}
	return events, nil
}

// ParsePage reads limit and offset from a query string (BR-50).
func ParsePage(q url.Values) (limit, offset int, err error) {
	number := func(name string, def, min, max int) (int, error) {
		values, present := q[name]
		if !present {
			return def, nil
		}
		if !digitsRE.MatchString(values[0]) {
			return 0, validationError("%s must be an integer", name)
		}
		n, convErr := strconv.Atoi(values[0])
		if convErr != nil || n < min || n > max {
			return 0, validationError("%s must be between %d and %d", name, min, max)
		}
		return n, nil
	}
	if limit, err = number("limit", 20, 1, 100); err != nil {
		return 0, 0, err
	}
	if offset, err = number("offset", 0, 0, math.MaxInt32); err != nil {
		return 0, 0, err
	}
	return limit, offset, nil
}
