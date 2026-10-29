// Package model holds the data types shared by every layer. The JSON shape
// follows spec/openapi.yaml.
package model

import (
	"encoding/json"
	"time"
)

// Rule is one targeting condition. Value is a scalar for eq/neq and a
// non-empty []any of scalars for in/not_in. Scalars are string, float64 or
// bool; numbers are always float64 so that equality never depends on how the
// number was written in JSON.
type Rule struct {
	Attribute string `json:"attribute"`
	Operator  string `json:"operator"`
	Value     any    `json:"value"`
}

// Variant is one arm of an experiment. Weights of a flag's variants sum to 100.
type Variant struct {
	Key    string `json:"key"`
	Weight int    `json:"weight"`
}

// Flag is a feature flag definition. Rules and Variants are never nil once a
// flag has passed through the service, so they serialise as [] and not null.
type Flag struct {
	Key            string    `json:"key"`
	Description    string    `json:"description"`
	Enabled        bool      `json:"enabled"`
	Rules          []Rule    `json:"rules"`
	RolloutPercent int       `json:"rolloutPercent"`
	Variants       []Variant `json:"variants"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// Context is what a flag is evaluated for. UserID is not an attribute: rules
// cannot target it.
type Context struct {
	UserID     string         `json:"userId,omitempty"`
	Attributes map[string]any `json:"attributes,omitempty"`
}

// Reasons reported in an EvaluationResult.
const (
	ReasonFlagNotFound  = "FLAG_NOT_FOUND"
	ReasonDisabled      = "DISABLED"
	ReasonTargetingMiss = "TARGETING_MISS"
	ReasonMissingUserID = "MISSING_USER_ID"
	ReasonNotInRollout  = "NOT_IN_ROLLOUT"
	ReasonOn            = "ON"
	ReasonVariant       = "VARIANT"
)

// EvaluationResult is the outcome of evaluating one flag. Variant is nil (JSON
// null) unless Reason is VARIANT.
type EvaluationResult struct {
	Enabled bool    `json:"enabled"`
	Variant *string `json:"variant"`
	Reason  string  `json:"reason"`
}

// Audit actions.
const (
	ActionCreate = "create"
	ActionUpdate = "update"
	ActionDelete = "delete"
)

// AuditLog records one successful change to a flag. Before and After hold the
// whole flag as JSON, or nil (serialised as null) when there was none.
type AuditLog struct {
	ID        int64           `json:"id"`
	FlagKey   string          `json:"flagKey"`
	Action    string          `json:"action"`
	Before    json.RawMessage `json:"before"`
	After     json.RawMessage `json:"after"`
	CreatedAt time.Time       `json:"createdAt"`
}

// Event types.
const (
	EventExposure   = "exposure"
	EventConversion = "conversion"
)

// Event is a validated exposure or conversion. Exposures use FlagKey and
// Variant; conversions use Goal.
type Event struct {
	Type    string
	UserID  string
	FlagKey string
	Variant string
	Goal    string
}

// VariantResult is one row of an experiment report.
type VariantResult struct {
	Variant     string   `json:"variant"`
	Exposures   int      `json:"exposures"`
	Conversions int      `json:"conversions"`
	Rate        float64  `json:"rate"`
	PValue      *float64 `json:"pValue"`
	Significant bool     `json:"significant"`
}

// Results is the experiment report of one flag for one goal.
type Results struct {
	FlagKey  string          `json:"flagKey"`
	Goal     string          `json:"goal"`
	Variants []VariantResult `json:"variants"`
}
