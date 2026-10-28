// Package service implements the business rules (BR-xx in
// spec/business-rules.md) on top of the repository. It knows nothing about
// HTTP: failures are reported as *Error values carrying a machine-readable
// code, and the handler maps codes to status codes.
package service

import "fmt"

// Error codes, identical to the enum in spec/openapi.yaml.
const (
	CodeUnauthorized    = "UNAUTHORIZED"
	CodeForbidden       = "FORBIDDEN"
	CodeFlagNotFound    = "FLAG_NOT_FOUND"
	CodeFlagExists      = "FLAG_EXISTS"
	CodeInvalidKey      = "INVALID_KEY"
	CodeKeyImmutable    = "KEY_IMMUTABLE"
	CodeInvalidVariants = "INVALID_VARIANTS"
	CodeValidation      = "VALIDATION_ERROR"
)

// Error is a failure the client caused and can act on.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newError(code, format string, args ...any) error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func validationError(format string, args ...any) error {
	return newError(CodeValidation, format, args...)
}

func variantsError(format string, args ...any) error {
	return newError(CodeInvalidVariants, format, args...)
}
